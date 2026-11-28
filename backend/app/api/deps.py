"""
Shared FastAPI dependency helpers.

Centralises repeated ownership-guard queries so every router
can call a single function instead of duplicating 6-line blocks.
"""

import logging
from sqlalchemy.orm import Session
from fastapi import HTTPException

from app.db import models

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Workspace helpers
# ---------------------------------------------------------------------------

def get_workspace_or_404(
    db: Session,
    workspace_id: int,
    user_id: int,
) -> models.Workspace:
    """
    Return the workspace owned by user_id, or raise HTTP 404.

    Replaces the repeated 7-line ownership-guard pattern:
        ws = db.query(models.Workspace).filter(...).first()
        if not ws: raise HTTPException(404, ...)
    """
    from app.services.household import ws_visible
    ws = (
        db.query(models.Workspace)
        .filter(
            models.Workspace.id == workspace_id,
            ws_visible(user_id),   # own workspaces and the shared workspaces the account has joined
        )
        .first()
    )
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return ws


# ---------------------------------------------------------------------------
# Chat helpers
# ---------------------------------------------------------------------------

def get_chat_or_404(
    db: Session,
    chat_id: int,
    user_id: int,
) -> models.Chat:
    """
    Return the chat session owned (via workspace) by user_id, or raise HTTP 404.
    """
    from app.services.household import chat_visible
    chat = (
        db.query(models.Chat)
        .join(models.Workspace, models.Chat.workspace_id == models.Workspace.id)
        .filter(
            models.Chat.id == chat_id,
            chat_visible(user_id),   # chats are private, also in a shared workspace
        )
        .first()
    )
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    return chat


# ---------------------------------------------------------------------------
# Message helpers
# ---------------------------------------------------------------------------

def get_message_or_404(
    db: Session,
    message_id: int,
    user_id: int,
) -> models.Message:
    """
    Return the message owned (via chat → workspace) by user_id, or raise HTTP 404.
    """
    from app.services.household import chat_visible
    msg = (
        db.query(models.Message)
        .join(models.Chat, models.Message.chat_id == models.Chat.id)
        .join(models.Workspace, models.Chat.workspace_id == models.Workspace.id)
        .filter(
            models.Message.id == message_id,
            chat_visible(user_id),
        )
        .first()
    )
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    return msg
