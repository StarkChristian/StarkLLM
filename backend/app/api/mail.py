"""Settings > Letters from e-mail (docs/mail-import.md): IMAP accounts whose attachments become documents.

There is no password in any request or answer of this router except the internal one the desktop app uses: the page
hands the password to the desktop app (Windows key store), and the desktop app gives it to the engine's memory
through /internal/passwords, which only it can call (the token is derived from the engine's secret)."""
import hashlib
import hmac
import json
import re
from datetime import date, datetime
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.core import netguard
from app.core.config import settings
from app.db import models
from app.db.session import get_db
from app.services import mail_import

router = APIRouter()

_HOST = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^\[?[0-9A-Fa-f:.]+\]?$")


def internal_token() -> str:
    return hmac.new(settings.SECRET_KEY.encode(), b"starkllm-mail-secrets", hashlib.sha256).hexdigest()


def _internal(token: Optional[str]) -> None:
    if not token or not hmac.compare_digest(token, internal_token()):
        raise HTTPException(status_code=403, detail="Only the StarkLLM desktop app may do this.")


class AccountIn(BaseModel):
    # no password field on purpose; an unknown field (a password sent here by mistake) is refused
    model_config = ConfigDict(extra="forbid")
    host: str = Field(min_length=1, max_length=253)
    port: int = Field(ge=1, le=65535)
    security: str
    username: str = Field(min_length=1, max_length=320)
    folders: List[str] = Field(default_factory=lambda: ["INBOX"])
    workspace_id: int
    senders: List[str] = Field(default_factory=list)
    subjects: List[str] = Field(default_factory=list)
    interval_minutes: int = mail_import.DEFAULT_INTERVAL
    mark_read: bool = False
    enabled: bool = True


class OlderIn(BaseModel):
    since: date


class PasswordsIn(BaseModel):
    passwords: Dict[str, str]


class ForgetIn(BaseModel):
    ids: Optional[List[int]] = None


def _check_input(db: Session, user: models.User, req: AccountIn) -> None:
    if req.security not in netguard.IMAP_SECURITY:
        raise HTTPException(status_code=400, detail="tls_required")
    host = req.host.strip()
    if "://" in host or "/" in host or not _HOST.match(host):
        raise HTTPException(status_code=400, detail="bad_host")
    if not (mail_import.MIN_INTERVAL <= req.interval_minutes <= mail_import.MAX_INTERVAL):
        raise HTTPException(status_code=400, detail="bad_interval")
    ws = db.query(models.Workspace).filter(models.Workspace.id == req.workspace_id,
                                           models.Workspace.user_id == user.id).first()
    if ws is None:
        raise HTTPException(status_code=404, detail="workspace_missing")


def _apply(acc: models.MailAccount, req: AccountIn) -> None:
    acc.host = req.host.strip().lower()
    acc.port = req.port
    acc.security = req.security
    acc.username = req.username.strip()
    acc.folders = json.dumps(mail_import.clean_list(req.folders, limit=20) or ["INBOX"])
    acc.workspace_id = req.workspace_id
    acc.senders = json.dumps(mail_import.clean_list(req.senders))
    acc.subjects = json.dumps(mail_import.clean_list(req.subjects))
    acc.interval_minutes = req.interval_minutes
    acc.mark_read = bool(req.mark_read)
    acc.enabled = bool(req.enabled)


def _out(acc: models.MailAccount) -> Dict:
    return {
        "id": acc.id, "host": acc.host, "port": acc.port, "security": acc.security, "username": acc.username,
        "folders": mail_import.json_list(acc.folders), "workspace_id": acc.workspace_id,
        "senders": mail_import.json_list(acc.senders), "subjects": mail_import.json_list(acc.subjects),
        "interval_minutes": acc.interval_minutes, "mark_read": bool(acc.mark_read), "enabled": bool(acc.enabled),
        "created_at": acc.created_at.isoformat() + "Z" if acc.created_at else None,
        "last_check_at": acc.last_check_at.isoformat() + "Z" if acc.last_check_at else None,
        "last_error": acc.last_error, "password_saved": mail_import.has_password(acc.id),
        "running": mail_import.is_running(acc.id),
    }


def _own(db: Session, user: models.User, account_id: int) -> models.MailAccount:
    acc = db.query(models.MailAccount).filter(models.MailAccount.id == account_id,
                                              models.MailAccount.user_id == user.id).first()
    if acc is None:
        raise HTTPException(status_code=404, detail="not_found")
    return acc


