from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.db.session import get_db
from app.db import models
from pydantic import BaseModel
from app.api.auth import get_current_user
from typing import Optional

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
    db_ws = models.Workspace(name=ws.name, user_id=current_user.id)
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
    workspaces = db.query(models.Workspace).filter(models.Workspace.user_id == current_user.id).all()
    return [
        {
            "id": ws.id,
            "name": ws.name,
            "active_kb_dir_ids": ws.active_kb_dir_ids,
            "system_prompt": ws.system_prompt,
            "created_at": ws.created_at,
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
        db.delete(db_ws)
        db.commit()
        return {"status": "deleted"}
    raise HTTPException(status_code=404, detail="Workspace not found")

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


class WorkspaceCreate(BaseModel):
    name: str

@router.post("/")
def create_workspace(
    ws: WorkspaceCreate, 
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    db_ws = models.Workspace(name=ws.name, user_id=current_user.id)
    db.add(db_ws)
    db.commit()
    db.refresh(db_ws)
    return db_ws

@router.get("/")
def get_workspaces(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    return db.query(models.Workspace).filter(models.Workspace.user_id == current_user.id).all()

@router.delete("/{workspace_id}")
def delete_workspace(
    workspace_id: int, 
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    db_ws = db.query(models.Workspace).filter(models.Workspace.id == workspace_id, models.Workspace.user_id == current_user.id).first()
    if db_ws:
        db.delete(db_ws)
        db.commit()
        return {"status": "deleted"}
    raise HTTPException(status_code=404, detail="Workspace not found")

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
