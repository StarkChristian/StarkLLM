from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.db.session import get_db
from app.db import models
from pydantic import BaseModel
from app.api.auth import get_current_user
from typing import Optional
import os

router = APIRouter()

class WorkspaceCreate(BaseModel):
    name: str

@router.post("/")
@router.post("", include_in_schema=False)
def create_workspace(
    ws: WorkspaceCreate, 
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    db_ws = models.Workspace(name=ws.name, user_id=current_user.id, shared=0)
    db.add(db_ws)
    db.commit()
    db.refresh(db_ws)
    return db_ws

@router.get("/")
@router.get("", include_in_schema=False)
def get_workspaces(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    from app.services import household
    workspaces = db.query(models.Workspace).filter(household.ws_visible(current_user.id)).order_by(models.Workspace.id).all()
    owners = household.names(db, [ws.user_id for ws in workspaces if ws.shared])
    return [
        {
            "id": ws.id,
            "name": ws.name,
            # a member does not see the owner's knowledge-base choice or instructions text to edit; both stay the owner's
            "active_kb_dir_ids": ws.active_kb_dir_ids if ws.user_id == current_user.id else None,
            "system_prompt": ws.system_prompt,
            "created_at": ws.created_at,
            "shared": bool(ws.shared),
            "role": "owner" if ws.user_id == current_user.id else "member",
            "owner": owners.get(ws.user_id) if ws.shared else None,
        }
        for ws in workspaces
    ]

@router.delete("/{workspace_id}")
def delete_workspace(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    db_ws = db.query(models.Workspace).filter(models.Workspace.id == workspace_id, models.Workspace.user_id == current_user.id).first()
    if db_ws:
        delete_workspace_completely(db, db_ws)
        return {"status": "deleted"}
    raise HTTPException(status_code=404, detail="Workspace not found")


def delete_workspace_completely(db: Session, ws: models.Workspace):
    """Delete a workspace with its documents, chats (in a shared workspace: every member's), memories, and its sharing
    (members, keys, activity). Only for the owner; the callers check."""
    from app.services import household
    _purge_workspace_data(db, ws, ws.user_id)
    household.purge(db, ws)
    db.query(models.ChatFolder).filter(models.ChatFolder.workspace_id == ws.id).delete(synchronize_session=False)
    db.delete(ws)
    db.commit()


def _purge_workspace_data(db: Session, ws: models.Workspace, user_id: int):
    """Deleting a workspace must really delete its documents (files + vectors), chats, messages and memories."""
    import logging
    log = logging.getLogger(__name__)
    from app.services.rag_service import rag_service
    from app.services.memory_service import memory_service
    for d in db.query(models.Document).filter(models.Document.workspace_id == ws.id).all():
        try:
            if d.filepath:
                from app.services import summaries
                summaries.remove(d.filepath)
            if d.filepath and os.path.exists(d.filepath):
                os.remove(d.filepath)
        except Exception as e:
            log.warning(f"Could not remove {d.filepath}: {e}")
        db.delete(d)
    chat_ids = [c.id for c in db.query(models.Chat.id).filter(models.Chat.workspace_id == ws.id).all()]
    if chat_ids:
        db.query(models.Message).filter(models.Message.chat_id.in_(chat_ids)).delete(synchronize_session=False)
        db.query(models.Chat).filter(models.Chat.id.in_(chat_ids)).delete(synchronize_session=False)
    try:
        rag_service.vector_client().delete_collection(f"user_{user_id}_workspace_{ws.id}")
    except Exception as e:
        log.warning(f"No vector collection to delete for workspace {ws.id}: {e}")
    try:
        memory_service.clear_memories(ws.id)
    except Exception as e:
        log.warning(f"Could not clear memories of workspace {ws.id}: {e}")

class WorkspaceKBUpdate(BaseModel):
    active_kb_dir_ids: list[int]

@router.put("/{workspace_id}/kb-folders")
def update_workspace_kb_folders(
    workspace_id: int,
    payload: WorkspaceKBUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    import json
    db_ws = db.query(models.Workspace).filter(
        models.Workspace.id == workspace_id, 
        models.Workspace.user_id == current_user.id
    ).first()
    if not db_ws:
        raise HTTPException(status_code=404, detail="Workspace not found")
    
    db_ws.active_kb_dir_ids = json.dumps(payload.active_kb_dir_ids)
    db.commit()
    db.refresh(db_ws)
    return db_ws


class WorkspaceSystemPromptUpdate(BaseModel):
    system_prompt: Optional[str] = None


@router.get("/{workspace_id}/system-prompt")
def get_workspace_system_prompt(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return the custom system prompt for a workspace."""
    db_ws = db.query(models.Workspace).filter(
        models.Workspace.id == workspace_id,
        models.Workspace.user_id == current_user.id,
    ).first()
    if not db_ws:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return {"workspace_id": workspace_id, "system_prompt": db_ws.system_prompt or ""}


@router.put("/{workspace_id}/system-prompt")
def update_workspace_system_prompt(
    workspace_id: int,
    payload: WorkspaceSystemPromptUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Update (or clear) the custom system prompt for a workspace."""
    db_ws = db.query(models.Workspace).filter(
        models.Workspace.id == workspace_id,
        models.Workspace.user_id == current_user.id,
    ).first()
    if not db_ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    db_ws.system_prompt = (payload.system_prompt or "").strip() or None
    db.commit()
    db.refresh(db_ws)
    return {"workspace_id": workspace_id, "system_prompt": db_ws.system_prompt or ""}


class WorkspaceRenameRequest(BaseModel):
    name: str


class WorkspaceUpdateRequest(BaseModel):
    name: Optional[str] = None
    custom_system_prompt: Optional[str] = None


@router.put("/{workspace_id}")
def update_workspace(
    workspace_id: int,
    payload: WorkspaceUpdateRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Update workspace name and/or persona prompt."""
    db_ws = db.query(models.Workspace).filter(
        models.Workspace.id == workspace_id,
        models.Workspace.user_id == current_user.id,
    ).first()
    if not db_ws:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if payload.name:
        db_ws.name = payload.name.strip()
    if payload.custom_system_prompt is not None:
        db_ws.system_prompt = payload.custom_system_prompt.strip() or None
    db.commit()
    db.refresh(db_ws)
    return {
        "id": db_ws.id,
        "name": db_ws.name,
        "custom_system_prompt": db_ws.system_prompt,
        "system_prompt": db_ws.system_prompt,
    }


@router.patch("/{workspace_id}")
def rename_workspace(
    workspace_id: int,
    payload: WorkspaceRenameRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Rename a workspace."""
    db_ws = db.query(models.Workspace).filter(
        models.Workspace.id == workspace_id,
        models.Workspace.user_id == current_user.id,
    ).first()
    if not db_ws:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if not payload.name.strip():
        raise HTTPException(status_code=400, detail="Name cannot be empty")
    db_ws.name = payload.name.strip()
    db.commit()
    return {"id": db_ws.id, "name": db_ws.name}
