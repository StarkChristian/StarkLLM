"""Letters from e-mail (StarkLLM 2.8): the attachments of new mails become documents of a workspace.

The rules (docs/mail-import.md), each one covered by backend/tests/test_mail_import.py:

* only attachments (PDF, pictures, Word) are kept, with sender, subject and date as metadata in the import history;
  the text of a mail is never stored;
* only mails that arrived after the account was added; older ones only after "Import older messages";
* read-only on the mail server: the folder is opened with EXAMINE and mails are read with BODY.PEEK, so nothing
  changes there. No STORE, EXPUNGE, MOVE, COPY, APPEND or DELETE. The one exception is the user's own switch "mark
  imported mails as read" (off by default): then the folder is opened with SELECT and \\Seen is set on a mail whose
  attachments were imported, nothing else. Nothing is ever sent;
* the password lives in the Windows key store of the desktop app (desktop/mail-secrets.js); the engine gets it in
  memory (set_password) and never writes it to the database, a file or a log;
* the connection goes through app.core.netguard (feature "mail_import", TLS only) and nothing is checked while
  "Fully offline" is on;
* every attachment goes through the normal upload pipeline (documents.store_document_bytes): protection at rest, the
  duplicate check by content hash, reading with OCR, facts and the checks for scams and for notes to the AI;
* sender and subject are untrusted text: they are shown in Settings and never given to a model.
"""
import email
import json
import logging
import os
import re
import threading
from datetime import date, datetime, timedelta, timezone
from email import policy
from email.utils import parseaddr, parsedate_to_datetime
from typing import Dict, Iterator, List, Optional, Tuple

from app.core import netguard
from app.services import untrusted

logger = logging.getLogger(__name__)

# what is imported: PDF, pictures and Word, the same types the upload accepts for them
ATTACHMENT_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".docx"}
MIME_EXTENSIONS = {
    "application/pdf": ".pdf", "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/webp": ".webp",
    "image/tiff": ".tif",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
}
MAX_MAIL_BYTES = 60 * 1024 * 1024       # a bigger mail is listed as skipped instead of being downloaded
MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024  # the upload limit
MAX_MAILS_PER_RUN = 200                 # per folder and check; the next check goes on where this one stopped
DEFAULT_INTERVAL = 15
MIN_INTERVAL = 5
MAX_INTERVAL = 24 * 60
TICK_SECONDS = 60
FIRST_TICK_SECONDS = 90                 # after the start: the first answers and the unlock come first

# the commands that would change the mailbox; none of them is ever sent (STORE only with the user's switch)
WRITING_COMMANDS = ("STORE", "EXPUNGE", "MOVE", "COPY", "APPEND", "DELETE", "RENAME", "CREATE", "UID EXPUNGE")

_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# ---------------------------------------------------------------------------------------------------------------
# passwords: in memory only
# ---------------------------------------------------------------------------------------------------------------
_passwords: Dict[int, str] = {}
_pw_lock = threading.Lock()


def set_password(account_id: int, password: str) -> None:
    """Called by the desktop app (internal endpoint) with the password from the Windows key store."""
    with _pw_lock:
        if password:
            _passwords[int(account_id)] = str(password)
        else:
            _passwords.pop(int(account_id), None)


def forget_password(account_id: Optional[int] = None) -> None:
    with _pw_lock:
        if account_id is None:
            _passwords.clear()
        else:
            _passwords.pop(int(account_id), None)


def has_password(account_id: int) -> bool:
    with _pw_lock:
        return int(account_id) in _passwords


def _password(account_id: int) -> Optional[str]:
    with _pw_lock:
        return _passwords.get(int(account_id))


