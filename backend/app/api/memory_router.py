"""
Memory routes (long-term memory, 2.8 option 7).

Mounted at /api/v1/chat (same prefix as before, no URL changes). These routes are the only way memory is written,
and each one is a click of the user in the app: "Remember this" on a message, "Add" in the memory panel, "Accept" on
a suggestion. See services/memory_service.py for the rules against memory poisoning.
"""

import json
import logging
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db import models
from app.api.auth import get_current_user
from app.api.deps import get_workspace_or_404
from app.services.memory_service import memory_service, MemoryRejected, MAX_CHARS

router = APIRouter()
logger = logging.getLogger(__name__)

REJECTED = {
    "empty": "The memory is empty.",
    "too_long": f"A memory can have at most {MAX_CHARS} characters.",
    "addresses_ai": "This text speaks to an AI assistant (for example \"ignore previous instructions\" or a note for "
                    "assistants). Text like this is not saved as memory, because it could steer later answers.",
}


def _rejected(e: MemoryRejected):
    # 422 with a code: the app shows its own warning in the user's language
    raise HTTPException(status_code=422, detail={"code": e.code, "message": REJECTED.get(e.code, e.code)})


class AddMemoryRequest(BaseModel):
    content: str = Field(..., max_length=20000)
    # "Remember this" on a message: where it came from (checked against the user's chats)
    chat_id: Optional[int] = None
    message_id: Optional[int] = None
    from_role: Optional[Literal["user", "assistant"]] = None


class UpdateMemoryRequest(BaseModel):
    content: Optional[str] = Field(None, max_length=20000)
    pinned: Optional[bool] = None


class AcceptSuggestionRequest(BaseModel):
    content: Optional[str] = Field(None, max_length=20000)


def _chat_titles(db: Session, workspace_id: int, entries):
    """The title of the chat each entry came from (None when the chat was deleted)."""
    ids = {e["chat_id"] for e in entries if e.get("chat_id")}
    titles = {}
    if ids:
        for c in db.query(models.Chat).filter(models.Chat.workspace_id == workspace_id, models.Chat.id.in_(ids)).all():
            titles[c.id] = c.title
    for e in entries:
        e["chat_title"] = titles.get(e.get("chat_id")) if e.get("chat_id") else None
        e["chat_exists"] = bool(e.get("chat_id") and e["chat_id"] in titles)
    return entries


@router.get("/memory/{workspace_id}")
def get_memories(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Every memory of a workspace with its provenance, pinned first."""
    get_workspace_or_404(db, workspace_id, current_user.id)
    return _chat_titles(db, workspace_id, memory_service.get_memories(workspace_id))


@router.get("/memory/{workspace_id}/suggestions")
def get_suggestions(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Facts suggested from the user's messages. They are not used in answers until the user accepts them."""
    get_workspace_or_404(db, workspace_id, current_user.id)
    return _chat_titles(db, workspace_id, memory_service.get_suggestions(workspace_id))


@router.get("/memory/{workspace_id}/export")
def export_memories(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """All memories and suggestions of the workspace as a JSON file."""
    ws = get_workspace_or_404(db, workspace_id, current_user.id)
    data = memory_service.export(workspace_id)
    _chat_titles(db, workspace_id, data["memories"])
    _chat_titles(db, workspace_id, data["suggestions"])
    data["workspace_name"] = ws.name
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return Response(
        content=json.dumps(data, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="starkllm-memory-{workspace_id}-{day}.json"'},
    )


@router.post("/memory/{workspace_id}")
def add_memory(
    workspace_id: int,
    req: AddMemoryRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """A memory the user writes in the panel, or saves with "Remember this" on a message."""
    get_workspace_or_404(db, workspace_id, current_user.id)
    from_role = req.from_role
    if req.chat_id is not None:
        chat = db.query(models.Chat).filter(models.Chat.id == req.chat_id, models.Chat.workspace_id == workspace_id).first()
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found")
        if req.message_id is not None:
            msg = db.query(models.Message).filter(models.Message.id == req.message_id,
                                                  models.Message.chat_id == chat.id).first()
            if not msg:
                raise HTTPException(status_code=404, detail="Message not found")
            from_role = msg.role if msg.role in ("user", "assistant") else None
    elif req.message_id is not None:
        raise HTTPException(status_code=400, detail="A message needs its chat")
    try:
        entry = memory_service.add_memory(workspace_id, req.content, chat_id=req.chat_id, message_id=req.message_id,
                                          from_role=from_role if req.chat_id is not None else None)
    except MemoryRejected as e:
        _rejected(e)
    return _chat_titles(db, workspace_id, [entry])[0]


@router.patch("/memory/{workspace_id}/{memory_id}")
def update_memory(
    workspace_id: int,
    memory_id: str,
    req: UpdateMemoryRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Edit the text of a memory, or pin / unpin it."""
    get_workspace_or_404(db, workspace_id, current_user.id)
    if req.content is None and req.pinned is None:
        raise HTTPException(status_code=400, detail="Nothing to change")
    try:
        entry = memory_service.update_memory(workspace_id, memory_id, content=req.content, pinned=req.pinned)
    except MemoryRejected as e:
        _rejected(e)
    if entry is None:
        raise HTTPException(status_code=404, detail="Memory not found")
    return _chat_titles(db, workspace_id, [entry])[0]


@router.post("/memory/{workspace_id}/{memory_id}/accept")
def accept_suggestion(
    workspace_id: int,
    memory_id: str,
    req: Optional[AcceptSuggestionRequest] = None,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """The user accepts a suggestion (possibly changed): it becomes memory."""
    get_workspace_or_404(db, workspace_id, current_user.id)
    try:
        entry = memory_service.accept_suggestion(workspace_id, memory_id, content=req.content if req else None)
    except MemoryRejected as e:
        _rejected(e)
    if entry is None:
        raise HTTPException(status_code=404, detail="Suggestion not found")
    return _chat_titles(db, workspace_id, [entry])[0]


@router.delete("/memory/{workspace_id}/{memory_id}")
def delete_memory(
    workspace_id: int,
    memory_id: str,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Delete a memory, or dismiss a suggestion."""
    get_workspace_or_404(db, workspace_id, current_user.id)
    if not memory_service.delete_memory(workspace_id, memory_id):
        raise HTTPException(status_code=404, detail="Memory not found")
    return {"status": "deleted"}


@router.delete("/memory/{workspace_id}")
def clear_memories(
    workspace_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Delete every memory and suggestion of a workspace."""
    get_workspace_or_404(db, workspace_id, current_user.id)
    memory_service.clear_memories(workspace_id)
    return {"status": "cleared"}
