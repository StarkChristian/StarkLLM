import os
import shutil
import asyncio
import logging
import threading
from fastapi import APIRouter, Depends, UploadFile, File, HTTPException
from sqlalchemy.orm import Session
from app.db.session import get_db, SessionLocal
from app.db import models
from app.db.models import DocStatus
import re
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
    ALLOWED_EXTENSIONS = {'pdf', 'txt', 'png', 'jpg', 'jpeg', 'md', 'csv', 'docx', 'xlsx', 'html', 'json'}
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

        result.append({
            "id": d.id,
            "filename": d.filename,
            "filepath": d.filepath,
            "file_type": d.file_type,
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
