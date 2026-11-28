"""Shared household workspaces (2.8, option 12; docs/household-design.md).

One account creates a shared workspace ("Our home") and invites other accounts of the same PC by name; an invited
account accepts once. Members see the workspace's letters, inbox, deadlines and cases, add documents, mark deadlines
done and ask questions. The owner removes members and deletes the workspace; a member can only leave. Every action is
recorded with the account that did it ("Marked done by Anna").

What is shared and what is not:

* shared: the workspace's documents (and their search index), the inbox decisions (done, own title, case), the readings
  of ambiguous dates and the "done" marks of deadlines. These rows are kept under the owner's account id with the
  acting account in actor_id, so the inbox and the deadline list read them like the owner's own;
* private to each account, also inside a shared workspace: chats and their messages, chat folders, the memories
  learned from chats, reminders, the knowledge base, and every private workspace.

Keys (with protection at rest on; docs/encryption-design.md):

    PC data key ──HKDF("account-keys")──► wraps each account's own key (account_keys)
    account key of each member            ──► wraps the shared workspace's own data key (workspace_keys, per version)
    workspace data key ──HKDF("files")──► protects the workspace's document files (SLLMENC, key id in the header)

A member who leaves or is removed loses their wrapped copies at once; the workspace key then gets a new version
(wrapped for the remaining members only) and every document file of the workspace is protected again with it
(rekey_files). Old versions are deleted when no file needs them any more.
"""
import base64
import logging
import os
import threading
from datetime import datetime
from typing import Dict, Iterable, List, Optional

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import and_, or_, select

from app.core import crypto
from app.core.protection import ProtectionLocked, on_forget, protection
from app.db import models

logger = logging.getLogger(__name__)

OWNER, MEMBER = "owner", "member"
ACTIVE, INVITED = "active", "invited"

# actions in the activity trail (the interface translates them)
ACTIONS = ("created", "invited", "joined", "declined", "left", "removed", "invitation_withdrawn", "document_added",
           "document_deleted", "marked_done", "marked_new", "edited", "deadline_done", "deadline_open", "date_read",
           "key_created", "key_replaced")


class NoAccess(Exception):
    """The account has no wrapped copy of this workspace key (not a member, or no longer one)."""


class HouseholdError(Exception):
    """A request that cannot be done; code for the interface, message in English."""

    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.status = code, status


# ---------------------------------------------------------------- who sees what (SQL clauses)

def member_workspace_ids(user_id: int):
    """The shared workspaces the account has joined (not the ones it is only invited to)."""
    return select(models.WorkspaceMember.workspace_id).where(models.WorkspaceMember.user_id == user_id,
                                                             models.WorkspaceMember.status == ACTIVE)


def ws_visible(user_id: int):
    """Clause on Workspace: the account's own workspaces and the shared workspaces it has joined."""
    return or_(models.Workspace.user_id == user_id,
               and_(models.Workspace.shared == 1, models.Workspace.id.in_(member_workspace_ids(user_id))))


def chat_visible(user_id: int):
    """Clause on a query of Chat joined with Workspace: the account's own chats in the workspaces it sees. A chat
    without an account (older rows) belongs to the workspace's owner. Chats are never shared."""
    return and_(ws_visible(user_id),
                or_(models.Chat.user_id == user_id,
                    and_(models.Chat.user_id.is_(None), models.Workspace.user_id == user_id)))


def chat_owned(ws: models.Workspace, user_id: int):
    """Clause on Chat within a workspace the account sees: its own chats only."""
    if ws is not None and ws.user_id == user_id:
        return or_(models.Chat.user_id == user_id, models.Chat.user_id.is_(None))
    return models.Chat.user_id == user_id


def folder_owned(ws: models.Workspace, user_id: int):
    if ws is not None and ws.user_id == user_id:
        return or_(models.ChatFolder.user_id == user_id, models.ChatFolder.user_id.is_(None))
    return models.ChatFolder.user_id == user_id


def folder_visible(user_id: int):
    """Clause on a query of ChatFolder joined with Workspace (chat folders are private like chats)."""
    return and_(ws_visible(user_id),
                or_(models.ChatFolder.user_id == user_id,
                    and_(models.ChatFolder.user_id.is_(None), models.Workspace.user_id == user_id)))


def visible_chat_ids(user_id: int):
    return (select(models.Chat.id).join(models.Workspace, models.Chat.workspace_id == models.Workspace.id)
            .where(chat_visible(user_id)))


