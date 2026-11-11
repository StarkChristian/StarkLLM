"""Settings > Telegram: switch the Telegram bridge on and off, pair phones (app/services/telegram_bridge.py)."""
import asyncio
import time
import urllib.parse
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api import chat as chat_api
from app.api.auth import get_current_user
from app.db import models
from app.db.session import SessionLocal, get_db
from app.services import telegram_bridge as tb

router = APIRouter()


async def _answer_async(owner_id: int, starkllm_chat_id: Optional[int], question: str):
    db = SessionLocal()
    try:
        user = db.get(models.User, owner_id)
        if not user:
            raise RuntimeError("the StarkLLM user of this bridge no longer exists")
        ws = db.query(models.Workspace).filter(models.Workspace.user_id == user.id).order_by(models.Workspace.id).first()
        if not ws:
            ws = models.Workspace(user_id=user.id, name="Telegram")
            db.add(ws)
            db.commit()
            db.refresh(ws)
        if starkllm_chat_id and not db.query(models.Chat).filter(models.Chat.id == starkllm_chat_id, models.Chat.workspace_id == ws.id).first():
            starkllm_chat_id = None  # deleted in the app meanwhile
        req = chat_api.ChatRequest(workspace_id=ws.id, chat_id=starkllm_chat_id, message=question, stream=False, use_knowledge_base=True)
        response, background = Response(), BackgroundTasks()
        out = await chat_api.chat(req, response, background, db, user)
        await background()
        sources = []
        for header in ("X-WS-Sources", "X-KB-Sources"):
            sources += [s for s in urllib.parse.unquote(response.headers.get(header, "")).split("|") if s]
        return out["response"], out["chat_id"], sources
    finally:
        db.close()


def _answer(owner_id, starkllm_chat_id, question):
    # the bridge runs in its own thread: one event loop per question
    return asyncio.run(_answer_async(owner_id, starkllm_chat_id, question))


bridge = tb.TelegramBridge(_answer)


def start_if_enabled():
    if tb.load_state().get("enabled") and tb.load_state().get("token"):
        bridge.start()


def _owned(state: dict, user: models.User) -> bool:
    return not state.get("owner_user_id") or state.get("owner_user_id") == user.id


def _status(state: dict) -> dict:
    pairing = state.get("pairing") or {}
    code_valid = pairing.get("expires", 0) > time.time()
    return {
        "configured": bool(state.get("token")),
        "enabled": bool(state.get("enabled")),
        "running": bridge.running,
        "bot_username": state.get("bot_username"),
        "chats": [{"chat_id": c["chat_id"], "name": c.get("name", "")} for c in state.get("chats", [])],
        "pairing_code": pairing.get("code") if code_valid else None,
        "pairing_expires_in": int(pairing.get("expires", 0) - time.time()) if code_valid else 0,
        "last_error": bridge.last_error,
    }


class TelegramSettings(BaseModel):
    token: Optional[str] = None
    enabled: Optional[bool] = None


@router.get("")
def get_settings(current_user: models.User = Depends(get_current_user)):
    state = tb.load_state()
    if not _owned(state, current_user):
        raise HTTPException(status_code=403, detail="Another user of this PC set up the Telegram bridge.")
    return _status(state)


@router.put("")
def update_settings(body: TelegramSettings, current_user: models.User = Depends(get_current_user)):
    state = tb.load_state()
    if not _owned(state, current_user):
        raise HTTPException(status_code=403, detail="Another user of this PC set up the Telegram bridge.")
    if body.token is not None:
        token = body.token.strip()
        if token:
            try:
                me = bridge.check_token(token)
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"Telegram did not accept this token: {e}")
            if token != state.get("token"):
                state.update({"token": token, "bot_username": me.get("username"), "chats": [], "offset": 0, "wrong_codes": {}})
                state.pop("pairing", None)
        else:  # remove the bot and every pairing
            state = {}
    if body.enabled is not None:
        if body.enabled and not state.get("token"):
            raise HTTPException(status_code=400, detail="Enter the token of your bot first.")
        state["enabled"] = body.enabled
    if state:
        state["owner_user_id"] = current_user.id
    tb.save_state(state)
    if state.get("enabled"):
        bridge.start()
    else:
        bridge.stop()
    return _status(state)


@router.post("/pairing-code")
def create_pairing_code(current_user: models.User = Depends(get_current_user)):
    state = tb.load_state()
    if not _owned(state, current_user):
        raise HTTPException(status_code=403, detail="Another user of this PC set up the Telegram bridge.")
    if not state.get("token"):
        raise HTTPException(status_code=400, detail="Enter the token of your bot first.")
    tb.new_pairing_code(state)
    state["wrong_codes"] = {}
    tb.save_state(state)
    return _status(state)


@router.delete("/chats/{chat_id}")
def unpair(chat_id: int, current_user: models.User = Depends(get_current_user)):
    state = tb.load_state()
    if not _owned(state, current_user):
        raise HTTPException(status_code=403, detail="Another user of this PC set up the Telegram bridge.")
    state["chats"] = [c for c in state.get("chats", []) if c["chat_id"] != chat_id]
    tb.save_state(state)
    return _status(state)