# ---------------------------------------------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------------------------------------------
class MailCheckError(Exception):
    """A check that could not run. `code` is what Settings translates; there is never server text or a password in it."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def json_list(value) -> List[str]:
    try:
        data = json.loads(value or "[]")
    except (TypeError, ValueError):
        return []
    return [str(x) for x in data if str(x).strip()] if isinstance(data, list) else []


def clean_list(values, limit: int = 50, length: int = 200) -> List[str]:
    out = []
    for v in values or []:
        v = clean_text(str(v), length)
        if v and v not in out:
            out.append(v)
    return out[:limit]


def clean_text(value: Optional[str], limit: int = 300) -> str:
    """Untrusted header text for showing: invisible and control characters removed, one line, shortened."""
    if not value:
        return ""
    text, _ = untrusted.strip_invisible(str(value))
    text = re.sub(r"[\x00-\x1f\x7f-\x9f]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()[:limit]


def _imap_date(d: date) -> str:
    return f"{d.day:02d}-{_MONTHS[d.month - 1]}-{d.year}"   # not strftime: the month name must not follow the locale


def _quote_mailbox(name: str) -> str:
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _meta_and_literal(data) -> Tuple[bytes, bytes]:
    """The FETCH answer of the IMAP library: tuples (meta, literal) and plain bytes. All meta text joined, and the first literal."""
    meta, literal = [], b""
    for part in data or []:
        if isinstance(part, tuple):
            meta.append(part[0] or b"")
            if not literal and len(part) > 1 and part[1]:
                literal = part[1]
        elif isinstance(part, (bytes, bytearray)):
            meta.append(bytes(part))
    return b" ".join(meta), literal


def _internaldate(meta: bytes) -> Optional[datetime]:
    m = re.search(rb'INTERNALDATE "([^"]+)"', meta or b"")
    if not m:
        return None
    try:
        return datetime.strptime(m.group(1).decode().strip(), "%d-%b-%Y %H:%M:%S %z").astimezone(timezone.utc).replace(tzinfo=None)
    except ValueError:
        return None


def _size(meta: bytes) -> int:
    m = re.search(rb"RFC822\.SIZE (\d+)", meta or b"")
    return int(m.group(1)) if m else 0


def _header_date(value) -> Optional[datetime]:
    try:
        d = parsedate_to_datetime(str(value))
    except (TypeError, ValueError, IndexError):
        return None
    if d is None:
        return None
    return d.astimezone(timezone.utc).replace(tzinfo=None) if d.tzinfo else d


def passes_filter(sender: str, subject: str, senders: List[str], subjects: List[str]) -> bool:
    """No filter: every mail. Otherwise a mail passes when its sender is one of the allowed senders (a full address,
    or a domain written as "@example.org" or "example.org") or its subject contains one of the allowed words."""
    if not senders and not subjects:
        return True
    addr = parseaddr(sender or "")[1].lower().strip()
    for s in senders:
        s = s.strip().lower()
        if not s:
            continue
        if "@" in s and not s.startswith("@"):
            if addr == s:
                return True
        else:
            domain = s.lstrip("@")
            if addr.endswith("@" + domain) or addr.endswith("." + domain):
                return True
    low = (subject or "").lower()
    return any(w.strip() and w.strip().lower() in low for w in subjects)


def safe_filename(name: Optional[str], ext: str, when: Optional[datetime]) -> str:
    base = clean_text(name or "", 150)
    base = base.replace("\\", "/").split("/")[-1].strip(" .")
    base = re.sub(r'[<>:"|?*]', "_", base)
    if not base:
        base = f"mail-attachment-{(when or datetime.utcnow()).strftime('%Y-%m-%d')}{ext}"
    if not base.lower().endswith(ext) and os.path.splitext(base)[1].lower() not in ATTACHMENT_EXTENSIONS:
        base += ext
    return base[:160]


def _leaves(part, in_related: bool = False):
    if part.is_multipart():
        related = in_related or part.get_content_subtype() == "related"
        for sub in part.iter_parts():
            yield from _leaves(sub, related)
    else:
        yield part, in_related


def attachments(msg) -> Iterator[Tuple[str, str, bytes]]:
    """(file name, extension, bytes) of every PDF, picture and Word file of a mail. The text of the mail, pictures that
    belong to the text (with a Content-ID in the HTML of the mail, or inline: logos, signatures) and other types are
    left out."""
    for part, in_related in _leaves(msg):
        disposition = part.get_content_disposition()
        try:
            name = part.get_filename()
        except Exception:
            name = None
        ctype = (part.get_content_type() or "").lower()
        ext = os.path.splitext(name or "")[1].lower()
        if ext not in ATTACHMENT_EXTENSIONS:
            ext = MIME_EXTENSIONS.get(ctype, "") if not name or ext in ("", ".bin") else ""
        if ext not in ATTACHMENT_EXTENSIONS:
            continue
        if ext not in (".pdf", ".docx") and part.get("Content-ID") and (in_related or disposition != "attachment"):
            continue              # a picture inside the text of the mail (logo, signature)
        if disposition != "attachment" and not name and ext not in (".pdf", ".docx"):
            continue              # a picture without a name is part of the text of the mail
        try:
            payload = part.get_payload(decode=True)
        except Exception:
            payload = None
        if not payload:
            continue
        yield name or "", ext, payload


def _looks_right(ext: str, data: bytes) -> bool:
    head = data[:1024]
    if ext == ".pdf":
        return b"%PDF" in head
    if ext == ".docx":
        return head.startswith(b"PK")
    if ext == ".png":
        return head.startswith(b"\x89PNG")
    if ext in (".jpg", ".jpeg"):
        return head.startswith(b"\xff\xd8")
    if ext in (".tif", ".tiff"):
        return head[:4] in (b"II*\x00", b"MM\x00*")
    if ext == ".webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    return False


class ReadOnlyMailbox:
    """The only way this module talks to the server. It lets through what reads; STORE only with the user's switch
    and only \\Seen. Anything else that would change the mailbox raises before it is sent."""

    def __init__(self, conn, allow_mark_read: bool):
        self._c = conn
        self._mark = bool(allow_mark_read)

    def login(self, user: str, password: str):
        return self._c.login(user, password)

    def list(self):
        return self._c.list()

    def open(self, folder: str):
        # EXAMINE (read-only) unless the user asked to mark imported mails as read
        return self._c.select(_quote_mailbox(folder), readonly=not self._mark)

    def uidvalidity(self) -> str:
        try:
            typ, data = self._c.response("UIDVALIDITY")
            if data and data[0]:
                return (data[0].decode() if isinstance(data[0], bytes) else str(data[0])).strip()
        except Exception:
            pass
        return ""

    def search(self, *criteria):
        return self._c.uid("SEARCH", *criteria)

    def fetch(self, uid: int, items: str):
        up = items.upper()
        if "BODY[" in up.replace("BODY.PEEK[", "") or re.search(r"RFC822(?!\.SIZE|\.HEADER)", up):
            raise PermissionError("only BODY.PEEK may be used: BODY[] or RFC822 would mark the mail as read")
        return self._c.uid("FETCH", str(uid), items)

    def mark_seen(self, uid: int):
        if not self._mark:
            raise PermissionError("marking mails as read is off")
        return self._c.uid("STORE", str(uid), "+FLAGS.SILENT", "(\\Seen)")


# ---------------------------------------------------------------------------------------------------------------
# a check
# ---------------------------------------------------------------------------------------------------------------
_run_locks: Dict[int, threading.Lock] = {}
_run_locks_guard = threading.Lock()
_running: Dict[int, str] = {}   # account id -> "new" or "older"


def _lock_for(account_id: int) -> threading.Lock:
    with _run_locks_guard:
        return _run_locks.setdefault(int(account_id), threading.Lock())


def is_running(account_id: int) -> bool:
    return int(account_id) in _running


def _store(db, account, *, outcome: str, folder: str = "", sender: str = "", subject: str = "",
           mail_date: Optional[datetime] = None, filename: str = "", sha256: str = "", document_id=None,
           detail: str = "", flagged: bool = False):
    from app.db import models
    db.add(models.MailImport(account_id=account.id, user_id=account.user_id, outcome=outcome, folder=folder or None,
                             sender=sender or None, subject=subject or None, mail_date=mail_date,
                             filename=filename or None, sha256=sha256 or None, document_id=document_id,
                             detail=detail or None, flagged=bool(flagged)))
    db.commit()


def _error_code(exc: BaseException, stage: str) -> str:
    import ssl
    import socket
    if isinstance(exc, MailCheckError):
        return exc.code
    if isinstance(exc, netguard.OfflineBlocked):
        return "offline"
    if isinstance(exc, netguard.PlainTextRefused):
        return "tls_required"
    if isinstance(exc, ssl.SSLError):     # also a wrong or self-made certificate
        return "tls_failed"
    from app.core.protection import ProtectionLocked
    if isinstance(exc, ProtectionLocked):
        return "locked"
    if type(exc).__module__.startswith("imap") or type(exc).__name__ in ("error", "abort", "readonly"):
        return "login_failed" if stage == "login" else ("folder_failed" if stage == "folder" else "server_error")
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return "timeout"
    if isinstance(exc, OSError):
        return "unreachable"
    return "failed"


def run_check(account_id: int, *, older_since: Optional[date] = None, connect=None) -> Dict:
    """One check of one account: new mails (or, with older_since, the mails from that day until the account was added).
    Returns {"ok", "imported", "duplicates", "skipped", "error"}. Never raises for a mail problem."""
    lock = _lock_for(account_id)
    if not lock.acquire(blocking=False):
        return {"ok": False, "error": "busy"}
    _running[int(account_id)] = "older" if older_since else "new"
    try:
        return _run_check(account_id, older_since, connect or netguard.imap)
    finally:
        _running.pop(int(account_id), None)
        lock.release()


def _run_check(account_id: int, older_since: Optional[date], connect) -> Dict:
    from app.db import models
    from app.db.session import SessionLocal
    summary = {"ok": False, "imported": 0, "duplicates": 0, "skipped": 0, "error": None}
    db = SessionLocal()
    stage = "start"
    password = None
    try:
        account = db.query(models.MailAccount).filter(models.MailAccount.id == account_id).first()
        if account is None:
            summary["error"] = "not_found"
            return summary
        try:
            if netguard.is_offline():
                raise MailCheckError("offline")      # nothing is checked while offline, also not on this PC
            password = _password(account.id)
            if not password:
                raise MailCheckError("password_missing")
            ws = db.query(models.Workspace).filter(models.Workspace.id == account.workspace_id,
                                                   models.Workspace.user_id == account.user_id).first()
            if ws is None:
                raise MailCheckError("workspace_missing")
            state = {}
            try:
                state = json.loads(account.state or "{}") or {}
            except (TypeError, ValueError):
                state = {}
            stage = "connect"
            with connect(account.host, int(account.port), security=account.security, feature="mail_import") as conn:
                box = ReadOnlyMailbox(conn, account.mark_read)
                stage = "login"
                box.login(account.username, password)
                for folder in json_list(account.folders) or ["INBOX"]:
                    stage = "folder"
                    _check_folder(db, account, box, folder, state, older_since, summary)
                    stage = "read"
            if not older_since:
                account.state = json.dumps(state)
            account.last_error = None
            summary["ok"] = True
        except Exception as e:  # noqa: BLE001 - every failure becomes a line in the history, the engine goes on
            code = _error_code(e, stage)
            summary["error"] = code
            if code != "offline":
                # the class of the error only: server text could quote what was sent
                logger.info("mail import: check of account %s failed at %s: %s (%s)", account_id, stage, code,
                            type(e).__name__)
            db.rollback()
            account.last_error = code
            try:
                _store(db, account, outcome="error", detail=code)
            except Exception:
                db.rollback()
                account.last_error = code
        account.last_check_at = datetime.utcnow()
        db.commit()
        return summary
    finally:
        password = None
        db.close()


def _check_folder(db, account, box: ReadOnlyMailbox, folder: str, state: Dict, older_since: Optional[date], summary: Dict):
    typ, _ = box.open(folder)
    if typ != "OK":
        raise MailCheckError("folder_failed")
    validity = box.uidvalidity()
    known = state.get(folder) if isinstance(state.get(folder), dict) else {}
    last_uid = int(known.get("last_uid") or 0) if known.get("uidvalidity") == validity else 0
    cutoff = account.created_at or datetime.utcnow()
    since = older_since or cutoff.date()
    criteria = ["SINCE", _imap_date(since)]
    if older_since:
        criteria += ["BEFORE", _imap_date(cutoff.date() + timedelta(days=1))]
    elif last_uid:
        criteria = ["UID", f"{last_uid + 1}:*"] + criteria
    typ, data = box.search(*criteria)
    if typ != "OK":
        raise MailCheckError("server_error")
    uids = sorted({int(x) for x in (data[0] or b"").split() if x.isdigit()}) if data else []
    if not older_since:
        uids = [u for u in uids if u > last_uid]
    for uid in uids[:MAX_MAILS_PER_RUN]:
        _check_mail(db, account, box, folder, uid, cutoff, older_since, summary)
        if not older_since:
            # remembered after every mail, so a check that breaks off does not read the same mails again
            state[folder] = {"uidvalidity": validity, "last_uid": max(uid, last_uid)}
            account.state = json.dumps(state)
            db.commit()
    if not older_since and folder not in state:
        state[folder] = {"uidvalidity": validity, "last_uid": last_uid}


def _check_mail(db, account, box: ReadOnlyMailbox, folder: str, uid: int, cutoff: datetime,
                older_since: Optional[date], summary: Dict):
    from app.api import documents as docs_api
    typ, data = box.fetch(uid, "(INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])")
    if typ != "OK":
        return
    meta, header = _meta_and_literal(data)
    arrived = _internaldate(meta)
    if arrived is not None:
        if not older_since and arrived < cutoff:
            return            # older than the account: only with "Import older messages"
        if older_since and arrived >= cutoff:
            return            # the normal checks take care of it
    try:
        head = email.message_from_bytes(header or b"", policy=policy.default)
        sender = clean_text(str(head.get("From") or ""), 200)
        subject = clean_text(str(head.get("Subject") or ""), 300)
        mail_date = _header_date(head.get("Date")) or arrived
    except Exception:
        sender, subject, mail_date = "", "", arrived
    if not passes_filter(sender, subject, json_list(account.senders), json_list(account.subjects)):
        return
    flagged = bool(untrusted.addressed_to_ai(sender) or untrusted.addressed_to_ai(subject))
    meta_row = dict(folder=folder, sender=sender, subject=subject, mail_date=mail_date, flagged=flagged)
    size = _size(meta)
    if size > MAX_MAIL_BYTES:
        summary["skipped"] += 1
        _store(db, account, outcome="skipped", detail="too_large", **meta_row)
        return
    typ, data = box.fetch(uid, "(BODY.PEEK[])")
    if typ != "OK":
        return
    _, raw = _meta_and_literal(data)
    msg = email.message_from_bytes(raw or b"", policy=policy.default)
    raw = None                # the mail itself is never kept: only the attachments below
    imported_any = False
    for name, ext, payload in attachments(msg):
        filename = safe_filename(name, ext, mail_date)
        if len(payload) > MAX_ATTACHMENT_BYTES:
            summary["skipped"] += 1
            _store(db, account, outcome="skipped", filename=filename, detail="too_large", **meta_row)
            continue
        if not _looks_right(ext, payload):
            summary["skipped"] += 1
            _store(db, account, outcome="skipped", filename=filename, detail="wrong_type", **meta_row)
            continue
        import hashlib
        digest = hashlib.sha256(payload).hexdigest()
        doc, duplicate = docs_api.store_document_bytes(db, account.workspace_id, account.user_id, filename, payload)
        if duplicate:
            summary["duplicates"] += 1
        else:
            summary["imported"] += 1
            imported_any = True
        _store(db, account, outcome="duplicate" if duplicate else "imported", filename=filename, sha256=digest,
               document_id=doc.id, **meta_row)
    if imported_any and account.mark_read:
        box.mark_seen(uid)


# ---------------------------------------------------------------------------------------------------------------
# folders (Settings: which ones to watch)
# ---------------------------------------------------------------------------------------------------------------
_LIST_LINE = re.compile(rb'\((?P<flags>[^)]*)\) (?P<sep>"[^"]*"|NIL) (?P<name>.+)$')


def list_folders(account_id: int, connect=None) -> List[str]:
    from app.db import models
    from app.db.session import SessionLocal
    if netguard.is_offline():
        raise MailCheckError("offline")
    db = SessionLocal()
    try:
        account = db.query(models.MailAccount).filter(models.MailAccount.id == account_id).first()
        if account is None:
            raise MailCheckError("not_found")
        password = _password(account.id)
        if not password:
            raise MailCheckError("password_missing")
        host, port, security, user = account.host, int(account.port), account.security, account.username
    finally:
        db.close()
    stage = "connect"
    try:
        with (connect or netguard.imap)(host, port, security=security, feature="mail_import") as conn:
            box = ReadOnlyMailbox(conn, False)
            stage = "login"
            box.login(user, password)
            stage = "read"
            typ, data = box.list()
    except MailCheckError:
        raise
    except Exception as e:  # noqa: BLE001
        raise MailCheckError(_error_code(e, stage))
    finally:
        password = None
    names = []
    for line in data or []:
        if isinstance(line, tuple):
            line = b" ".join(x for x in line if isinstance(x, bytes))
        m = _LIST_LINE.match(line or b"")
        if not m or b"\\Noselect" in m.group("flags"):
            continue
        name = m.group("name").strip()
        if name.startswith(b'"') and name.endswith(b'"'):
            name = name[1:-1].replace(b'\\"', b'"').replace(b"\\\\", b"\\")
        names.append(name.decode("utf-8", "replace"))
    return names


# ---------------------------------------------------------------------------------------------------------------
# the schedule: every N minutes per account, only while the engine (and so StarkLLM) runs
# ---------------------------------------------------------------------------------------------------------------
_stop = threading.Event()
_thread: Optional[threading.Thread] = None


def due_accounts(now: Optional[datetime] = None) -> List[int]:
    from app.db import models
    from app.db.session import SessionLocal
    if netguard.is_offline():
        return []
    now = now or datetime.utcnow()
    db = SessionLocal()
    try:
        out = []
        for acc in db.query(models.MailAccount).filter(models.MailAccount.enabled.is_(True)).all():
            if not has_password(acc.id) or is_running(acc.id):
                continue
            every = max(MIN_INTERVAL, min(MAX_INTERVAL, int(acc.interval_minutes or DEFAULT_INTERVAL)))
            if acc.last_check_at is None or now - acc.last_check_at >= timedelta(minutes=every):
                out.append(acc.id)
        return out
    finally:
        db.close()


def check_due(now: Optional[datetime] = None) -> int:
    n = 0
    for account_id in due_accounts(now):
        if _stop.is_set():
            break
        run_check(account_id)
        n += 1
    return n


def _loop():
    if _stop.wait(FIRST_TICK_SECONDS):
        return
    while not _stop.is_set():
        try:
            check_due()
        except Exception as e:  # noqa: BLE001 - the schedule must keep running
            logger.warning("mail import: scheduled check failed: %s", type(e).__name__)
        if _stop.wait(TICK_SECONDS):
            return


def start() -> None:
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="mail-import", daemon=True)
    _thread.start()


def stop() -> None:
    _stop.set()


def start_check(account_id: int, older_since: Optional[date] = None) -> bool:
    """"Check now" and "Import older messages": the check runs in the background; Settings asks for the result."""
    with _run_locks_guard:
        if is_running(account_id):
            return False
        _running[int(account_id)] = "starting"   # shown as running from now on, not only once the thread started

    def job():
        try:
            run_check(account_id, older_since=older_since)
        finally:
            _running.pop(int(account_id), None)

    threading.Thread(target=job, name=f"mail-import-{account_id}", daemon=True).start()
    return True
