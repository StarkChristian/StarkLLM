"""Shared household workspaces (2.8, option 12; docs/household-design.md): an invitation accepted once, members see the
shared letters and never another account's private ones, a member who leaves or is removed loses access, the
workspace's own key wrapped per member (and replaced when a member goes), who did what, and private chats."""
import os
import uuid
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.api import auth
from app.api.auth import create_access_token, get_password_hash
from app.core import crypto
from app.core.protection import protection
from app.db import models
from app.db.session import SessionLocal, engine
from app.main import app
from app.services import household, vault
from app.services.rag_service import rag_service

client = TestClient(app)
API = "/api/v1"
SOON = (date.today() + timedelta(days=9)).strftime("%d.%m.%Y")

BILL = f"""Stadtwerke Rheinstadt
Datum: 06.11.2026
Kundennummer: 4400-118-27
Zahlungserinnerung
Bitte überweisen Sie 96,00 EUR bis zum {SOON}."""

PRIVATE = f"""Praxis Dr. Sommer
Datum: 04.11.2026
Ihr Befund vom 02.11.2026
Bitte zahlen Sie 48,00 EUR bis zum {SOON}. Diagnose: vertraulich."""


# ---------------------------------------------------------------- helpers

def _account(prefix="anna"):
    name = f"{prefix}_{uuid.uuid4().hex[:6]}"
    db = SessionLocal()
    try:
        user = models.User(username=name, hashed_password=get_password_hash("x" * 12))
        db.add(user)
        db.commit()
        uid = user.id
    finally:
        db.close()
    return type("Account", (), {"id": uid, "name": name,
                                "h": {"Authorization": f"Bearer {create_access_token({'sub': name})}"}})


def _private_workspace(owner, name="Privat"):
    db = SessionLocal()
    try:
        ws = models.Workspace(name=name, user_id=owner.id)
        db.add(ws)
        db.commit()
        return ws.id
    finally:
        db.close()


def _letter(tmp_path, ws_id, by, filename, body):
    """An indexed letter in a workspace (the vector index of the workspace, as the upload would fill it)."""
    path = tmp_path / f"{uuid.uuid4().hex[:6]}_{filename}"
    path.write_bytes(b"%PDF")
    db = SessionLocal()
    try:
        doc = models.Document(workspace_id=ws_id, filename=filename, filepath=str(path), file_type="pdf",
                              status="indexed", added_by=by.id)
        db.add(doc)
        db.commit()
        doc_id = doc.id
    finally:
        db.close()
    rag_service.get_or_create_collection(ws_id, by.id).add(
        ids=[uuid.uuid4().hex], documents=[body], metadatas=[{"source": str(path), "page": 0, "chunk": 1}],
        embeddings=[[1.0, 0.0]])
    return doc_id


def _shared(owner, name="Our home"):
    r = client.post(f"{API}/household/workspaces", json={"name": name}, headers=owner.h)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _join(ws_id, owner, member):
    assert client.post(f"{API}/household/workspaces/{ws_id}/invite", json={"username": member.name},
                       headers=owner.h).status_code == 200
    assert client.post(f"{API}/household/invitations/{ws_id}/accept", headers=member.h).status_code == 200


def _ws_ids(acc):
    return {w["id"] for w in client.get(f"{API}/workspaces/", headers=acc.h).json()}


def _inbox_names(acc):
    return {d["filename"] for d in client.get(f"{API}/dashboard/inbox", headers=acc.h).json()["documents"]}


def _deadline(acc, filename):
    body = client.get(f"{API}/dashboard/deadlines", headers=acc.h).json()
    return next((d for d in body["deadlines"] if any(s["filename"] == filename for s in d["sources"])), None)


def _actions(ws_id, acc):
    r = client.get(f"{API}/household/workspaces/{ws_id}/activity", headers=acc.h)
    assert r.status_code == 200, r.text
    return [(a["action"], a["actor"], a.get("target"), a.get("document")) for a in r.json()["activity"]]


# ---------------------------------------------------------------- invitation and acceptance

