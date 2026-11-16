"""Encrypted backup and restore (B7). See services/backup_service.py for the file format and the restore test.

Passphrases arrive in the request body over the local connection and are never stored or logged."""
import gc
import logging
import os
import re
import secrets
import shutil
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.api.system import require_admin
from app.core.config import settings
from app.core.protection import ProtectionLocked, protection
from app.db import models
from app.services import backup_service as backups
from app.services import protection_migration as migration
from app.services import vault

router = APIRouter()
logger = logging.getLogger(__name__)

STATUS_FOR_CODE = {"wrong_passphrase": 403, "weak_passphrase": 400, "not_a_backup": 400, "damaged": 400,
                   "mismatch": 400, "newer_version": 400, "busy": 409, "locked": 423, "locked_files": 409,
                   "unreadable": 400}


def _fail(e: backups.BackupError):
    raise HTTPException(status_code=STATUS_FOR_CODE.get(e.code, 400), detail={"code": e.code, "message": e.message})


def _backup_dir() -> str:
    path = os.path.join(vault.temp_dir(), "backups")
    os.makedirs(path, exist_ok=True)
    return path


class CreateRequest(BaseModel):
    passphrase: str


@router.post("/create")
def create(req: CreateRequest, current_user: models.User = Depends(require_admin)):
    """Make an encrypted backup, test it (restore into a temporary folder and compare), and keep it ready to download."""
    from app.services.rag_service import rag_service
    token = secrets.token_hex(16)
    path = os.path.join(_backup_dir(), token + backups.EXTENSION)
    try:
        secure = None
        if protection.vector_mode() == "secure":
            from app.services.secure_index import secure_client
            secure = secure_client()
        report = backups.create_and_test(path, req.passphrase, chroma_client=rag_service.chroma_client, secure_client=secure,
                                         app_version=settings.VERSION, busy_check=lambda: migration._busy_documents(
                                             migration.default_targets()))
    except backups.BackupError as e:
        _fail(e)
    return {"id": token, "filename": "starkllm-" + datetime.now().strftime("%Y-%m-%d_%H-%M") + backups.EXTENSION,
            "report": report}


@router.get("/download/{token}")
def download(token: str, background: BackgroundTasks, filename: Optional[str] = None,
             current_user: models.User = Depends(require_admin)):
    if not re.fullmatch(r"[0-9a-f]{32}", token):
        raise HTTPException(status_code=404, detail="No such backup.")
    path = os.path.join(_backup_dir(), token + backups.EXTENSION)
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="The backup is no longer here. Make a new one.")
    background.add_task(lambda: os.path.exists(path) and os.remove(path))
    name = re.sub(r"[^A-Za-z0-9._-]", "_", filename or "starkllm" + backups.EXTENSION)
    return FileResponse(path, media_type="application/octet-stream", filename=name, background=background)


def _save_upload(file: UploadFile) -> str:
    folder = os.path.join(_backup_dir(), "uploads")
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, secrets.token_hex(8) + backups.EXTENSION)
    with open(path, "wb") as out:
        shutil.copyfileobj(file.file, out)
    return path


@router.post("/verify")
def verify(file: UploadFile = File(...), passphrase: str = Form(...), current_user: models.User = Depends(require_admin)):
    """Restore test of an existing backup file: unpack into a temporary folder and compare. Changes nothing."""
    path = _save_upload(file)
    try:
        return backups.restore_test(path, passphrase)
    except backups.BackupError as e:
        _fail(e)
    finally:
        os.remove(path)


def _release_live_state():
    """Let go of the files that a restore replaces."""
    from app.db.session import engine
    from app.services.memory_service import memory_service
    from app.services.rag_service import rag_service
    from app.services import secure_index
    engine.dispose()
    secure_index.release()
    rag_service.chroma_client = memory_service.chroma_client = memory_service.memory_collection = None
    gc.collect()
    # the stores in the data folder: _reopen_live_state opens the restored one again (others are left alone)
    backups.close_vector_stores(backups.default_paths().root)


def _reopen_live_state(data_key_b64: Optional[str]):
    import base64
    import chromadb
    from app.services.memory_service import memory_service
    from app.services.rag_service import rag_service
    protection._state_cache = None
    protection.clear_key()
    if data_key_b64:
        protection.set_key(base64.b64decode(data_key_b64))
    client = chromadb.PersistentClient(path=settings.CHROMA_PERSIST_DIRECTORY,
                                       settings=chromadb.config.Settings(anonymized_telemetry=False))
    rag_service.chroma_client = memory_service.chroma_client = client
    memory_service.refresh()


@router.post("/restore")
def restore(file: UploadFile = File(...), passphrase: str = Form(...), current_user: models.User = Depends(require_admin)):
    """Test the backup, then put it in place. A backup that fails the test is refused and nothing changes.
    The current data is kept in data/restore-undo until the user discards it."""
    path = _save_upload(file)
    try:
        report = backups.stage_restore(path, passphrase)
    except backups.BackupError as e:
        _fail(e)
    finally:
        os.remove(path)
    staged_key = backups.staged_data_key()
    _release_live_state()
    applied = None
    try:
        applied = backups.apply_pending_restore()
    except backups.BackupError as e:
        if e.code != "locked_files":
            raise
    finally:
        _reopen_live_state(applied.get("data_key") if applied else None)
    if applied is None:
        return {"restored": False, "pending": True, "report": report, "data_key": staged_key,
                "message": "Close StarkLLM completely and open it again to finish the restore."}
    return {"restored": True, "pending": False, "report": report, "data_key": staged_key,
            "protected": protection.enabled}


@router.get("/status")
def status(current_user: models.User = Depends(require_admin)):
    paths = backups.default_paths()
    return {"pending_restore": backups.pending_restore(paths), "undo_available": os.path.isdir(paths.undo)}


@router.post("/discard-undo")
def discard_undo(current_user: models.User = Depends(require_admin)):
    """Delete the copy of the data that a restore replaced (after the user checked the restored data)."""
    return {"removed": backups.discard_undo()}