@router.get("/accounts")
def list_accounts(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    accounts = db.query(models.MailAccount).filter(models.MailAccount.user_id == user.id).order_by(models.MailAccount.id).all()
    return {"accounts": [_out(a) for a in accounts], "offline": netguard.is_offline()}


@router.post("/accounts")
def add_account(req: AccountIn, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    _check_input(db, user, req)
    acc = models.MailAccount(user_id=user.id, created_at=datetime.utcnow(), state="{}")
    _apply(acc, req)
    db.add(acc)
    db.commit()
    db.refresh(acc)
    return _out(acc)


@router.put("/accounts/{account_id}")
def update_account(account_id: int, req: AccountIn, db: Session = Depends(get_db),
                   user: models.User = Depends(get_current_user)):
    acc = _own(db, user, account_id)
    _check_input(db, user, req)
    server_changed = (acc.host, acc.port, acc.username) != (req.host.strip().lower(), req.port, req.username.strip())
    _apply(acc, req)
    if server_changed:
        acc.state = "{}"   # another mailbox: its numbers mean something else
    db.commit()
    return _out(acc)


@router.delete("/accounts/{account_id}")
def delete_account(account_id: int, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    acc = _own(db, user, account_id)
    db.query(models.MailImport).filter(models.MailImport.account_id == acc.id).delete()
    db.delete(acc)
    db.commit()
    mail_import.forget_password(account_id)
    return {"ok": True}


@router.post("/accounts/{account_id}/check")
def check_now(account_id: int, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    acc = _own(db, user, account_id)
    if netguard.is_offline():
        raise HTTPException(status_code=409, detail="offline")
    if not mail_import.has_password(acc.id):
        raise HTTPException(status_code=409, detail="password_missing")
    return {"started": mail_import.start_check(acc.id)}


@router.post("/accounts/{account_id}/import-older")
def import_older(account_id: int, req: OlderIn, db: Session = Depends(get_db),
                 user: models.User = Depends(get_current_user)):
    acc = _own(db, user, account_id)
    if netguard.is_offline():
        raise HTTPException(status_code=409, detail="offline")
    if not mail_import.has_password(acc.id):
        raise HTTPException(status_code=409, detail="password_missing")
    cutoff = (acc.created_at or datetime.utcnow()).date()
    if req.since > cutoff:
        raise HTTPException(status_code=400, detail="bad_date")
    return {"started": mail_import.start_check(acc.id, older_since=req.since)}


@router.get("/accounts/{account_id}/folders")
def folders(account_id: int, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    acc = _own(db, user, account_id)
    try:
        return {"folders": mail_import.list_folders(acc.id)}
    except mail_import.MailCheckError as e:
        raise HTTPException(status_code=409, detail=e.code)


@router.get("/history")
def history(account_id: Optional[int] = None, limit: int = 100, db: Session = Depends(get_db),
            user: models.User = Depends(get_current_user)):
    q = db.query(models.MailImport).filter(models.MailImport.user_id == user.id)
    if account_id is not None:
        q = q.filter(models.MailImport.account_id == account_id)
    rows = q.order_by(models.MailImport.id.desc()).limit(max(1, min(int(limit), 500))).all()
    return {"items": [{
        "id": r.id, "account_id": r.account_id, "at": r.created_at.isoformat() + "Z" if r.created_at else None,
        "outcome": r.outcome, "folder": r.folder, "sender": r.sender, "subject": r.subject,
        "mail_date": r.mail_date.isoformat() + "Z" if r.mail_date else None, "filename": r.filename,
        "document_id": r.document_id, "detail": r.detail, "flagged": bool(r.flagged),
    } for r in rows]}


# --- the desktop app only ---------------------------------------------------------------------------------------
@router.post("/internal/passwords")
def internal_passwords(req: PasswordsIn, db: Session = Depends(get_db), x_starkllm_internal: Optional[str] = Header(None)):
    """The desktop app hands over the passwords from the Windows key store. Kept in memory only. Answers which account
    ids the engine does not know (deleted ones), so the desktop app can forget their passwords too."""
    _internal(x_starkllm_internal)
    known, unknown = [], []
    for key, password in req.passwords.items():
        try:
            account_id = int(key)
        except ValueError:
            continue
        if db.query(models.MailAccount.id).filter(models.MailAccount.id == account_id).first() is None:
            unknown.append(account_id)
            continue
        mail_import.set_password(account_id, password)
        known.append(account_id)
    return {"known": known, "unknown": unknown}


@router.post("/internal/forget")
def internal_forget(req: ForgetIn, x_starkllm_internal: Optional[str] = Header(None)):
    """The desktop app quits or an account was removed: the engine forgets the password(s)."""
    _internal(x_starkllm_internal)
    if req.ids is None:
        mail_import.forget_password(None)
    else:
        for i in req.ids:
            mail_import.forget_password(i)
    return {"ok": True}