def shared_document_ids(user_id: int):
    """Documents of the shared workspaces the account sees (as owner or member)."""
    return (select(models.Document.id).join(models.Workspace, models.Document.workspace_id == models.Workspace.id)
            .where(models.Workspace.shared == 1, ws_visible(user_id)))


def decisions_visible(model, user_id: int):
    """Clause on DocumentReview, DateChoice or DeadlineDone: the account's own decisions, and the decisions about the
    documents of the shared workspaces it sees (kept under the owner's id, see decision_owner)."""
    return or_(model.user_id == user_id,
               and_(model.scope == "ws", model.document_id.in_(shared_document_ids(user_id))))


def decision_owner(db, scope: str, document_id: int, user_id: int) -> int:
    """The account id a decision about this document is stored under: the owner's for a document of a shared
    workspace (so every member sees it), else the account's own."""
    if scope != "ws":
        return user_id
    row = (db.query(models.Workspace.user_id, models.Workspace.shared)
           .join(models.Document, models.Document.workspace_id == models.Workspace.id)
           .filter(models.Document.id == document_id).first())
    return row[0] if row and row[1] else user_id


def is_shared_document(db, scope: str, document_id: int) -> bool:
    if scope != "ws":
        return False
    return bool(db.query(models.Workspace.shared).join(models.Document, models.Document.workspace_id == models.Workspace.id)
                .filter(models.Document.id == document_id).scalar())


def workspace_for(db, workspace_id: int, user_id: int) -> Optional[models.Workspace]:
    return db.query(models.Workspace).filter(models.Workspace.id == workspace_id, ws_visible(user_id)).first()


def role(db, ws: models.Workspace, user_id: int) -> Optional[str]:
    if ws is None:
        return None
    if ws.user_id == user_id:
        return OWNER
    if not ws.shared:
        return None
    m = db.query(models.WorkspaceMember).filter_by(workspace_id=ws.id, user_id=user_id, status=ACTIVE).first()
    return MEMBER if m else None


def storage_owner(workspace_id: int, user_id: int) -> int:
    """The account id in the name of a workspace's search index (user_<id>_workspace_<id>): the owner's for a shared
    workspace the account has joined; otherwise the account's own, as before (a workspace the account cannot see
    gives an empty index, never another account's)."""
    from app.db.session import SessionLocal
    if not workspace_id:
        return user_id
    db = SessionLocal()
    try:
        row = db.query(models.Workspace.user_id).filter(models.Workspace.id == workspace_id, ws_visible(user_id)).first()
        return row[0] if row else user_id
    except Exception:
        return user_id
    finally:
        db.close()


def memory_scope(ws: models.Workspace, user_id: int):
    """Where the memories learned from chats are kept: per workspace, and in a shared workspace per account (they
    come from private chats)."""
    if ws is not None and ws.shared:
        return f"shared-{ws.id}-user-{user_id}"
    return ws.id if ws is not None else 0


def active_member_ids(db, workspace_id: int) -> List[int]:
    return [m.user_id for m in db.query(models.WorkspaceMember).filter_by(workspace_id=workspace_id, status=ACTIVE)]


def names(db, ids: Iterable[int]) -> Dict[int, str]:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    return {u.id: u.username for u in db.query(models.User.id, models.User.username).filter(models.User.id.in_(ids))}


# ---------------------------------------------------------------- activity trail

def log(db, workspace_id: int, actor_id: Optional[int], action: str, document_id: int = None, detail: str = None,
        target_id: int = None):
    """Record an action in a shared workspace (no commit; the caller commits with the change itself)."""
    db.add(models.WorkspaceActivity(workspace_id=workspace_id, actor_id=actor_id, action=action, target_id=target_id,
                                    document_id=document_id, detail=detail))


def log_document(db, scope: str, document_id: int, actor_id: int, action: str):
    """Record an action about a document if it belongs to a shared workspace."""
    if scope != "ws":
        return
    row = (db.query(models.Workspace.id, models.Workspace.shared, models.Document.filename)
           .join(models.Document, models.Document.workspace_id == models.Workspace.id)
           .filter(models.Document.id == document_id).first())
    if row and row[1]:
        log(db, row[0], actor_id, action, document_id=document_id, detail=row[2])