def test_invite_by_name_and_accept_once():
    anna, ben, carl = _account("anna"), _account("ben"), _account("carl")
    ws = _shared(anna, "Our home")
    assert ws in _ws_ids(anna)

    # the owner invites by the account name (case and spaces do not matter); the invited account sees nothing yet
    r = client.post(f"{API}/household/workspaces/{ws}/invite", json={"username": f"  {ben.name.upper()} "}, headers=anna.h)
    assert r.status_code == 200 and r.json()["status"] == "invited"
    assert ws not in _ws_ids(ben)
    assert client.get(f"{API}/documents/{ws}", headers=ben.h).status_code == 404
    invitations = client.get(f"{API}/household", headers=ben.h).json()["invitations"]
    assert [(i["workspace_id"], i["name"], i["owner"]) for i in invitations] == [(ws, "Our home", anna.name)]

    # an unknown name, oneself, twice, and a non-owner inviting are refused
    assert client.post(f"{API}/household/workspaces/{ws}/invite", json={"username": "nobody_here"},
                       headers=anna.h).json()["detail"]["code"] == "no_account"
    assert client.post(f"{API}/household/workspaces/{ws}/invite", json={"username": anna.name},
                       headers=anna.h).status_code == 400
    assert client.post(f"{API}/household/workspaces/{ws}/invite", json={"username": ben.name},
                       headers=anna.h).status_code == 409
    assert client.post(f"{API}/household/workspaces/{ws}/invite", json={"username": carl.name},
                       headers=ben.h).status_code == 404       # not a member yet: the workspace does not exist for Ben

    # accepted once: now Ben is a member; a second accept finds no invitation
    assert client.post(f"{API}/household/invitations/{ws}/accept", headers=ben.h).status_code == 200
    assert client.post(f"{API}/household/invitations/{ws}/accept", headers=ben.h).status_code == 404
    mine = {w["id"]: w for w in client.get(f"{API}/workspaces/", headers=ben.h).json()}
    assert mine[ws]["shared"] is True and mine[ws]["role"] == "member" and mine[ws]["owner"] == anna.name
    assert client.get(f"{API}/household", headers=ben.h).json()["invitations"] == []
    members = next(w for w in client.get(f"{API}/household", headers=anna.h).json()["workspaces"] if w["id"] == ws)["members"]
    assert {(m["name"], m["role"], m["status"]) for m in members} == {(anna.name, "owner", "active"), (ben.name, "member", "active")}

    # a member cannot invite; a declined invitation leaves no access
    assert client.post(f"{API}/household/workspaces/{ws}/invite", json={"username": carl.name},
                       headers=ben.h).status_code == 403
    client.post(f"{API}/household/workspaces/{ws}/invite", json={"username": carl.name}, headers=anna.h)
    assert client.post(f"{API}/household/invitations/{ws}/decline", headers=carl.h).status_code == 200
    assert ws not in _ws_ids(carl)
    assert client.post(f"{API}/household/invitations/{ws}/accept", headers=carl.h).status_code == 404


# ---------------------------------------------------------------- access rules

