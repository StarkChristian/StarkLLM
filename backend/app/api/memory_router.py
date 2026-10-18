"""
Memory CRUD routes.

Extracted from chat.py to keep chat.py focused on conversation logic.
Mounted at /api/v1/chat (same prefix as before, no URL changes).
"""

import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional

from app.db.session import get_db
from app.db import models
from app.api.auth import get_current_user
from app.api.deps import get_workspace_or_404
from app.services.memory_service import memory_service

router = APIRouter()
logger = logging.getLogger(__name__)


class AddMemoryRequest(BaseModel):
    content: str


@router.get("/memory/{workspace_id}")
def get_memories(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Get all long-term memories for a workspace."""
    get_workspace_or_404(db, workspace_id, current_user.id)
    return memory_service.get_memories(workspace_id)


@router.post("/memory/{workspace_id}")
def add_memory(
    workspace_id: int,
    req: AddMemoryRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Manually add a long-term memory."""
    get_workspace_or_404(db, workspace_id, current_user.id)
    if not req.content or not req.content.strip():
        raise HTTPException(status_code=400, detail="Content cannot be empty")
    return memory_service.add_memory(workspace_id, req.content.strip())


@router.delete("/memory/{workspace_id}/{memory_id}")
def delete_memory(
    workspace_id: int,
    memory_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Delete a specific memory."""
    get_workspace_or_404(db, workspace_id, current_user.id)
    memory_service.delete_memory(workspace_id, memory_id)
    return {"status": "deleted"}


@router.delete("/memory/{workspace_id}")
def clear_memories(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Clear all memories for a workspace."""
    get_workspace_or_404(db, workspace_id, current_user.id)
    memory_service.clear_memories(workspace_id)
    return {"status": "cleared"}