def note_document_added(db, doc: models.Document, actor_id: int):
    """After a document was added: record it in a shared workspace (commits)."""
    if db.query(models.Workspace.shared).filter(models.Workspace.id == doc.workspace_id).scalar():
        log(db, doc.workspace_id, actor_id, "document_added", document_id=doc.id, detail=doc.filename)
        db.commit()


def may_delete_document(db, ws: models.Workspace, doc: models.Document, user_id: int) -> bool:
    """In a shared workspace the owner deletes any document, a member only the documents they added."""
    if not ws.shared or ws.user_id == user_id:
        return True
    return doc.added_by == user_id


def activity(db, workspace_id: int, limit: int = 200) -> List[dict]:
    rows = (db.query(models.WorkspaceActivity).filter_by(workspace_id=workspace_id)
            .order_by(models.WorkspaceActivity.created_at.desc(), models.WorkspaceActivity.id.desc()).limit(limit).all())
    who = names(db, [r.actor_id for r in rows] + [r.target_id for r in rows])
    return [{"id": r.id, "action": r.action, "actor": who.get(r.actor_id), "actor_id": r.actor_id,
             "target": who.get(r.target_id), "document_id": r.document_id, "document": r.detail,
             "at": r.created_at.isoformat() if r.created_at else None} for r in rows]


# ---------------------------------------------------------------- membership

def _clean_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise HouseholdError("name_empty", "Please give the workspace a name.")
    return name[:120]


def create_shared(db, owner: models.User, name: str) -> models.Workspace:
    ws = models.Workspace(name=_clean_name(name), user_id=owner.id, shared=1)
    db.add(ws)
    db.flush()
    db.add(models.WorkspaceMember(workspace_id=ws.id, user_id=owner.id, role=OWNER, status=ACTIVE, invited_by=owner.id,
                                  joined_at=datetime.utcnow()))
    log(db, ws.id, owner.id, "created")
    db.flush()
    if protection.enabled:
        ensure_keys(db, ws)
    db.commit()
    db.refresh(ws)
    return ws


def _owned_shared(db, workspace_id: int, user_id: int) -> models.Workspace:
    ws = db.query(models.Workspace).filter_by(id=workspace_id, shared=1).first()
    if ws is None or role(db, ws, user_id) is None:
        raise HouseholdError("not_found", "Workspace not found", 404)
    if ws.user_id != user_id:
        raise HouseholdError("owner_only", "Only the owner of the workspace can do this.", 403)
    return ws


def invite(db, workspace_id: int, owner_id: int, username: str) -> models.WorkspaceMember:
    from sqlalchemy import func
    ws = _owned_shared(db, workspace_id, owner_id)
    wanted = (username or "").strip().lower()
    user = db.query(models.User).filter(func.lower(models.User.username) == wanted).first() if wanted else None
    if user is None:
        raise HouseholdError("no_account", "There is no account with this name on this PC.", 404)
    if user.id == owner_id:
        raise HouseholdError("self", "You are already in this workspace.")
    m = db.query(models.WorkspaceMember).filter_by(workspace_id=ws.id, user_id=user.id).first()
    if m is not None:
        raise HouseholdError("already", "This account is already a member or invited.", 409)
    m = models.WorkspaceMember(workspace_id=ws.id, user_id=user.id, role=MEMBER, status=INVITED, invited_by=owner_id)
    db.add(m)
    log(db, ws.id, owner_id, "invited", target_id=user.id)
    db.commit()
    return m


def invitations(db, user_id: int) -> List[dict]:
    rows = (db.query(models.WorkspaceMember, models.Workspace)
            .join(models.Workspace, models.WorkspaceMember.workspace_id == models.Workspace.id)
            .filter(models.WorkspaceMember.user_id == user_id, models.WorkspaceMember.status == INVITED).all())
    who = names(db, [w.user_id for _m, w in rows] + [m.invited_by for m, _w in rows])
    return [{"workspace_id": w.id, "name": w.name, "owner": who.get(w.user_id), "invited_by": who.get(m.invited_by),
             "invited_at": m.created_at.isoformat() if m.created_at else None} for m, w in rows]


def _invitation(db, workspace_id: int, user_id: int) -> models.WorkspaceMember:
    m = db.query(models.WorkspaceMember).filter_by(workspace_id=workspace_id, user_id=user_id, status=INVITED).first()
    if m is None:
        raise HouseholdError("no_invitation", "There is no invitation to this workspace.", 404)
    return m