def test_members_see_the_shared_letters_and_never_private_ones(tmp_path):
    anna, ben = _account("anna"), _account("ben")
    ws = _shared(anna)
    anna_private = _private_workspace(anna, "Anna privat")
    ben_private = _private_workspace(ben, "Ben privat")
    _letter(tmp_path, ws, anna, "Stadtwerke.pdf", BILL)
    _letter(tmp_path, anna_private, anna, "Befund.pdf", PRIVATE)
    _letter(tmp_path, ben_private, ben, "Bens-Brief.pdf", PRIVATE.replace("Sommer", "Winter"))
    _join(ws, anna, ben)

    # Ben: the shared letter (inbox, deadlines, documents) and his own private one; never Anna's private letter
    assert _inbox_names(ben) == {"Stadtwerke.pdf", "Bens-Brief.pdf"}
    assert _deadline(ben, "Stadtwerke.pdf") is not None and _deadline(ben, "Befund.pdf") is None
    assert [d["filename"] for d in client.get(f"{API}/documents/{ws}", headers=ben.h).json()] == ["Stadtwerke.pdf"]
    assert client.get(f"{API}/documents/{anna_private}", headers=ben.h).status_code == 404
    assert anna_private not in _ws_ids(ben)
    found = client.get(f"{API}/search/global", params={"q": "Befund"}, headers=ben.h).json()
    assert not [d for d in found.get("documents", []) if "Befund" in (d.get("filename") or d.get("name") or "")]
    # ... and Anna never sees Ben's private letter
    assert _inbox_names(anna) == {"Stadtwerke.pdf", "Befund.pdf"}
    assert client.get(f"{API}/documents/{ben_private}", headers=anna.h).status_code == 404

    # a member can ask about the shared letters: the workspace's one index is found through the member's account
    col = rag_service.get_or_create_collection(ws, ben.id)
    assert col.name == f"user_{anna.id}_workspace_{ws}" and col.count() == 1
    # a stranger never gets the owner's index for a workspace id it does not see
    stranger = _account("eve")
    assert rag_service.get_or_create_collection(ws, stranger.id).name == f"user_{stranger.id}_workspace_{ws}"

    # roles: a member cannot rename or delete the workspace, nor remove the owner
    assert client.patch(f"{API}/workspaces/{ws}", json={"name": "Mine"}, headers=ben.h).status_code == 404
    assert client.delete(f"{API}/workspaces/{ws}", headers=ben.h).status_code == 404
    assert client.delete(f"{API}/household/workspaces/{ws}", headers=ben.h).status_code == 403
    assert client.delete(f"{API}/household/workspaces/{ws}/members/{anna.id}", headers=ben.h).status_code == 403
    assert client.post(f"{API}/household/workspaces/{ws}/leave", headers=anna.h).json()["detail"]["code"] == "owner_cannot_leave"
    assert ws in _ws_ids(ben)


def test_a_removed_member_and_a_member_who_left_lose_access(tmp_path):
    anna, ben, carl = _account("anna"), _account("ben"), _account("carl")
    ws = _shared(anna)
    doc = _letter(tmp_path, ws, anna, "Stadtwerke.pdf", BILL)
    _join(ws, anna, ben)
    _join(ws, anna, carl)
    chat = client.post(f"{API}/chat/sessions/{ws}", headers=ben.h).json()["id"]
    phone = create_access_token({"sub": ben.name, "kind": auth.PHONE_KIND, "pw": _password_tag(ben)})
    assert client.get(f"{API}/documents/{ws}", headers={"Authorization": f"Bearer {phone}"}).status_code == 200

    r = client.delete(f"{API}/household/workspaces/{ws}/members/{ben.id}", headers=anna.h)
    assert r.status_code == 200, r.text
    assert ws not in _ws_ids(ben)
    assert "Stadtwerke.pdf" not in _inbox_names(ben)
    assert _deadline(ben, "Stadtwerke.pdf") is None
    for path in (f"/documents/{ws}", f"/documents/{ws}/documents/{doc}/file", f"/chat/sessions/{ws}",
                 f"/household/workspaces/{ws}/activity"):
        assert client.get(API + path, headers=ben.h).status_code == 404, path
    assert client.get(f"{API}/documents/{ws}", headers={"Authorization": f"Bearer {phone}"}).status_code == 404
    assert rag_service.get_or_create_collection(ws, ben.id).name != f"user_{anna.id}_workspace_{ws}"
    db = SessionLocal()
    try:
        assert db.query(models.Chat).filter_by(id=chat).first() is None      # his private chat there is gone with him
    finally:
        db.close()

    # Carl leaves by himself, with the same result; Anna still has everything
    assert client.post(f"{API}/household/workspaces/{ws}/leave", headers=carl.h).status_code == 200
    assert ws not in _ws_ids(carl) and client.get(f"{API}/documents/{ws}", headers=carl.h).status_code == 404
    assert "Stadtwerke.pdf" in _inbox_names(anna)
    acts = _actions(ws, anna)
    assert ("removed", anna.name, ben.name, None) in acts and ("left", carl.name, None, None) in acts

    # the owner deletes the workspace: gone for everybody, with its sharing rows
    assert client.delete(f"{API}/household/workspaces/{ws}", headers=anna.h).status_code == 200
    assert ws not in _ws_ids(anna)
    db = SessionLocal()
    try:
        for model in (models.WorkspaceMember, models.WorkspaceActivity, models.WorkspaceKey):
            assert db.query(model).filter_by(workspace_id=ws).count() == 0
    finally:
        db.close()


