"""
api/knowledge_base.py — REST endpoints for the modern Knowledge Base feature.
"""

import os
import asyncio
from datetime import datetime
from typing import List, Optional
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.core.config import settings
from app.db import models
from app.db.session import get_db
from app.services.kb_service import kb_service
from app.services.rag_service import rag_service

router = APIRouter()

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class FolderCreate(BaseModel):
    folder_path: str
    folder_name: Optional[str] = None


class FolderResponse(BaseModel):
    id: int
    user_id: int
    folder_path: str
    folder_name: str
    is_active: int
    last_indexed_at: Optional[datetime] = None
    created_at: datetime

    class Config:
        from_attributes = True


class DocumentResponse(BaseModel):
    id: int
    folder_id: int
    file_path: str
    file_name: str
    file_type: str
    file_size: int
    last_modified: datetime
    status: str
    chunk_count: int
    error_message: Optional[str] = None
    indexed_at: Optional[datetime] = None
    created_at: datetime

    class Config:
        from_attributes = True


class IndexDocumentResponse(BaseModel):
    status: str
    message: str
    document_id: int


class IndexFolderResponse(BaseModel):
    status: str
    message: str
    indexed_document_ids: List[int]


class SyncFolderResponse(BaseModel):
    status: str
    added: int
    updated: int
    deleted: int
    indexed: int
    failed: int
    message: Optional[str] = None
    is_syncing: Optional[bool] = None


class FolderStatusResponse(BaseModel):
    folder_id: int
    is_syncing: bool
    is_active: bool
    last_indexed_at: Optional[datetime] = None


class BrowseEntry(BaseModel):
    name: str
    is_dir: bool


class BrowseResponse(BaseModel):
    path: str
    parent: Optional[str]
    entries: List[BrowseEntry]
    roots: List[str]


# ---------------------------------------------------------------------------
# Safe browse roots (start with KB_DATA_DIR; extend via KB_BROWSE_ROOTS env)
# ---------------------------------------------------------------------------

def _get_safe_roots() -> List[str]:
    """Returns the list of allowed top-level browse roots."""
    roots = [settings.KB_DATA_DIR]
    # Optional: space-separated extra roots via env KB_BROWSE_ROOTS
    extra = os.environ.get("KB_BROWSE_ROOTS", "")
    for r in extra.split():
        r = r.strip()
        if r and r not in roots:
            roots.append(r)
    return roots


def _assert_safe_path(path: str) -> Path:
    """Raises 403 if path escapes all safe roots."""
    resolved = Path(path).resolve()
    for root in _get_safe_roots():
        try:
            resolved.relative_to(Path(root).resolve())
            return resolved  # within this root — safe
        except ValueError:
            continue
    raise HTTPException(
        status_code=403,
        detail=f"Path '{path}' is outside all allowed browse roots: {_get_safe_roots()}"
    )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/config")
def get_kb_config(current_user: models.User = Depends(get_current_user)):
    """Return backend configuration for the Knowledge Base UI."""
    return {
        "host_kb_path": os.environ.get("HOST_KB_PATH", "knowledge_base_data (inside the StarkLLM project folder)"),
        "container_kb_path": settings.KB_DATA_DIR
    }