def accept(db, workspace_id: int, user_id: int) -> models.Workspace:
    """The invited account accepts (once): from now on it sees the workspace. With protection on, the workspace key
    is wrapped for its account key."""
    m = _invitation(db, workspace_id, user_id)
    ws = db.query(models.Workspace).filter_by(id=workspace_id).first()
    if protection.enabled and protection.key is None:
        raise ProtectionLocked("StarkLLM is locked: the key for your protected data has not been unlocked.")
    m.status, m.joined_at = ACTIVE, datetime.utcnow()
    log(db, workspace_id, user_id, "joined")
    db.flush()
    if protection.enabled:
        ensure_keys(db, ws)
    db.commit()
    return ws


def decline(db, workspace_id: int, user_id: int):
    m = _invitation(db, workspace_id, user_id)
    db.delete(m)
    log(db, workspace_id, user_id, "declined")
    db.commit()


def _forget_member_data(db, ws: models.Workspace, user_id: int):
    """What a member kept privately in the shared workspace goes when they leave: their chats and messages, chat
    folders, memories and reminders. The shared letters and decisions stay with the workspace."""
    chat_ids = [c.id for c in db.query(models.Chat.id).filter(models.Chat.workspace_id == ws.id,
                                                             models.Chat.user_id == user_id)]
    if chat_ids:
        db.query(models.Message).filter(models.Message.chat_id.in_(chat_ids)).delete(synchronize_session=False)
        db.query(models.Chat).filter(models.Chat.id.in_(chat_ids)).delete(synchronize_session=False)
    db.query(models.ChatFolder).filter(models.ChatFolder.workspace_id == ws.id,
                                       models.ChatFolder.user_id == user_id).delete(synchronize_session=False)
    doc_ids = select(models.Document.id).where(models.Document.workspace_id == ws.id)
    db.query(models.DeadlineReminder).filter(models.DeadlineReminder.user_id == user_id,
                                             models.DeadlineReminder.scope == "ws",
                                             models.DeadlineReminder.document_id.in_(doc_ids)).delete(synchronize_session=False)
    try:
        from app.services.memory_service import memory_service
        memory_service.clear_memories(memory_scope(ws, user_id))
    except Exception as e:
        logger.warning("memories of a former member could not be cleared: %s", e)


def remove_member(db, workspace_id: int, actor_id: int, member_id: int) -> dict:
    """The owner removes a member (or withdraws an invitation), or a member leaves (actor_id == member_id). The
    member's wrapped keys are deleted at once and, with protection on, the workspace key is replaced."""
    ws = db.query(models.Workspace).filter_by(id=workspace_id, shared=1).first()
    if ws is None or role(db, ws, actor_id) is None:
        raise HouseholdError("not_found", "Workspace not found", 404)
    leaving = actor_id == member_id
    if leaving and ws.user_id == actor_id:
        raise HouseholdError("owner_cannot_leave", "The owner cannot leave the workspace; delete it instead.")
    if not leaving and ws.user_id != actor_id:
        raise HouseholdError("owner_only", "Only the owner of the workspace can do this.", 403)
    m = db.query(models.WorkspaceMember).filter_by(workspace_id=ws.id, user_id=member_id).first()
    if m is None or m.role == OWNER:
        raise HouseholdError("not_member", "This account is not a member of the workspace.", 404)
    if protection.enabled and protection.key is None and m.status == ACTIVE:
        raise ProtectionLocked("StarkLLM is locked: the key for your protected data has not been unlocked.")
    was_active = m.status == ACTIVE
    db.delete(m)
    db.query(models.WorkspaceKey).filter_by(workspace_id=ws.id, user_id=member_id).delete(synchronize_session=False)
    if was_active:
        _forget_member_data(db, ws, member_id)
    log(db, ws.id, actor_id, "left" if leaving else ("removed" if was_active else "invitation_withdrawn"),
        target_id=None if leaving else member_id)
    db.commit()
    _forget_cache()
    rotated = None
    if was_active and protection.enabled and ws.key_version:
        rotated = rotate_key(db, ws, actor_id)
    return {"removed": member_id, "key_version": rotated}