def _password_tag(acc):
    db = SessionLocal()
    try:
        return auth.password_tag(db.query(models.User).filter_by(id=acc.id).first())
    finally:
        db.close()


def test_a_paired_phone_has_its_accounts_rights(tmp_path):
    anna, ben = _account("anna"), _account("ben")
    ws = _shared(anna)
    _letter(tmp_path, ws, anna, "Stadtwerke.pdf", BILL)
    anna_private = _private_workspace(anna)
    _join(ws, anna, ben)
    phone = {"Authorization": f"Bearer {create_access_token({'sub': ben.name, 'kind': auth.PHONE_KIND, 'pw': _password_tag(ben)})}"}
    assert ws in {w["id"] for w in client.get(f"{API}/workspaces/", headers=phone).json()}
    assert anna_private not in {w["id"] for w in client.get(f"{API}/workspaces/", headers=phone).json()}
    bill = _deadline(type("P", (), {"h": phone}), "Stadtwerke.pdf")
    assert client.put(f"{API}/dashboard/deadlines/done", json={"key": bill["key"]}, headers=phone).status_code == 200
    assert _deadline(anna, "Stadtwerke.pdf")["done_by"] == ben.name
    assert client.delete(f"{API}/household/workspaces/{ws}", headers=phone).status_code == 403   # a member's rights only


# ---------------------------------------------------------------- who did it

def test_every_action_shows_who_did_it(tmp_path):
    anna, ben = _account("anna"), _account("ben")
    ws = _shared(anna)
    doc = _letter(tmp_path, ws, anna, "Stadtwerke.pdf", BILL)
    _join(ws, anna, ben)

    # Ben marks the deadline done: Anna sees it done, "by Ben"; taking it back is recorded too
    bill = _deadline(ben, "Stadtwerke.pdf")
    assert client.put(f"{API}/dashboard/deadlines/done", json={"key": bill["key"]}, headers=ben.h).status_code == 200
    seen_by_anna = _deadline(anna, "Stadtwerke.pdf")
    assert seen_by_anna["done"] is True and seen_by_anna["done_by"] == ben.name
    assert _deadline(ben, "Stadtwerke.pdf")["done_by"] == ben.name

    # Anna marks the letter done in the inbox: Ben sees the household's decision, with her name
    assert client.post(f"{API}/dashboard/inbox/ws/{doc}", json={"status": "done"}, headers=anna.h).status_code == 200
    letter = next(d for d in client.get(f"{API}/dashboard/inbox", headers=ben.h).json()["documents"] if d["id"] == doc)
    assert letter["status"] == "done" and letter["status_by"] == anna.name and letter["added_by"] == anna.name

    # Ben adds a document: listed with his name
    r = client.post(f"{API}/documents/{ws}/upload", files={"file": ("Notiz.txt", b"Kehrwoche ab Montag", "text/plain")},
                    headers=ben.h)
    assert r.status_code == 200, r.text
    listed = {d["filename"]: d for d in client.get(f"{API}/documents/{ws}", headers=anna.h).json()}
    assert listed["Notiz.txt"]["added_by"] == ben.name and listed["Stadtwerke.pdf"]["added_by"] == anna.name
    # a member deletes only what they added
    assert client.delete(f"{API}/documents/{ws}/documents/{doc}", headers=ben.h).status_code == 403

    client.put(f"{API}/dashboard/deadlines/done", json={"key": bill["key"], "done": False}, headers=anna.h)
    acts = _actions(ws, ben)
    for expected in [("created", anna.name, None, None), ("invited", anna.name, ben.name, None),
                     ("joined", ben.name, None, None), ("deadline_done", ben.name, None, "Stadtwerke.pdf"),
                     ("marked_done", anna.name, None, "Stadtwerke.pdf"), ("document_added", ben.name, None, "Notiz.txt"),
                     ("deadline_open", anna.name, None, "Stadtwerke.pdf")]:
        assert expected in acts, expected
    assert acts[0][0] == "deadline_open"                    # newest first

    # a private workspace keeps no trail and its decisions stay the account's own
    private = _private_workspace(ben)
    mine = _letter(tmp_path, private, ben, "Privat.pdf", BILL.replace("Stadtwerke", "Gaswerk"))
    client.post(f"{API}/dashboard/inbox/ws/{mine}", json={"status": "done"}, headers=ben.h)
    assert "status_by" not in next(d for d in client.get(f"{API}/dashboard/inbox", headers=ben.h).json()["documents"]
                                   if d["id"] == mine)