@router.get("/folders/browse", response_model=BrowseResponse)
def browse_directory(
    path: Optional[str] = Query(default=None, description="Absolute path to browse. Defaults to first safe root."),
    current_user: models.User = Depends(get_current_user),
):
    """
    Lists the contents of a directory within the allowed browse roots.
    Returns only directories and files (files shown greyed-out for context).
    Path is constrained to KB_DATA_DIR (and any KB_BROWSE_ROOTS configured).
    """
    roots = _get_safe_roots()

    # Default to first root when no path given
    if not path:
        path = roots[0]

    resolved = _assert_safe_path(path)  # raises 403 if unsafe

    if not resolved.exists():
        raise HTTPException(status_code=404, detail=f"Path '{path}' does not exist.")
    if not resolved.is_dir():
        raise HTTPException(status_code=400, detail=f"Path '{path}' is not a directory.")

    # Determine parent path (None if already at a root)
    parent_path: Optional[str] = None
    resolved_str = str(resolved)
    for root in roots:
        root_resolved = str(Path(root).resolve())
        if resolved_str != root_resolved:
            parent_path = str(resolved.parent)
            break

    # List entries — skip hidden files/dirs
    entries: List[BrowseEntry] = []
    try:
        for entry in sorted(resolved.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
            if entry.name.startswith("."):
                continue
            entries.append(BrowseEntry(name=entry.name, is_dir=entry.is_dir()))
    except PermissionError:
        raise HTTPException(status_code=403, detail=f"Permission denied reading '{path}'.")

    return BrowseResponse(
        path=str(resolved),
        parent=parent_path,
        entries=entries,
        roots=roots,
    )


@router.post("/folders", response_model=FolderResponse, status_code=201)
def register_folder(
    body: FolderCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Registers a new folder to the user's Knowledge Base.

    The path must be a container-visible path (e.g. /kb_data/subfolder).
    Windows host paths (C:\\...) are not accessible from inside Docker and will
    be rejected with a 422 that explains the launcher mirror workflow.
    """
    folder_path_cleaned = body.folder_path.strip()

    # Reject Windows host paths — they are not accessible from the container.
    # The launcher (start.exe) handles the mirror: it copies the Windows folder
    # into ./knowledge_base_data/<slug>/ and then registers /kb_data/<slug>.
    import re as _re
    if _re.match(r'^[A-Za-z]:[/\\]', folder_path_cleaned) or folder_path_cleaned.startswith('\\\\'):
        raise HTTPException(
            status_code=422,
            detail=(
                "Windows host paths (e.g. C:\\Users\\...) are not directly accessible "
                "from inside the Docker container. "
                "Use the StarkLLM launcher (start.exe) to pick a Windows folder: "
                "it will mirror your files into the knowledge_base_data/ directory "
                "and register the correct container path (/kb_data/...) automatically. "
                "If you want to add a folder manually, copy your files into "
                "knowledge_base_data\\<folder_name>\\ inside the StarkLLM project "
                "directory, then register the path /kb_data/<folder_name> here."
            )
        )

    # Only folders inside the Knowledge Base data directory may be registered. Without this check any logged-in
    # user could register /app/data (the databases of all users) or any other directory the container can read.
    kb_root = os.path.realpath(settings.KB_DATA_DIR)
    resolved = os.path.realpath(folder_path_cleaned)
    if resolved != kb_root and not resolved.startswith(kb_root + os.sep):
        raise HTTPException(
            status_code=403,
            detail=f"Only folders inside {settings.KB_DATA_DIR} can be added to the Knowledge Base. "
                   "Copy your files into the knowledge_base_data folder of the StarkLLM project first."
        )

    # Verify physical path exists inside the container
    if not os.path.exists(folder_path_cleaned):
        raise HTTPException(
            status_code=400,
            detail=(
                f"The path '{folder_path_cleaned}' does not exist inside the container. "
                "Container-visible paths start with /kb_data/. "
                "Use start.exe to add a Windows folder automatically."
            )
        )

    if not os.path.isdir(folder_path_cleaned):
        raise HTTPException(status_code=400, detail=f"'{folder_path_cleaned}' is a file, not a folder.")

    # Prevent duplicate registrations of the same path for the same user
    existing = db.query(models.KnowledgeBaseFolder).filter(
        models.KnowledgeBaseFolder.user_id == current_user.id,
        models.KnowledgeBaseFolder.folder_path == folder_path_cleaned
    ).first()

    if existing:
        # If it was deactivated/paused, we can reactivate it or notify
        if existing.is_active == 0:
            existing.is_active = 1
            db.commit()
            db.refresh(existing)
            return existing
        raise HTTPException(
            status_code=400,
            detail="This folder path is already registered."
        )

    folder_name_cleaned = body.folder_name.strip() if body.folder_name else None

    # Call service to register
    folder = kb_service.add_folder(
        db=db,
        user_id=current_user.id,
        folder_path=folder_path_cleaned,
        folder_name=folder_name_cleaned
    )
    return folder



@router.delete("/folders/{folder_id}", status_code=204)
def delete_folder(
    folder_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Deletes a folder and all its associated documents/vectors.
    """
    try:
        success = kb_service.delete_folder(db=db, folder_id=folder_id, user_id=current_user.id)
        if not success:
            raise HTTPException(status_code=400, detail="Failed to delete folder.")
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail="An error occurred while deleting the folder.")
    return None



@router.get("/folders", response_model=List[FolderResponse])
def get_folders(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Returns all active folders belonging to the current user.
    """
    return kb_service.get_user_folders(db=db, user_id=current_user.id)


@router.get("/folders/{folder_id}/documents", response_model=List[DocumentResponse])
def get_folder_documents(
    folder_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Returns all documents belonging to a specific folder (ownership verified).
    """
    folder = db.query(models.KnowledgeBaseFolder).filter(
        models.KnowledgeBaseFolder.id == folder_id,
        models.KnowledgeBaseFolder.user_id == current_user.id
    ).first()

    if not folder:
        raise HTTPException(
            status_code=404,
            detail="Knowledge Base folder not found or access denied."
        )

    return kb_service.get_folder_documents(db=db, folder_id=folder_id)


@router.post("/folders/{folder_id}/scan", response_model=List[DocumentResponse])
async def scan_folder(
    folder_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Scans the physical folder and registers new files as KnowledgeBaseDocument records.
    """
    # Verify folder exists and belongs to current user
    folder = db.query(models.KnowledgeBaseFolder).filter(
        models.KnowledgeBaseFolder.id == folder_id,
        models.KnowledgeBaseFolder.user_id == current_user.id
    ).first()

    if not folder:
        raise HTTPException(
            status_code=404,
            detail="Knowledge Base folder not found or access denied."
        )

    # Perform folder scan
    try:
        new_docs = await asyncio.to_thread(kb_service.scan_folder, db=db, folder_id=folder_id)
        return new_docs
    except FileNotFoundError as fnf_err:
        raise HTTPException(status_code=400, detail=str(fnf_err))
    except Exception as err:
        raise HTTPException(status_code=500, detail=f"Failed to scan folder: {str(err)}")


@router.post("/folders/{folder_id}/sync", response_model=SyncFolderResponse)
async def sync_folder(
    folder_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Synchronizes the folder: detects new, modified, and deleted files, and indexes as needed.
    """
    folder = db.query(models.KnowledgeBaseFolder).filter(
        models.KnowledgeBaseFolder.id == folder_id,
        models.KnowledgeBaseFolder.user_id == current_user.id
    ).first()

    if not folder:
        raise HTTPException(
            status_code=404,
            detail="Knowledge Base folder not found or access denied."
        )

    try:
        stats = await asyncio.to_thread(kb_service.sync_folder, db=db, folder_id=folder_id)
        return SyncFolderResponse(
            status="success",
            added=stats.get("added", 0),
            updated=stats.get("updated", 0),
            deleted=stats.get("deleted", 0),
            indexed=stats.get("indexed", 0),
            failed=stats.get("failed", 0)
        )
    except FileNotFoundError as fnf_err:
        raise HTTPException(status_code=400, detail=str(fnf_err))
    except Exception as err:
        raise HTTPException(status_code=500, detail=f"Failed to sync folder: {str(err)}")


@router.post("/documents/{document_id}/index", response_model=IndexDocumentResponse)
async def index_document(
    document_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Triggers indexing for a specific document.
    """
    # Verify document ownership via joint query
    doc = db.query(models.KnowledgeBaseDocument).join(
        models.KnowledgeBaseFolder,
        models.KnowledgeBaseDocument.folder_id == models.KnowledgeBaseFolder.id
    ).filter(
        models.KnowledgeBaseDocument.id == document_id,
        models.KnowledgeBaseFolder.user_id == current_user.id
    ).first()

    if not doc:
        raise HTTPException(
            status_code=404,
            detail="Knowledge Base document not found or access denied."
        )

    # Index document
    success = await asyncio.to_thread(kb_service.index_document, db=db, document_id=document_id)
    if success:
        return IndexDocumentResponse(
            status="success",
            message=f"Document '{doc.file_name}' successfully processed and indexed.",
            document_id=document_id
        )
    else:
        # Refetch document to retrieve failure error message
        db.refresh(doc)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to index document: {doc.error_message or 'Unknown error'}"
        )


@router.get("/documents/{document_id}/preview")
async def preview_document(
    document_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Returns a text preview of the parsed document from ChromaDB.
    """
    doc = db.query(models.KnowledgeBaseDocument).join(
        models.KnowledgeBaseFolder,
        models.KnowledgeBaseDocument.folder_id == models.KnowledgeBaseFolder.id
    ).filter(
        models.KnowledgeBaseDocument.id == document_id,
        models.KnowledgeBaseFolder.user_id == current_user.id
    ).first()

    if not doc:
        raise HTTPException(
            status_code=404,
            detail="Knowledge Base document not found or access denied."
        )

    try:
        collection = await asyncio.to_thread(rag_service.get_or_create_kb_collection, current_user.id)
        preview_text = await asyncio.to_thread(rag_service.get_document_preview, collection, doc.file_path)
        return {"document_id": document_id, "filename": doc.file_name, "preview": preview_text}
    except Exception as e:
        return {"document_id": document_id, "filename": doc.file_name, "preview": "Error generating preview."}



@router.post("/folders/{folder_id}/index", response_model=IndexFolderResponse)
async def index_folder(
    folder_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """
    Indexes all pending documents inside a folder.
    """
    # Verify folder ownership
    folder = db.query(models.KnowledgeBaseFolder).filter(
        models.KnowledgeBaseFolder.id == folder_id,
        models.KnowledgeBaseFolder.user_id == current_user.id
    ).first()

    if not folder:
        raise HTTPException(
            status_code=404,
            detail="Knowledge Base folder not found or access denied."
        )

    # Trigger indexing for all pending documents
    try:
        indexed_ids = await asyncio.to_thread(kb_service.index_pending_documents, db=db, folder_id=folder_id)
        
        # Update folder's last_indexed_at mtime
        folder.last_indexed_at = datetime.utcnow()
        db.commit()

        return IndexFolderResponse(
            status="success",
            message=f"Folder indexing operation complete. Successfully indexed {len(indexed_ids)} documents.",
            indexed_document_ids=indexed_ids
        )
    except Exception as err:
        raise HTTPException(
            status_code=500,
            detail=f"An error occurred during folder indexing: {str(err)}"
        )