def purge(db, ws: models.Workspace):
    """Everything of the sharing itself when a workspace is deleted: members, keys, activity, the members' memories.
    (SQLite does not enforce the foreign keys here, and a new workspace may get the same id.)"""
    member_ids = [m.user_id for m in db.query(models.WorkspaceMember).filter_by(workspace_id=ws.id)]
    if ws.shared:
        for uid in set(member_ids) | {ws.user_id}:
            try:
                from app.services.memory_service import memory_service
                memory_service.clear_memories(memory_scope(ws, uid))
            except Exception as e:
                logger.warning("memories could not be cleared: %s", e)
    for model in (models.WorkspaceMember, models.WorkspaceKey, models.WorkspaceActivity):
        db.query(model).filter(model.workspace_id == ws.id).delete(synchronize_session=False)
    _forget_cache()


def overview(db, user_id: int) -> dict:
    """The account's invitations and the shared workspaces it is in, with their members."""
    spaces = (db.query(models.Workspace).filter(models.Workspace.shared == 1, ws_visible(user_id))
              .order_by(models.Workspace.id).all())
    out = []
    for ws in spaces:
        rows = db.query(models.WorkspaceMember).filter_by(workspace_id=ws.id).order_by(models.WorkspaceMember.id).all()
        who = names(db, [r.user_id for r in rows])
        is_owner = ws.user_id == user_id
        members = [{"user_id": r.user_id, "name": who.get(r.user_id), "role": r.role, "status": r.status,
                    "joined_at": r.joined_at.isoformat() if r.joined_at else None}
                   for r in rows if r.status == ACTIVE or is_owner]   # pending invitations: only the owner sees them
        out.append({"id": ws.id, "name": ws.name, "role": OWNER if is_owner else MEMBER,
                    "owner": names(db, [ws.user_id]).get(ws.user_id), "members": members,
                    "protected": bool(protection.enabled and ws.key_version)})
    return {"invitations": invitations(db, user_id), "workspaces": out}


# ---------------------------------------------------------------- keys

def _seal(key: bytes, plain: bytes, aad: str) -> str:
    nonce = os.urandom(12)
    return base64.b64encode(nonce + AESGCM(key).encrypt(nonce, plain, aad.encode())).decode("ascii")


def _open(key: bytes, sealed: str, aad: str) -> bytes:
    try:
        raw = base64.b64decode(sealed.encode("ascii"))
        return AESGCM(key).decrypt(raw[:12], raw[12:], aad.encode())
    except (InvalidTag, ValueError):
        raise crypto.CorruptData("A wrapped key does not open with this key.")


def _account_aad(user_id: int) -> str:
    return f"starkllm/account-key/{user_id}"


def _workspace_aad(workspace_id: int, version: int, user_id: int) -> str:
    return f"starkllm/workspace-key/{workspace_id}/v{version}/user/{user_id}"


def _data_key() -> bytes:
    key = protection.key
    if key is None:
        raise ProtectionLocked("StarkLLM is locked: the key for your protected data has not been unlocked.")
    return key


def account_key(db, user_id: int, create: bool = True) -> Optional[bytes]:
    """The account's own key, unwrapped with the PC's data key. Made on first use. A key wrapped with an earlier data
    key (protection was turned off and on again) cannot be opened: it is replaced, and so are the workspace keys it
    wrapped (they protect nothing any more: turning protection off decrypted every file)."""
    dk = _data_key()
    wrap_key = crypto.derive_key(dk, "account-keys")
    row = db.query(models.AccountKey).filter_by(user_id=user_id).first()
    if row is not None and row.dk_id == crypto.key_id(dk):
        return _open(wrap_key, row.wrapped, _account_aad(user_id))
    if not create:
        return None
    if row is not None:
        db.query(models.WorkspaceKey).filter_by(user_id=user_id).delete(synchronize_session=False)
        db.delete(row)
        db.flush()
    key = crypto.new_key()
    db.add(models.AccountKey(user_id=user_id, dk_id=crypto.key_id(dk), wrapped=_seal(wrap_key, key, _account_aad(user_id))))
    db.flush()
    return key


def wrap_for(db, workspace_id: int, version: int, user_id: int, wdk: bytes):
    """Store the workspace key wrapped with the member's account key."""
    ak = account_key(db, user_id)
    files_id = crypto.key_id(crypto.derive_key(wdk, "files"))
    row = db.query(models.WorkspaceKey).filter_by(workspace_id=workspace_id, version=version, user_id=user_id).first()
    sealed = _seal(ak, wdk, _workspace_aad(workspace_id, version, user_id))
    if row is None:
        db.add(models.WorkspaceKey(workspace_id=workspace_id, version=version, user_id=user_id, key_id=files_id,
                                   wrapped=sealed))
    else:
        row.key_id, row.wrapped = files_id, sealed
    db.flush()