# ---------------------------------------------------------------- private chats

def test_chats_in_a_shared_workspace_stay_private():
    anna, ben = _account("anna"), _account("ben")
    ws = _shared(anna)
    _join(ws, anna, ben)
    anna_chat = client.post(f"{API}/chat/sessions/{ws}", headers=anna.h).json()["id"]
    client.post(f"{API}/chat/message", json={"chat_id": anna_chat, "content": "Wie hoch ist mein Gehalt?"}, headers=anna.h)
    client.patch(f"{API}/chat/session/{anna_chat}", json={"title": "Gehalt Anna"}, headers=anna.h)
    folder = client.post(f"{API}/chat/folders/{ws}", json={"name": "Anna geheim"}, headers=anna.h).json()["id"]
    ben_chat = client.post(f"{API}/chat/sessions/{ws}", headers=ben.h).json()["id"]

    assert [c["id"] for c in client.get(f"{API}/chat/sessions/{ws}", headers=ben.h).json()] == [ben_chat]
    assert [c["id"] for c in client.get(f"{API}/chat/sessions/{ws}", headers=anna.h).json()] == [anna_chat]
    assert client.get(f"{API}/chat/sessions/{ws}", params={"q": "Gehalt"}, headers=ben.h).json() == []
    for method, path, body in [("get", f"/chat/session/{anna_chat}", None), ("get", f"/chat/messages/{anna_chat}", None),
                               ("patch", f"/chat/session/{anna_chat}", {"title": "x"}),
                               ("delete", f"/chat/session/{anna_chat}", None),
                               ("post", "/chat/message", {"chat_id": anna_chat, "content": "hallo"}),
                               ("put", f"/chat/session/{ben_chat}/move", {"folder_id": folder}),
                               ("put", f"/chat/folders/{folder}", {"name": "x"})]:
        r = getattr(client, method)(API + path, headers=ben.h, **({"json": body} if body is not None else {}))
        assert r.status_code == 404, (method, path, r.status_code)
    assert client.get(f"{API}/chat/folders/{ws}", headers=ben.h).json() == []
    found = client.get(f"{API}/search/global", params={"q": "Gehalt"}, headers=ben.h).json()
    assert not found.get("chats")
    assert client.get(f"{API}/chat/messages/{anna_chat}", headers=anna.h).json()[0]["content"] == "Wie hoch ist mein Gehalt?"

    # the memories learned from chats are per account in a shared workspace
    db = SessionLocal()
    try:
        shared_ws = db.query(models.Workspace).filter_by(id=ws).first()
        assert household.memory_scope(shared_ws, anna.id) != household.memory_scope(shared_ws, ben.id)
        private = models.Workspace(id=None, name="p", user_id=anna.id, shared=0)
        private.id = 12345
        assert household.memory_scope(private, anna.id) == 12345
    finally:
        db.close()


# ---------------------------------------------------------------- encryption

