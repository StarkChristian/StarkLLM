import logging
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import or_
from app.db.session import get_db
from app.db import models
from app.api.auth import get_current_user
from app.services.rag_service import rag_service

router = APIRouter()
logger = logging.getLogger(__name__)

MAX_RESULTS_PER_GROUP = 8


@router.get("/global")
def global_search(
    q: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Global search across chats, messages, workspaces, and documents.
    Returns grouped results: { chats, workspaces, documents }
    Results are scoped to the current user only.
    """
    q = q.strip()
    if not q:
        return {"chats": [], "workspaces": [], "documents": []}

    # escape LIKE wildcards so "%" and "_" are matched literally
    pattern = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"

    # ── 1. Workspaces ──────────────────────────────────────────────────────────
    workspaces = (
        db.query(models.Workspace)
        .filter(
            models.Workspace.user_id == current_user.id,
            models.Workspace.name.ilike(pattern, escape="\\"),
        )
        .order_by(models.Workspace.created_at.desc())
        .limit(MAX_RESULTS_PER_GROUP)
        .all()
    )

    ws_results = [
        {"id": ws.id, "name": ws.name, "type": "workspace"}
        for ws in workspaces
    ]

    # ── 2. Chats (by title) ────────────────────────────────────────────────────
    # We need workspace ids that belong to the user
    user_ws_ids = [ws.id for ws in db.query(models.Workspace.id).filter(
        models.Workspace.user_id == current_user.id
    ).all()]

    # Subquery: chats where title matches
    title_matching_chats = (
        db.query(models.Chat)
        .filter(
            models.Chat.workspace_id.in_(user_ws_ids),
            models.Chat.title.ilike(pattern, escape="\\"),
        )
        .order_by(models.Chat.created_at.desc())
        .limit(MAX_RESULTS_PER_GROUP)
        .all()
    )

    # Build workspace id → name lookup
    ws_name_map = {ws.id: ws.name for ws in db.query(models.Workspace).filter(
        models.Workspace.id.in_(user_ws_ids)
    ).all()}

    chat_results = [
        {
            "id": c.id,
            "title": c.title or "Untitled Chat",
            "workspace_id": c.workspace_id,
            "workspace_name": ws_name_map.get(c.workspace_id, ""),
            "match_type": "title",
            "type": "chat",
        }
        for c in title_matching_chats
    ]

    # ── 3. Messages (content match → surfaced as chat results) ────────────────
    # Find chats where at least one message matches the query
    # We need chats NOT already in title_matching_chats
    already_found_chat_ids = {c.id for c in title_matching_chats}

    matching_messages = (
        db.query(models.Message.chat_id)
        .join(models.Chat, models.Message.chat_id == models.Chat.id)
        .filter(
            models.Chat.workspace_id.in_(user_ws_ids),
            models.Message.content.ilike(pattern, escape="\\"),
            ~models.Message.chat_id.in_(already_found_chat_ids),
        )
        .distinct()
        .limit(MAX_RESULTS_PER_GROUP)
        .all()
    )

    message_chat_ids = [row.chat_id for row in matching_messages]
    if message_chat_ids:
        content_matching_chats = (
            db.query(models.Chat)
            .filter(models.Chat.id.in_(message_chat_ids))
            .order_by(models.Chat.created_at.desc())
            .all()
        )
        for c in content_matching_chats:
            chat_results.append({
                "id": c.id,
                "title": c.title or "Untitled Chat",
                "workspace_id": c.workspace_id,
                "workspace_name": ws_name_map.get(c.workspace_id, ""),
                "match_type": "content",
                "type": "chat",
            })

    # Trim to MAX
    chat_results = chat_results[:MAX_RESULTS_PER_GROUP * 2]

    # ── 4. Documents (workspace docs by filename) ──────────────────────────────
    ws_docs = (
        db.query(models.Document)
        .filter(
            models.Document.workspace_id.in_(user_ws_ids),
            models.Document.filename.ilike(pattern, escape="\\"),
        )
        .order_by(models.Document.created_at.desc())
        .limit(MAX_RESULTS_PER_GROUP)
        .all()
    )

    doc_results = []
    found_doc_paths = set()
    found_doc_ids = set()

    for d in ws_docs:
        doc_results.append({
            "id": d.id,
            "name": d.filename,
            "workspace_id": d.workspace_id,
            "workspace_name": ws_name_map.get(d.workspace_id, ""),
            "doc_type": "workspace",
            "type": "document",
            "match_type": "filename",
            "content_snippet": None
        })
        if d.filepath:
            found_doc_paths.add(d.filepath)
        found_doc_ids.add(f"ws_{d.id}")

    # ── 5. Knowledge Base documents (by file_name) ─────────────────────────────
    kb_docs = (
        db.query(models.KnowledgeBaseDocument)
        .join(
            models.KnowledgeBaseFolder,
            models.KnowledgeBaseDocument.folder_id == models.KnowledgeBaseFolder.id,
        )
        .filter(
            models.KnowledgeBaseFolder.user_id == current_user.id,
            models.KnowledgeBaseDocument.file_name.ilike(pattern, escape="\\"),
        )
        .order_by(models.KnowledgeBaseDocument.created_at.desc())
        .limit(MAX_RESULTS_PER_GROUP)
        .all()
    )

    for d in kb_docs:
        doc_results.append({
            "id": d.id,
            "name": d.file_name,
            "workspace_id": None,
            "workspace_name": "Knowledge Base",
            "doc_type": "knowledge_base",
            "type": "document",
            "match_type": "filename",
            "content_snippet": None
        })
        if d.file_path:
            found_doc_paths.add(d.file_path)
        found_doc_ids.add(f"kb_{d.id}")

    # ── 6. Documents (Content Match via RAG) ───────────────────────────────────
    # A. Search Knowledge Base
    try:
        kb_results = rag_service.query_kb(
            user_id=current_user.id,
            query_text=q,
            n_results=MAX_RESULTS_PER_GROUP
        )
    except Exception as e:
        logger.error(f"Global search KB RAG error: {e}")
        kb_results = []

    # B. Search Workspaces
    ws_rag_results = []
    for ws_id in user_ws_ids:
        try:
            res = rag_service.query(
                workspace_id=ws_id,
                user_id=current_user.id,
                query_text=q,
                n_results=MAX_RESULTS_PER_GROUP
            )
            ws_rag_results.extend(res)
        except Exception as e:
            logger.error(f"Global search WS RAG error: {e}")
            
    ws_rag_results = ws_rag_results[:MAX_RESULTS_PER_GROUP]

    rag_kb_paths = list(set([r["metadata"].get("file_path") or r["metadata"].get("source") for r in kb_results if r.get("metadata")]))
    rag_ws_paths = list(set([r["metadata"].get("source") or r["metadata"].get("file_path") for r in ws_rag_results if r.get("metadata")]))
    
    rag_kb_paths = [p for p in rag_kb_paths if p and p not in found_doc_paths]
    rag_ws_paths = [p for p in rag_ws_paths if p and p not in found_doc_paths]

    if rag_kb_paths:
        rag_kb_docs = (
            db.query(models.KnowledgeBaseDocument)
            .join(models.KnowledgeBaseFolder)
            .filter(
                models.KnowledgeBaseFolder.user_id == current_user.id,
                models.KnowledgeBaseDocument.file_path.in_(rag_kb_paths)
            )
            .all()
        )
        path_to_snippet = {}
        for r in kb_results:
            p = r["metadata"].get("file_path") or r["metadata"].get("source")
            if p and p not in path_to_snippet:
                snippet = r.get("content", "")
                path_to_snippet[p] = snippet[:200] + "..." if len(snippet) > 200 else snippet

        for d in rag_kb_docs:
            if f"kb_{d.id}" not in found_doc_ids:
                doc_results.append({
                    "id": d.id,
                    "name": d.file_name,
                    "workspace_id": None,
                    "workspace_name": "Knowledge Base",
                    "doc_type": "knowledge_base",
                    "type": "document",
                    "match_type": "content",
                    "content_snippet": path_to_snippet.get(d.file_path)
                })
                found_doc_ids.add(f"kb_{d.id}")

    if rag_ws_paths:
        rag_ws_docs = (
            db.query(models.Document)
            .filter(
                models.Document.workspace_id.in_(user_ws_ids),
                models.Document.filepath.in_(rag_ws_paths)
            )
            .all()
        )
        path_to_snippet = {}
        for r in ws_rag_results:
            p = r["metadata"].get("source") or r["metadata"].get("file_path")
            if p and p not in path_to_snippet:
                snippet = r.get("content", "")
                path_to_snippet[p] = snippet[:200] + "..." if len(snippet) > 200 else snippet
                
        for d in rag_ws_docs:
            if f"ws_{d.id}" not in found_doc_ids:
                doc_results.append({
                    "id": d.id,
                    "name": d.filename,
                    "workspace_id": d.workspace_id,
                    "workspace_name": ws_name_map.get(d.workspace_id, ""),
                    "doc_type": "workspace",
                    "type": "document",
                    "match_type": "content",
                    "content_snippet": path_to_snippet.get(d.filepath)
                })
                found_doc_ids.add(f"ws_{d.id}")

    logger.info(
        f"Global search '{q}': {len(ws_results)} workspaces, "
        f"{len(chat_results)} chats, {len(doc_results)} documents"
    )

    return {
        "workspaces": ws_results,
        "chats": chat_results,
        "documents": doc_results,
    }