def workspace_key(db, workspace_id: int, version: int, user_id: int) -> bytes:
    """The workspace key as one member opens it: with their own wrapped copy and their own account key. An account
    without a copy (never a member, or removed) gets NoAccess."""
    row = db.query(models.WorkspaceKey).filter_by(workspace_id=workspace_id, version=version, user_id=user_id).first()
    if row is None:
        raise NoAccess("This account has no key for this workspace.")
    ak = account_key(db, user_id, create=False)
    if ak is None:
        raise NoAccess("This account's key was made with another data key.")
    return _open(ak, row.wrapped, _workspace_aad(workspace_id, version, user_id))


def _current_key(db, ws: models.Workspace) -> Optional[bytes]:
    """The current version of the workspace key, opened through any member that has a copy (owner first)."""
    if not ws.key_version:
        return None
    rows = (db.query(models.WorkspaceKey).filter_by(workspace_id=ws.id, version=ws.key_version).all())
    rows.sort(key=lambda r: r.user_id != ws.user_id)
    for row in rows:
        try:
            return workspace_key(db, ws.id, ws.key_version, row.user_id)
        except (NoAccess, crypto.CryptoError):
            continue
    return None


def ensure_keys(db, ws: models.Workspace) -> Optional[int]:
    """With protection on: the shared workspace has a key, wrapped for every active member (made, or completed for a
    member who joined while protection was off). Returns the current version, or None when there is nothing to do.
    Raises ProtectionLocked while the engine is locked. No commit."""
    if not ws or not ws.shared or not protection.writes_protected():
        return None
    members = set(active_member_ids(db, ws.id)) | {ws.user_id}
    for uid in members:
        account_key(db, uid)   # replaces an account key of an earlier data key (and the copies it wrapped)
    wdk = _current_key(db, ws)
    if wdk is None:
        log(db, ws.id, None, "key_replaced" if ws.key_version else "key_created")
        ws.key_version = (ws.key_version or 0) + 1
        wdk = crypto.new_key()
    have = {r.user_id for r in db.query(models.WorkspaceKey).filter_by(workspace_id=ws.id, version=ws.key_version)}
    for uid in members - have:
        wrap_for(db, ws.id, ws.key_version, uid, wdk)
    db.flush()
    return ws.key_version


def rotate_key(db, ws: models.Workspace, actor_id: Optional[int] = None, background: bool = None) -> int:
    """A new version of the workspace key for the remaining members (after a member left or was removed), then every
    document file of the workspace is protected again with it (rekey_files)."""
    _data_key()
    wdk = crypto.new_key()
    ws.key_version = (ws.key_version or 0) + 1
    for uid in set(active_member_ids(db, ws.id)) | {ws.user_id}:
        wrap_for(db, ws.id, ws.key_version, uid, wdk)
    log(db, ws.id, actor_id, "key_replaced")
    db.commit()
    _forget_cache()
    run_in_background = REKEY_IN_BACKGROUND if background is None else background
    if run_in_background:
        _start_rekey(ws.id)
    else:
        rekey_files(ws.id)
    return ws.key_version


REKEY_IN_BACKGROUND = True
_THREADS: List[threading.Thread] = []
_REKEY_LOCK = threading.Lock()


def wait_for_rekeying(timeout: float = 60):
    for t in list(_THREADS):
        t.join(timeout)
        if not t.is_alive():
            _THREADS.remove(t)


def rekey_files(workspace_id: int) -> dict:
    """Protect every document file of the workspace with the current key version. Each file is replaced only after
    its new copy was read back (vault.rekey_file). Older versions are deleted when every file uses the current one;
    a file that could not be done (locked by another program) keeps its old version until the next try."""
    from app.db.session import SessionLocal
    from app.services import vault
    with _REKEY_LOCK:
        db = SessionLocal()
        try:
            ws = db.query(models.Workspace).filter_by(id=workspace_id).first()
            if ws is None or not ws.key_version:
                return {"done": 0, "left": 0}
            wdk = _current_key(db, ws)
            if wdk is None:
                return {"done": 0, "left": 0}
            target = crypto.derive_key(wdk, "files")
            done = left = 0
            for (path,) in db.query(models.Document.filepath).filter(models.Document.workspace_id == ws.id):
                if not path or not os.path.exists(path) or not vault.is_protected(path):
                    continue
                try:
                    if vault.rekey_file(path, target):
                        done += 1
                except (OSError, crypto.CryptoError) as e:
                    left += 1
                    logger.warning("A document of a shared workspace could not get the new key yet: %s", e)
            if left == 0:
                (db.query(models.WorkspaceKey).filter(models.WorkspaceKey.workspace_id == ws.id,
                                                      models.WorkspaceKey.version < ws.key_version)
                 .delete(synchronize_session=False))
                db.commit()
                _forget_cache()
            return {"done": done, "left": left}
        finally:
            db.close()