@pytest.fixture()
def protected(tmp_path, monkeypatch):
    """Protection at rest on (own state folder and uploads), key replacement in the foreground."""
    from app.core.config import settings
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setattr(settings, "TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setattr(household, "REKEY_IN_BACKGROUND", False)
    os.makedirs(settings.UPLOAD_DIR)
    protection.set_directory(str(tmp_path / "protection"))
    protection.clear_key()
    protection.set_key(crypto.new_key())
    protection.mark_enabled(True)
    made = []
    yield made
    # the rows of this test were written with a key that is gone afterwards: remove them
    ids = [a.id for a in made]
    with engine.begin() as c:
        ws_ids = [r[0] for r in c.execute(text(f"SELECT id FROM workspaces WHERE user_id IN ({','.join(map(str, ids))})"))]
        wl = ",".join(map(str, ws_ids)) or "0"
        il = ",".join(map(str, ids))
        for sql in (f"DELETE FROM workspace_members WHERE workspace_id IN ({wl}) OR user_id IN ({il})",
                    f"DELETE FROM workspace_keys WHERE workspace_id IN ({wl})",
                    f"DELETE FROM workspace_activity WHERE workspace_id IN ({wl})",
                    f"DELETE FROM account_keys WHERE user_id IN ({il})",
                    f"DELETE FROM documents WHERE workspace_id IN ({wl})",
                    f"DELETE FROM workspaces WHERE id IN ({wl})",
                    f"DELETE FROM users WHERE id IN ({il})"):
            c.execute(text(sql))
    protection.set_directory(None)
    protection.clear_key()
    protection._state_cache = None


def _protected_trio(made):
    anna, ben, carl = _account("anna"), _account("ben"), _account("carl")
    made += [anna, ben, carl]
    db = SessionLocal()
    try:
        ws = household.create_shared(db, db.query(models.User).filter_by(id=anna.id).first(), "Our home")
        household.invite(db, ws.id, anna.id, ben.name)
        household.accept(db, ws.id, ben.id)
        return anna, ben, carl, ws.id
    finally:
        db.close()


def test_the_shared_workspace_key_is_wrapped_for_each_member(protected):
    anna, ben, carl, ws = _protected_trio(protected)
    db = SessionLocal()
    try:
        rows = db.query(models.WorkspaceKey).filter_by(workspace_id=ws).all()
        assert sorted(r.user_id for r in rows) == sorted([anna.id, ben.id]) and {r.version for r in rows} == {1}
        k_anna = household.workspace_key(db, ws, 1, anna.id)
        k_ben = household.workspace_key(db, ws, 1, ben.id)
        assert k_anna == k_ben and len(k_anna) == 32                     # one key, opened by each member
        assert len({r.wrapped for r in rows}) == 2                         # ... from two different wrapped copies
        with pytest.raises(household.NoAccess):
            household.workspace_key(db, ws, 1, carl.id)                    # not a member: no copy
        # a copy only opens for the member it was made for (account id and version are authenticated)
        ben_row = next(r for r in rows if r.user_id == ben.id)
        anna_row = next(r for r in rows if r.user_id == anna.id)
        ak_ben = household.account_key(db, ben.id, create=False)
        with pytest.raises(crypto.CorruptData):
            household._open(ak_ben, anna_row.wrapped, household._workspace_aad(ws, 1, ben.id))
        with pytest.raises(crypto.CorruptData):
            household._open(ak_ben, ben_row.wrapped, household._workspace_aad(ws, 2, ben.id))
        # the account keys are stored wrapped with the PC's data key, never plain
        accounts = db.query(models.AccountKey).filter(models.AccountKey.user_id.in_([anna.id, ben.id])).all()
        assert len(accounts) == 2 and all(a.dk_id == crypto.key_id(protection.key) for a in accounts)
        raw = open(engine.url.database, "rb").read()
        for secret in (k_anna, ak_ben, household.account_key(db, anna.id, create=False)):
            assert secret not in raw and secret.hex().encode() not in raw
    finally:
        db.close()


def test_shared_documents_are_protected_with_the_workspace_key(protected, tmp_path):
    anna, ben, carl, ws = _protected_trio(protected)
    private = _private_workspace(anna)
    shared_path, private_path = str(tmp_path / "uploads" / "a.pdf"), str(tmp_path / "uploads" / "b.pdf")
    vault.write_bytes(shared_path, b"%PDF shared letter", workspace_id=ws)
    vault.write_bytes(private_path, b"%PDF private letter", workspace_id=private)
    db = SessionLocal()
    try:
        wdk = household.workspace_key(db, ws, 1, ben.id)
    finally:
        db.close()
    pc_files = protection.sub_key("files")
    assert crypto.file_key_id(shared_path) == crypto.key_id(crypto.derive_key(wdk, "files")) != crypto.key_id(pc_files)
    assert crypto.file_key_id(private_path) == crypto.key_id(pc_files)
    assert vault.read_bytes(shared_path) == b"%PDF shared letter" and vault.read_bytes(private_path) == b"%PDF private letter"
    with pytest.raises(crypto.WrongKey):
        crypto.decrypt_file_bytes(shared_path, pc_files)                 # the PC's files key alone does not open it
    # locking the engine forgets the unwrapped workspace keys
    assert household._CACHE
    key = protection.key
    protection.clear_key()
    assert not household._CACHE
    protection.set_key(key)

    # the restore test of a backup finds the workspace key in the backup's database with the backup's data key
    keys = household.file_keys_from_database(engine.url.database, key)
    assert keys[crypto.file_key_id(shared_path)] == crypto.derive_key(wdk, "files")


def test_removing_a_member_replaces_the_key_and_protects_the_files_again(protected, tmp_path):
    anna, ben, carl, ws = _protected_trio(protected)
    db = SessionLocal()
    try:
        household.invite(db, ws, anna.id, carl.name)
        household.accept(db, ws, carl.id)
        path = str(tmp_path / "uploads" / "letter.pdf")
        vault.write_bytes(path, b"%PDF the letter " * 1000, workspace_id=ws)
        db.add(models.Document(workspace_id=ws, filename="letter.pdf", filepath=path, file_type="pdf", status="indexed",
                               added_by=anna.id))
        db.commit()
        old = household.workspace_key(db, ws, 1, ben.id)                     # what Ben could have kept

        result = household.remove_member(db, ws, anna.id, ben.id)
        assert result["key_version"] == 2
        db.expire_all()
        rows = db.query(models.WorkspaceKey).filter_by(workspace_id=ws).all()
        assert sorted((r.version, r.user_id) for r in rows) == sorted([(2, anna.id), (2, carl.id)])   # v1 gone, no Ben
        with pytest.raises(household.NoAccess):
            household.workspace_key(db, ws, 2, ben.id)
        new = household.workspace_key(db, ws, 2, carl.id)
        assert new != old and household.workspace_key(db, ws, 2, anna.id) == new
        assert crypto.file_key_id(path) == crypto.key_id(crypto.derive_key(new, "files"))
        assert vault.read_bytes(path) == b"%PDF the letter " * 1000
        with pytest.raises(crypto.WrongKey):
            crypto.decrypt_file_bytes(path, crypto.derive_key(old, "files"))   # the old key opens nothing any more
        assert "key_replaced" in [a["action"] for a in household.activity(db, ws)]

        # a member who leaves: the same
        household.remove_member(db, ws, carl.id, carl.id)
        db.expire_all()
        assert {r.user_id for r in db.query(models.WorkspaceKey).filter_by(workspace_id=ws)} == {anna.id}
        assert vault.read_bytes(path) == b"%PDF the letter " * 1000
    finally:
        db.close()


def test_a_member_joining_later_gets_a_wrapped_copy_and_a_locked_engine_refuses(protected):
    anna, ben, carl, ws = _protected_trio(protected)
    db = SessionLocal()
    try:
        household.invite(db, ws, anna.id, carl.name)
        key = protection.key
        protection.clear_key()
        from app.core.protection import ProtectionLocked
        with pytest.raises(ProtectionLocked):
            household.accept(db, ws, carl.id)                                # never a member without a key copy
        db.rollback()
        protection.set_key(key)
        household.accept(db, ws, carl.id)
        assert household.workspace_key(db, ws, 1, carl.id) == household.workspace_key(db, ws, 1, anna.id)
    finally:
        db.close()
