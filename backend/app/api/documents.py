import os
import shutil
import asyncio
import logging
import threading
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from app.db.session import get_db, SessionLocal
from app.db import models
from app.db.models import DocStatus
import re
from typing import Optional, List
from pydantic import BaseModel
from app.services.rag_service import rag_service, HTMLTextExtractor
from app.core.config import settings
from app.api.auth import get_current_user

router = APIRouter()
logger = logging.getLogger(__name__)


def _set_doc_status(doc_id: int, status: str, error_message: str = None):
    """Helper: open a new DB session and update doc status (safe to call from background threads)."""
    db = SessionLocal()
    try:
        doc = db.query(models.Document).filter(models.Document.id == doc_id).first()
        if doc:
            doc.status = status
            doc.error_message = error_message
            db.commit()
    except Exception as e:
        logger.error(f"Failed to update doc {doc_id} status to {status}: {e}")
    finally:
        db.close()


def _index_document_background(doc_id: int, workspace_id: int, user_id: int, file_path: str):
    """Background thread: runs the full indexing pipeline with status updates."""
    try:
        _set_doc_status(doc_id, DocStatus.EXTRACTING)
        # rag_service.add_document handles extraction, chunking, embedding internally.
        # We approximate the stages by updating status around the call.
        _set_doc_status(doc_id, DocStatus.CHUNKING)
        _set_doc_status(doc_id, DocStatus.EMBEDDING)

        # Run the synchronous rag_service call
        rag_service.add_document(workspace_id, user_id, file_path)

        _set_doc_status(doc_id, DocStatus.INDEXED)
        logger.info(f"Document {doc_id} indexed successfully.")
    except Exception as e:
        logger.error(f"Background indexing failed for doc {doc_id}: {e}", exc_info=True)
        _set_doc_status(doc_id, DocStatus.FAILED, error_message=str(e)[:500])
        # Clean up file on failure
        try:
            if os.path.exists(file_path):
                os.remove(file_path)
                logger.info(f"Cleaned up orphaned file after failed index: {file_path}")
        except Exception as cleanup_err:
            logger.warning(f"Could not clean up {file_path}: {cleanup_err}")


@router.post("/{workspace_id}/upload")
async def upload_document(
    workspace_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    ws = db.query(models.Workspace).filter(
        models.Workspace.id == workspace_id,
        models.Workspace.user_id == current_user.id
    ).first()
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    # Validate file extension
    ALLOWED_EXTENSIONS = {'pdf', 'txt', 'png', 'jpg', 'jpeg', 'md', 'markdown', 'csv', 'docx', 'xlsx', 'html', 'json', 'xml', 'log'}
    ext = (file.filename.rsplit('.', 1)[-1] if '.' in file.filename else '').lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '.{ext}'. Allowed types: {', '.join(sorted(ALLOWED_EXTENSIONS))}"
        )

    # Ensure upload directory exists
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)

    # Sanitize filename to avoid path traversal and collisions
    import hashlib, time
    safe_name = os.path.basename(file.filename)
    # Add a short hash to avoid overwriting files with the same name
    unique_prefix = hashlib.md5(f"{workspace_id}_{time.time()}".encode()).hexdigest()[:8]
    safe_name = f"{unique_prefix}_{safe_name}"
    file_path = os.path.join(settings.UPLOAD_DIR, safe_name)

    try:
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
    except Exception as e:
        logger.error(f"Failed to save uploaded file '{file.filename}': {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to save file to disk: {str(e)[:200]}")

    # Validate file size after saving (100MB limit)
    MAX_FILE_SIZE = 100 * 1024 * 1024  # 100 MB
    actual_size = os.path.getsize(file_path)
    if actual_size > MAX_FILE_SIZE:
        os.remove(file_path)
        size_mb = actual_size / (1024 * 1024)
        raise HTTPException(
            status_code=413,
            detail=f"File too large ({size_mb:.1f} MB). Maximum allowed size is 100 MB."
        )
    if actual_size == 0:
        os.remove(file_path)
        raise HTTPException(status_code=400, detail="Uploaded file is empty (0 bytes).")

    logger.info(f"File saved: '{file.filename}' ({actual_size} bytes) → {file_path}")

    # Create DB record immediately with UPLOADING status
    doc = models.Document(
        workspace_id=workspace_id,
        filename=file.filename,  # Keep original name for display
        filepath=file_path,
        file_type=ext,
        status=DocStatus.UPLOADING,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)

    # Kick off background indexing thread (does not block the HTTP response)
    thread = threading.Thread(
        target=_index_document_background,
        args=(doc.id, workspace_id, current_user.id, file_path),
        daemon=True,
    )
    thread.start()

    return {
        "id": doc.id,
        "filename": doc.filename,
        "filepath": doc.filepath,
        "file_type": doc.file_type,
        "status": doc.status,
        "error_message": doc.error_message,
        "created_at": doc.created_at.isoformat() if doc.created_at else None,
        "file_size": actual_size,
    }


