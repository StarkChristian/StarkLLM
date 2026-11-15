"""Protection at rest (B6): status, unlocking, migration with dry run, and the per-user explanation.

The key itself never passes through here except at `unlock`, which only the desktop app may call (it knows the
engine's secret). Everything that changes data needs the instance administrator, like backup and restore."""
import base64
import binascii
import hashlib
import hmac
import logging
import threading
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.api.system import require_admin
from app.core import crypto
from app.core.config import settings
from app.core.protection import protection
from app.db import models
from app.db.session import get_db
from app.services import protection_migration as migration

router = APIRouter()
logger = logging.getLogger(__name__)


def internal_token() -> str:
    """What the desktop app sends to unlock: derived from the engine's secret, which only the app and engine know."""
    return hmac.new(settings.SECRET_KEY.encode(), b"starkllm-protection-unlock", hashlib.sha256).hexdigest()


class UnlockRequest(BaseModel):
    key: str            # base64 of the 32-byte data key


class MigrateRequest(BaseModel):
    direction: Literal["enable", "disable"]


@router.get("/status")
def status(current_user: models.User = Depends(get_current_user)):
    return {**protection.status(), "running": migration._RUN_LOCK.locked()}


@router.post("/unlock")
def unlock(req: UnlockRequest, x_starkllm_internal: Optional[str] = Header(None)):
    if not x_starkllm_internal or not hmac.compare_digest(x_starkllm_internal, internal_token()):
        raise HTTPException(status_code=403, detail="Only the StarkLLM desktop app may unlock the engine.")
    try:
        key = base64.b64decode(req.key, validate=True)
        protection.set_key(key)
    except crypto.WrongKey:
        raise HTTPException(status_code=403, detail="This is not the key your protected data was locked with.")
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail="The key is not valid.")
    return protection.status()


@router.post("/plan")
def plan(req: MigrateRequest, current_user: models.User = Depends(require_admin)):
    """Dry run: what would change, and whether it can run. Changes nothing."""
    return migration.plan(migration.default_targets(), req.direction)


@router.post("/migrate", status_code=202)
def migrate(req: MigrateRequest, current_user: models.User = Depends(require_admin)):
    targets = migration.default_targets()
    checked = migration.plan(targets, req.direction)
    if not checked["ok"]:
        raise HTTPException(status_code=409, detail=" ".join(checked["problems"]))
    if migration._RUN_LOCK.locked():
        raise HTTPException(status_code=409, detail="A migration is already running.")

    def work():
        try:
            migration.run(targets, req.direction)
        except Exception as e:                         # the reason is in the state file the page polls
            logger.error("Protection migration stopped: %s", e)
        finally:
            from app.services.memory_service import memory_service
            memory_service.refresh()

    threading.Thread(target=work, daemon=True).start()
    return {"started": True, "direction": req.direction}


@router.post("/finalize")
def finalize(current_user: models.User = Depends(require_admin)):
    """Delete the encrypted pre-migration copy of the database (after the user checked that everything works)."""
    return {"removed": migration.finalize(migration.default_targets())}


class VectorRequest(BaseModel):
    mode: Literal["secure", "chroma"]


@router.post("/vectors/plan")
def vectors_plan(req: VectorRequest, current_user: models.User = Depends(require_admin)):
    """Dry run for moving the search index to the encrypted index (or back). Changes nothing."""
    return migration.vector_plan(migration.default_targets(), req.mode == "secure")


@router.post("/vectors/migrate", status_code=202)
def vectors_migrate(req: VectorRequest, current_user: models.User = Depends(require_admin)):
    targets = migration.default_targets()
    checked = migration.vector_plan(targets, req.mode == "secure")
    if not checked["ok"]:
        raise HTTPException(status_code=409, detail=" ".join(checked["problems"]))
    if migration._RUN_LOCK.locked():
        raise HTTPException(status_code=409, detail="A migration is already running.")

    def work():
        try:
            migration.run_vectors(targets, req.mode == "secure")
        except Exception as e:                         # the reason is in the state file the page polls
            logger.error("Search index move stopped: %s", e)
        finally:
            from app.services.memory_service import memory_service
            memory_service.refresh()

    threading.Thread(target=work, daemon=True).start()
    return {"started": True, "mode": req.mode}


PROTECTED = ["Documents you add (the original files)", "Chat messages and the sources shown with them",
             "The text of every indexed document and every memory (the search index)",
             "Your profile text, custom instructions, prompt templates, workspace instructions",
             "Titles, senders and cases you set in the inbox",
             "Names and titles: workspaces, folders, chats, document file names, prompt templates"]
PROTECTED_SECURE = ["The search index itself: its numbers, and the file names, pages and paths stored with every piece of text"]
NOT_PROTECTED = ["Names of files in your Knowledge Base folder and of documents added before protection was turned on (the files carry the same names on disk)",
                 "Files in your Knowledge Base folder (they are your own files and stay where they are)",
                 "Anything on your PC while StarkLLM is open and you are signed in to Windows",
                 "Other programs running under your Windows account"]
NOT_PROTECTED_PLAIN_INDEX = ["The numbers the search index uses to find similar text, and the file names, pages and paths "
                             "stored with each piece of text (they show topics, not words). Turn on the encrypted search index to lock them."]
NOT_PROTECTED_SECURE = ["How many pieces of text each search collection holds, and when the search index file last changed"]


@router.get("/summary")
def summary(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """What protection covers for this user, with counts (so the Settings page can say 'your 12 documents')."""
    import os
    from app.services import vault
    paths = (db.query(models.Document.filepath).join(models.Workspace, models.Document.workspace_id == models.Workspace.id)
             .filter(models.Workspace.user_id == current_user.id).all())   # only the path: names are protected too
    files = [p for (p,) in paths if p and os.path.exists(p)]
    messages = db.execute(text(
        "SELECT m.content FROM messages m JOIN chats c ON c.id = m.chat_id JOIN workspaces w ON w.id = c.workspace_id "
        "WHERE w.user_id = :u"), {"u": current_user.id}).fetchall()
    return {
        "enabled": protection.enabled, "locked": protection.locked,
        "documents": {"total": len(files), "protected": sum(1 for f in files if vault.is_protected(f))},
        "messages": {"total": len(messages), "protected": sum(1 for (m,) in messages if crypto.is_token(m))},
        "vector_mode": protection.vector_mode(),
        "protects": PROTECTED + (PROTECTED_SECURE if protection.vector_mode() == "secure" else []),
        "does_not_protect": NOT_PROTECTED[:1] + (NOT_PROTECTED_SECURE if protection.vector_mode() == "secure"
                                                else NOT_PROTECTED_PLAIN_INDEX) + NOT_PROTECTED[1:],
    }