def files_key_for_write(workspace_id: int) -> Optional[bytes]:
    """The files key for a new document of a shared workspace (None for a private one: the PC's key is used)."""
    from app.db.session import SessionLocal
    db = SessionLocal()
    try:
        ws = db.query(models.Workspace).filter_by(id=workspace_id).first()
        if ws is None or not ws.shared:
            return None
        if ensure_keys(db, ws) is None:
            return None
        db.commit()
        wdk = _current_key(db, ws)
        if wdk is None:
            return None
        files = crypto.derive_key(wdk, "files")
        # documents still on an older key: a replacement that did not finish (crash, a file locked by another
        # program), or documents protected with the PC's key when protection was turned on
        if REKEY_IN_BACKGROUND and ws.id not in _REKEYING and _needs_rekey(db, ws.id, crypto.key_id(files)):
            _start_rekey(ws.id)
        return files
    finally:
        db.close()


_REKEYING = set()


def _needs_rekey(db, workspace_id: int, kid: str) -> bool:
    for (path,) in db.query(models.Document.filepath).filter(models.Document.workspace_id == workspace_id):
        other = crypto.file_key_id(path) if path else ""
        if other and other != kid:
            return True
    return False


def _start_rekey(workspace_id: int):
    def run():
        try:
            rekey_files(workspace_id)
        except Exception as e:
            logger.warning("Replacing the key of a shared workspace's documents stopped: %s", e)
        finally:
            _REKEYING.discard(workspace_id)
    _REKEYING.add(workspace_id)
    t = threading.Thread(target=run, daemon=True, name=f"rekey-{workspace_id}")
    _THREADS.append(t)
    t.start()


_CACHE: Dict[str, bytes] = {}
_CACHE_LOCK = threading.Lock()


@on_forget
def _forget_cache():
    with _CACHE_LOCK:
        _CACHE.clear()


def files_key_by_id(kid: str) -> Optional[bytes]:
    """The files key with this key id (from a document file's header), opened through a member's wrapped copy. Kept
    in memory until the engine is locked or the membership changes."""
    from app.db.session import SessionLocal
    if protection.key is None:
        return None
    with _CACHE_LOCK:
        if kid in _CACHE:
            return _CACHE[kid]
    db = SessionLocal()
    try:
        for row in db.query(models.WorkspaceKey).filter_by(key_id=kid).all():
            try:
                fk = crypto.derive_key(workspace_key(db, row.workspace_id, row.version, row.user_id), "files")
            except (NoAccess, crypto.CryptoError):
                continue
            if crypto.key_id(fk) == kid:
                with _CACHE_LOCK:
                    _CACHE[kid] = fk
                return fk
        return None
    finally:
        db.close()


def file_keys_from_database(db_path: str, data_key: bytes) -> Dict[str, bytes]:
    """{key id: files key} of every shared-workspace key in a database file (the restore test of a backup opens the
    backup's documents with the backup's own data key)."""
    import sqlite3
    out = {}
    con = sqlite3.connect(db_path)
    try:
        try:
            accounts = {uid: (dk_id, wrapped) for uid, dk_id, wrapped in
                        con.execute("SELECT user_id, dk_id, wrapped FROM account_keys")}
            rows = con.execute("SELECT workspace_id, version, user_id, wrapped FROM workspace_keys").fetchall()
        except sqlite3.OperationalError:
            return out
        wrap_key = crypto.derive_key(data_key, "account-keys")
        for ws_id, version, uid, wrapped in rows:
            acc = accounts.get(uid)
            if not acc or acc[0] != crypto.key_id(data_key):
                continue
            try:
                ak = _open(wrap_key, acc[1], _account_aad(uid))
                fk = crypto.derive_key(_open(ak, wrapped, _workspace_aad(ws_id, version, uid)), "files")
            except crypto.CryptoError:
                continue
            out[crypto.key_id(fk)] = fk
    finally:
        con.close()
    return out