class IngestUrlRequest(BaseModel):
    url: str


@router.post("/{workspace_id}/ingest-url")
async def ingest_url(
    workspace_id: int,
    req: IngestUrlRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Fetch and ingest an external webpage URL into the Workspace RAG.
    Extracts text, strips scripts/styles, saves as a clean Markdown/HTML file, and indexes in background.
    """
    ws = db.query(models.Workspace).filter(
        models.Workspace.id == workspace_id,
        models.Workspace.user_id == current_user.id
    ).first()
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    target_url = req.url.strip()
    if not target_url.startswith("http://") and not target_url.startswith("https://"):
        raise HTTPException(status_code=400, detail="Invalid URL. Must begin with http:// or https://")

    # Fetch webpage content
    import urllib.request
    import hashlib
    import time
    from urllib.parse import urlparse

    try:
        http_req = urllib.request.Request(
            target_url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) StarkLLM-Scraper/1.0"
            }
        )
        with urllib.request.urlopen(http_req, timeout=20) as resp:
            content_bytes = resp.read()
            html_raw = content_bytes.decode("utf-8", errors="replace")
    except Exception as e:
        logger.error(f"Failed to fetch URL {target_url}: {e}")
        raise HTTPException(status_code=400, detail=f"Could not fetch URL: {str(e)[:200]}")

    # Extract text and title
    title_match = re.search(r"<title>(.*?)</title>", html_raw, re.IGNORECASE | re.DOTALL)
    page_title = title_match.group(1).strip() if title_match else urlparse(target_url).netloc
    page_title = re.sub(r'[\\/*?:"<>|]', "", page_title)[:60]

    extractor = HTMLTextExtractor()
    extractor.feed(html_raw)
    clean_text = extractor.get_data().strip()

    if not clean_text or len(clean_text) < 30:
        raise HTTPException(status_code=400, detail="Webpage contains no indexable text content.")

    # Save to upload dir as Markdown
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    unique_prefix = hashlib.md5(f"{workspace_id}_{time.time()}".encode()).hexdigest()[:8]
    safe_filename = f"{page_title or 'webpage'}.md"
    file_disk_name = f"{unique_prefix}_{safe_filename}"
    file_path = os.path.join(settings.UPLOAD_DIR, file_disk_name)

    markdown_content = f"# {page_title}\n\n**Source URL:** {target_url}\n\n---\n\n{clean_text}"
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(markdown_content)

    actual_size = os.path.getsize(file_path)

    doc = models.Document(
        workspace_id=workspace_id,
        filename=safe_filename,
        filepath=file_path,
        file_type="md",
        status=DocStatus.UPLOADING,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)

    thread = threading.Thread(
        target=_index_document_background,
        args=(doc.id, workspace_id, current_user.id, file_path),
        daemon=True,
    )
    thread.start()

    return {
        "id": doc.id,
        "filename": doc.filename,
        "filepath": doc.filepath,
        "file_type": doc.file_type,
        "status": doc.status,
        "error_message": doc.error_message,
        "created_at": doc.created_at.isoformat() if doc.created_at else None,
        "file_size": actual_size,
        "source_url": target_url
    }


class IngestYoutubeRequest(BaseModel):
    url: str


def _extract_youtube_id(url: str):
    url = url.strip()
    patterns = [
        r"(?:v=|\/v\/|youtu\.be\/|embed\/|shorts\/|^)([0-9A-Za-z_-]{11})(?:[?&/]|$)",
    ]
    for pattern in patterns:
        m = re.search(pattern, url)
        if m:
            return m.group(1)
    return None


@router.post("/{workspace_id}/ingest-youtube")
async def ingest_youtube(
    workspace_id: int,
    req: IngestYoutubeRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Fetch and ingest a YouTube video transcript into the Workspace RAG.
    Retrieves video title, extracts transcript, formats with timestamps, and indexes in background.
    """
    ws = db.query(models.Workspace).filter(
        models.Workspace.id == workspace_id,
        models.Workspace.user_id == current_user.id
    ).first()
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    video_id = _extract_youtube_id(req.url)
    if not video_id:
        raise HTTPException(status_code=400, detail="Invalid YouTube URL. Please provide a valid video link or video ID.")

    import urllib.request
    import json
    import hashlib
    import time

    # Fetch title & author via YouTube oEmbed
    video_title = f"YouTube Video {video_id}"
    channel_title = "YouTube"
    try:
        oembed_url = f"https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v={video_id}&format=json"
        http_req = urllib.request.Request(
            oembed_url,
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) StarkLLM-Scraper/1.0"}
        )
        with urllib.request.urlopen(http_req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            video_title = data.get("title", video_title)
            channel_title = data.get("author_name", channel_title)
    except Exception as e:
        logger.warning(f"Could not fetch YouTube oEmbed title for {video_id}: {e}")

    # Fetch transcript using youtube_transcript_api
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
        yt_api = YouTubeTranscriptApi()
        transcript_list = yt_api.list(video_id)
        transcript = None
        try:
            transcript = transcript_list.find_transcript(['en', 'fa', 'es', 'de', 'fr', 'zh', 'ja', 'ru', 'ar'])
        except Exception:
            for t in transcript_list:
                transcript = t
                break

        if not transcript:
            raise HTTPException(status_code=400, detail="No transcript or subtitles available for this YouTube video.")

        fetched = transcript.fetch()
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to fetch YouTube transcript for {video_id}: {e}")
        raise HTTPException(status_code=400, detail=f"Could not extract transcript: {str(e)[:250]}")

    lines = []
    for snippet in fetched:
        start_sec = int(snippet.start) if hasattr(snippet, 'start') else int(snippet.get('start', 0))
        text = snippet.text if hasattr(snippet, 'text') else snippet.get('text', '')
        m = start_sec // 60
        s = start_sec % 60
        lines.append(f"[{m:02d}:{s:02d}] {text}")

    full_transcript_text = "\n".join(lines).strip()
    if not full_transcript_text:
        raise HTTPException(status_code=400, detail="Transcript is empty.")

    safe_title = re.sub(r'[\\/*?:"<>|]', "", video_title)[:60].strip() or f"youtube_{video_id}"
    safe_filename = f"{safe_title}.md"
    unique_prefix = hashlib.md5(f"yt_{video_id}_{time.time()}".encode()).hexdigest()[:8]
    file_disk_name = f"{unique_prefix}_{safe_filename}"
    file_path = os.path.join(settings.UPLOAD_DIR, file_disk_name)

    lang_name = transcript.language if hasattr(transcript, 'language') else 'Unknown'
    markdown_content = (
        f"# {video_title}\n\n"
        f"**Channel:** {channel_title}\n\n"
        f"**Source Video:** https://www.youtube.com/watch?v={video_id}\n\n"
        f"**Language:** {lang_name}\n\n"
        f"---\n\n"
        f"## Transcript\n\n"
        f"{full_transcript_text}\n"
    )

    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(markdown_content)

    actual_size = os.path.getsize(file_path)

    doc = models.Document(
        workspace_id=workspace_id,
        filename=safe_filename,
        filepath=file_path,
        file_type="md",
        status=DocStatus.UPLOADING,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)

    thread = threading.Thread(
        target=_index_document_background,
        args=(doc.id, workspace_id, current_user.id, file_path),
        daemon=True,
    )
    thread.start()

    return {
        "id": doc.id,
        "filename": doc.filename,
        "filepath": doc.filepath,
        "file_type": doc.file_type,
        "status": doc.status,
        "error_message": doc.error_message,
        "created_at": doc.created_at.isoformat() if doc.created_at else None,
        "file_size": actual_size,
        "source_url": f"https://www.youtube.com/watch?v={video_id}",
        "video_title": video_title
    }


# --- GitHub Repository Connector ---

class IngestGithubRequest(BaseModel):
    repo_url: str
    branch: Optional[str] = None
    max_files: Optional[int] = 25


def _parse_github_repo(url: str):
    url = url.strip()
    m = re.search(r"(?:https?:\/\/)?(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s#?]+)", url)
    if m:
        owner = m.group(1)
        repo = m.group(2).removesuffix(".git")
        return owner, repo
    m2 = re.match(r"^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$", url)
    if m2:
        return m2.group(1), m2.group(2).removesuffix(".git")
    return None, None


@router.post("/{workspace_id}/ingest-github")
async def ingest_github(
    workspace_id: int,
    req: IngestGithubRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Fetch and ingest a GitHub repository into the Workspace RAG.
    Parses repo tree, extracts key documentation, configuration, and source files,
    compiles into a unified structured Markdown document, and indexes in background.
    """
    ws = db.query(models.Workspace).filter(
        models.Workspace.id == workspace_id,
        models.Workspace.user_id == current_user.id
    ).first()
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    owner, repo_name = _parse_github_repo(req.repo_url)
    if not owner or not repo_name:
        raise HTTPException(
            status_code=400,
            detail="Invalid GitHub repository. Format: https://github.com/owner/repo or owner/repo"
        )

    import urllib.request
    import json
    import hashlib
    import time

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) StarkLLM-Agent/1.0",
        "Accept": "application/vnd.github.v3+json"
    }

    # 1. Fetch repo metadata
    repo_meta_url = f"https://api.github.com/repos/{owner}/{repo_name}"
    try:
        http_req = urllib.request.Request(repo_meta_url, headers=headers)
        with urllib.request.urlopen(http_req, timeout=12) as resp:
            meta = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as he:
        if he.code == 404:
            raise HTTPException(status_code=404, detail=f"GitHub repository '{owner}/{repo_name}' not found or is private.")
        elif he.code == 403:
            raise HTTPException(status_code=429, detail="GitHub API rate limit exceeded. Please wait a moment and try again.")
        else:
            raise HTTPException(status_code=400, detail=f"GitHub API error: {he.reason}")
    except Exception as e:
        logger.error(f"Failed to query GitHub API for {owner}/{repo_name}: {e}")
        raise HTTPException(status_code=400, detail=f"Could not connect to GitHub: {str(e)[:200]}")

    default_branch = req.branch or meta.get("default_branch", "main")
    description = meta.get("description") or "No description provided."
    stars = meta.get("stargazers_count", 0)
    language = meta.get("language") or "General"
    topics = ", ".join(meta.get("topics", [])) or "None"

    # 2. Fetch git tree recursively
    tree_url = f"https://api.github.com/repos/{owner}/{repo_name}/git/trees/{default_branch}?recursive=1"
    try:
        http_req = urllib.request.Request(tree_url, headers=headers)
        with urllib.request.urlopen(http_req, timeout=15) as resp:
            tree_data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        logger.error(f"Failed to fetch git tree for {owner}/{repo_name} ({default_branch}): {e}")
        raise HTTPException(status_code=400, detail=f"Could not fetch file tree for branch '{default_branch}': {str(e)[:200]}")

    raw_tree = tree_data.get("tree", [])
    if not raw_tree:
        raise HTTPException(status_code=400, detail="Repository appears to be empty.")

    # 3. Filter files
    EXCLUDED_PREFIXES = (
        ".git/", "node_modules/", "dist/", "build/", "vendor/", "__pycache__/",
        ".next/", "venv/", ".venv/", "env/", ".idea/", ".vscode/", "coverage/",
        "target/", ".github/workflows/"
    )
    EXCLUDED_FILENAMES = {
        "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock",
        "poetry.lock", "composer.lock", "gemfile.lock"
    }
    ALLOWED_EXTENSIONS = {
        ".py", ".js", ".jsx", ".ts", ".tsx", ".md", ".json", ".yaml", ".yml",
        ".go", ".rs", ".html", ".css", ".sql", ".sh", ".txt", ".toml", ".rst",
        ".cpp", ".c", ".h", ".cs", ".java", ".rb", ".php"
    }

    candidate_files = []
    for item in raw_tree:
        if item.get("type") != "blob":
            continue
        p = item.get("path", "")
        if any(p.startswith(prefix) for prefix in EXCLUDED_PREFIXES):
            continue
        fname = os.path.basename(p).lower()
        if fname in EXCLUDED_FILENAMES:
            continue
        _, ext = os.path.splitext(fname)
        if ext in ALLOWED_EXTENSIONS or fname in ("readme", "license", "dockerfile"):
            size = item.get("size", 0)
            if size <= 120_000:
                candidate_files.append((p, size))

    if not candidate_files:
        raise HTTPException(status_code=400, detail="No readable text or code files found in this repository.")

    def file_priority(item):
        path = item[0].lower()
        if "readme" in path:
            return 0
        if "architecture" in path or "contributing" in path:
            return 1
        if path.startswith("docs/"):
            return 2
        if any(path.endswith(ext) for ext in (".py", ".js", ".ts", ".jsx", ".tsx", ".go", ".rs")):
            return 3
        return 4

    candidate_files.sort(key=file_priority)
    max_count = min(req.max_files or 20, 30)
    selected_files = candidate_files[:max_count]

    # 4. Fetch content for each selected file
    file_sections = []
    file_tree_list = [p for p, _ in candidate_files[:50]]

    for path, _ in selected_files:
        raw_url = f"https://raw.githubusercontent.com/{owner}/{repo_name}/{default_branch}/{path}"
        try:
            raw_req = urllib.request.Request(raw_url, headers={"User-Agent": "StarkLLM-Scraper/1.0"})
            with urllib.request.urlopen(raw_req, timeout=10) as raw_resp:
                content = raw_resp.read().decode("utf-8", errors="replace")
                ext = path.rsplit(".", 1)[-1] if "." in path else ""
                file_sections.append(f"### File: `{path}`\n```{ext}\n{content}\n```")
        except Exception as err:
            logger.warning(f"Could not fetch file {path}: {err}")

    if not file_sections:
        raise HTTPException(status_code=400, detail="Failed to fetch contents of repository files.")

    # 5. Assemble Markdown
    tree_preview = "\n".join(f"- `{f}`" for f in file_tree_list[:30])
    if len(file_tree_list) > 30:
        tree_preview += f"\n- ... and {len(file_tree_list) - 30} more files"

    markdown_content = (
        f"# GitHub Repository: {owner}/{repo_name}\n\n"
        f"**Repository URL:** https://github.com/{owner}/{repo_name}\n\n"
        f"**Description:** {description}\n\n"
        f"**Default Branch:** {default_branch} | **Primary Language:** {language} | **Stars:** {stars}\n\n"
        f"**Topics:** {topics}\n\n"
        f"---\n\n"
        f"## Repository File Structure\n\n"
        f"{tree_preview}\n\n"
        f"---\n\n"
        f"## Source Code and Documentation ({len(file_sections)} files indexed)\n\n"
        + "\n\n---\n\n".join(file_sections)
    )

    safe_title = f"{owner}_{repo_name}_repo"
    safe_filename = f"{safe_title}.md"
    unique_prefix = hashlib.md5(f"gh_{owner}_{repo_name}_{time.time()}".encode()).hexdigest()[:8]
    file_disk_name = f"{unique_prefix}_{safe_filename}"
    file_path = os.path.join(settings.UPLOAD_DIR, file_disk_name)

    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(markdown_content)

    actual_size = os.path.getsize(file_path)

    doc = models.Document(
        workspace_id=workspace_id,
        filename=safe_filename,
        filepath=file_path,
        file_type="md",
        status=DocStatus.UPLOADING,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)

    thread = threading.Thread(
        target=_index_document_background,
        args=(doc.id, workspace_id, current_user.id, file_path),
        daemon=True,
    )
    thread.start()

    return {
        "id": doc.id,
        "filename": doc.filename,
        "filepath": doc.filepath,
        "file_type": doc.file_type,
        "status": doc.status,
        "error_message": doc.error_message,
        "created_at": doc.created_at.isoformat() if doc.created_at else None,
        "file_size": actual_size,
        "source_url": f"https://github.com/{owner}/{repo_name}",
        "repo_name": f"{owner}/{repo_name}"
    }


# --- Quick Note / Raw Text Ingestion ---

class IngestNoteRequest(BaseModel):
    title: str
    content: str


@router.post("/{workspace_id}/ingest-note")
async def ingest_note(
    workspace_id: int,
    req: IngestNoteRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    Ingest a direct custom text note or markdown snippet into the Workspace RAG.
    """
    ws = db.query(models.Workspace).filter(
        models.Workspace.id == workspace_id,
        models.Workspace.user_id == current_user.id
    ).first()
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    title = req.title.strip() if req.title else "Untitled Note"
    content = req.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Note content cannot be empty.")

    import hashlib
    import time

    safe_title = re.sub(r'[\\/*?:"<>|]', "", title)[:60].strip() or "note"
    safe_filename = f"{safe_title}.md"
    unique_prefix = hashlib.md5(f"note_{workspace_id}_{time.time()}".encode()).hexdigest()[:8]
    file_disk_name = f"{unique_prefix}_{safe_filename}"
    file_path = os.path.join(settings.UPLOAD_DIR, file_disk_name)

    markdown_content = f"# {title}\n\n---\n\n{content}"

    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(markdown_content)

    actual_size = os.path.getsize(file_path)

    doc = models.Document(
        workspace_id=workspace_id,
        filename=safe_filename,
        filepath=file_path,
        file_type="md",
        status=DocStatus.UPLOADING,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)

    thread = threading.Thread(
        target=_index_document_background,
        args=(doc.id, workspace_id, current_user.id, file_path),
        daemon=True,
    )
    thread.start()

    return {
        "id": doc.id,
        "filename": doc.filename,
        "filepath": doc.filepath,
        "file_type": doc.file_type,
        "doc_type": "note",
        "status": doc.status,
        "error_message": doc.error_message,
        "created_at": doc.created_at.isoformat() if doc.created_at else None,
        "file_size": actual_size,
        "title": title
    }



@router.get("/{workspace_id}")
def get_documents(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    ws = db.query(models.Workspace).filter(
        models.Workspace.id == workspace_id,
        models.Workspace.user_id == current_user.id
    ).first()
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    docs = db.query(models.Document).filter(
        models.Document.workspace_id == workspace_id
    ).order_by(models.Document.created_at.desc()).all()

    result = []
    for d in docs:
        exists = os.path.exists(d.filepath) if d.filepath else False
        size = os.path.getsize(d.filepath) if exists else 0

        # If file is missing but was supposedly indexed, override status
        effective_status = d.status
        if not exists and d.status == DocStatus.INDEXED:
            effective_status = "missing"

        doc_title = d.filename.rsplit('.', 1)[0] if '.' in d.filename else d.filename
        is_note = d.file_type == "md"
        result.append({
            "id": d.id,
            "filename": d.filename,
            "title": doc_title,
            "filepath": d.filepath,
            "file_type": d.file_type,
            "doc_type": "note" if is_note else "document",
            "created_at": d.created_at.isoformat() if d.created_at else None,
            "file_size": size,
            "status": effective_status,
            "error_message": d.error_message,
        })

    return result


@router.get("/{workspace_id}/documents/{document_id}/status")
def get_document_status(
    workspace_id: int,
    document_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Lightweight polling endpoint: returns current status of a single document."""
    ws = db.query(models.Workspace).filter(
        models.Workspace.id == workspace_id,
        models.Workspace.user_id == current_user.id
    ).first()
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    doc = db.query(models.Document).filter(
        models.Document.id == document_id,
        models.Document.workspace_id == workspace_id
    ).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    exists = os.path.exists(doc.filepath) if doc.filepath else False
    effective_status = doc.status
    if not exists and doc.status == DocStatus.INDEXED:
        effective_status = "missing"

    return {"id": doc.id, "status": effective_status, "error_message": doc.error_message}


@router.get("/{workspace_id}/preview/{document_id}")
async def preview_document(
    workspace_id: int,
    document_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    ws = db.query(models.Workspace).filter(
        models.Workspace.id == workspace_id,
        models.Workspace.user_id == current_user.id
    ).first()
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    doc = db.query(models.Document).filter(
        models.Document.id == document_id,
        models.Document.workspace_id == workspace_id
    ).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    try:
        collection = await asyncio.to_thread(rag_service.get_or_create_collection, workspace_id, current_user.id)
        preview_text = await asyncio.to_thread(rag_service.get_document_preview, collection, doc.filepath)
        return {"document_id": document_id, "filename": doc.filename, "preview": preview_text}
    except Exception as e:
        logger.error(f"Error generating preview: {e}")
        return {"document_id": document_id, "filename": doc.filename, "preview": "Error generating preview."}


@router.post("/{workspace_id}/documents/{document_id}/reindex")
async def reindex_document(
    workspace_id: int,
    document_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Re-parse and embed a document into ChromaDB with status tracking."""
    ws = db.query(models.Workspace).filter(
        models.Workspace.id == workspace_id,
        models.Workspace.user_id == current_user.id
    ).first()
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    doc = db.query(models.Document).filter(
        models.Document.id == document_id,
        models.Document.workspace_id == workspace_id
    ).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if not doc.filepath or not os.path.exists(doc.filepath):
        raise HTTPException(status_code=400, detail="Original file is missing from disk")

    # Set status to EXTRACTING to let client know re-index started
    doc.status = DocStatus.EXTRACTING
    doc.error_message = None
    db.commit()

    # 1. Remove old vectors
    try:
        collection = await asyncio.to_thread(
            rag_service.get_or_create_collection, workspace_id, current_user.id
        )
        await asyncio.to_thread(collection.delete, where={"source": doc.filepath})
    except Exception as e:
        logger.warning(f"Could not remove old vectors for {doc.filepath} during reindex: {e}")

    # 2. Re-index in background thread
    thread = threading.Thread(
        target=_index_document_background,
        args=(doc.id, workspace_id, current_user.id, doc.filepath),
        daemon=True,
    )
    thread.start()

    return {"status": "reindexing", "document_id": document_id}


@router.delete("/{workspace_id}/documents/{document_id}")
async def delete_document(
    workspace_id: int,
    document_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Delete a document from DB and remove its vectors from ChromaDB."""
    ws = db.query(models.Workspace).filter(
        models.Workspace.id == workspace_id,
        models.Workspace.user_id == current_user.id
    ).first()
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    doc = db.query(models.Document).filter(
        models.Document.id == document_id,
        models.Document.workspace_id == workspace_id
    ).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # Remove vectors from ChromaDB
    try:
        collection = await asyncio.to_thread(
            rag_service.get_or_create_collection, workspace_id, current_user.id
        )
        await asyncio.to_thread(collection.delete, where={"source": doc.filepath})
    except Exception as e:
        logger.warning(f"Could not remove vectors for {doc.filepath}: {e}")

    # Remove file from disk
    try:
        if doc.filepath and os.path.exists(doc.filepath):
            os.remove(doc.filepath)
    except Exception as e:
        logger.warning(f"Could not remove file {doc.filepath} from disk: {e}")

    db.delete(doc)
    db.commit()
    return {"status": "deleted", "document_id": document_id}


@router.get("/{workspace_id}/documents/{document_id}/file")
async def get_document_file(
    workspace_id: int,
    document_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Serve the raw file with appropriate media type for inline preview/streaming."""
    ws = db.query(models.Workspace).filter(
        models.Workspace.id == workspace_id,
        models.Workspace.user_id == current_user.id
    ).first()
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    doc = db.query(models.Document).filter(
        models.Document.id == document_id,
        models.Document.workspace_id == workspace_id
    ).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if not doc.filepath or not os.path.exists(doc.filepath):
        raise HTTPException(status_code=404, detail="File missing from disk")

    ext = (doc.file_type or "").lower().strip(".")
    media_map = {
        "pdf": "application/pdf",
        "txt": "text/plain; charset=utf-8",
        "md": "text/markdown; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "html": "text/html; charset=utf-8",
        "csv": "text/csv; charset=utf-8",
    }
    media_type = media_map.get(ext, "application/octet-stream")
    return FileResponse(doc.filepath, media_type=media_type, filename=doc.filename)


@router.get("/{workspace_id}/documents/{document_id}/content")
async def get_document_content(
    workspace_id: int,
    document_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Retrieve extracted text and page breakdown of a document for deep citations."""
    ws = db.query(models.Workspace).filter(
        models.Workspace.id == workspace_id,
        models.Workspace.user_id == current_user.id
    ).first()
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    doc = db.query(models.Document).filter(
        models.Document.id == document_id,
        models.Document.workspace_id == workspace_id
    ).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    if not doc.filepath or not os.path.exists(doc.filepath):
        raise HTTPException(status_code=404, detail="File missing from disk")

    ext = (doc.file_type or "").lower().strip(".")
    pages = []
    full_text = ""

    if ext == "pdf":
        try:
            try:
                import pymupdf as fitz
            except ImportError:
                import fitz
            doc_fitz = fitz.open(doc.filepath)
            for p_no in range(len(doc_fitz)):
                page = doc_fitz[p_no]
                txt = page.get_text("text").strip()
                pages.append({"page": p_no + 1, "text": txt})
                if txt:
                    full_text += f"\n--- Page {p_no + 1} ---\n" + txt
        except Exception as e:
            logger.error(f"Error reading PDF content: {e}")
            full_text = f"Error reading PDF: {e}"
    else:
        try:
            with open(doc.filepath, "r", encoding="utf-8", errors="replace") as f:
                full_text = f.read()
            pages.append({"page": 1, "text": full_text})
        except Exception as e:
            logger.error(f"Error reading document text: {e}")
            full_text = f"Error reading document: {e}"

    return {
        "id": doc.id,
        "filename": doc.filename,
        "file_type": doc.file_type,
        "page_count": len(pages),
        "pages": pages,
        "full_text": full_text
    }


@router.get("/{workspace_id}/documents/lookup")
async def lookup_document_by_name(
    workspace_id: int,
    filename: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Lookup document by filename to support inline citation jumping."""
    clean_name = filename.strip()
    # Remove citation page patterns like '(Page 4)' or '[Page 4]'
    clean_name = re.sub(r'[\(\[]Page\s*\d+[\)\]]', '', clean_name).strip()

    doc = db.query(models.Document).filter(
        models.Document.workspace_id == workspace_id,
        models.Document.filename == clean_name
    ).first()

    if not doc:
        # Try case-insensitive or partial match
        doc = db.query(models.Document).filter(
            models.Document.workspace_id == workspace_id,
            models.Document.filename.ilike(f"%{clean_name}%")
        ).first()

    if not doc:
        raise HTTPException(status_code=404, detail=f"Document '{filename}' not found")

    return {
        "id": doc.id,
        "filename": doc.filename,
        "file_type": doc.file_type,
        "status": doc.status
    }

