"""The HTTP side of B6/B7: unlocking, status, dry run, the administrator rule, encrypted backup, restore test and
restore, and what the old plain-zip backup does while protection is on."""
import base64
import os
import time

import chromadb
import pytest
from fastapi.testclient import TestClient

from app.api import backup as backup_api
from app.api import protection as protection_api
from app.api.auth import get_current_user
from app.api.system import require_admin
from app.core import crypto
from app.core.config import settings
from app.core.protection import ProtectionLocked, protection
from app.main import app
from app.services import backup_service as bk
from app.services import protection_migration as mig
from app.services import vault
from app.services.rag_service import rag_service
from test_encrypted_backup import LETTER, World  # the same fake data folder

PASS = "correct horse battery staple"


class FakeUser:
    id = 987654
    username = "owner"


@pytest.fixture()
def api(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setattr(settings, "SECRET_KEY", "test-secret-for-unlock")
    protection.set_directory(str(tmp_path / "data" / "protection"))
    protection.clear_key()
    world = World(tmp_path / "data")
    world.fill()
    monkeypatch.setattr(bk, "default_paths", lambda: world.paths)
    monkeypatch.setattr(rag_service, "chroma_client", world.client)
    monkeypatch.setattr(mig, "_busy_documents", lambda targets: 0)
    monkeypatch.setattr(backup_api, "_release_live_state", lambda: None)
    monkeypatch.setattr(backup_api, "_reopen_live_state", lambda key: None)
    app.dependency_overrides[get_current_user] = lambda: FakeUser()
    app.dependency_overrides[require_admin] = lambda: FakeUser()
    yield type("Api", (), {"client": TestClient(app), "world": world, "tmp": tmp_path})
    app.dependency_overrides.clear()
    protection.set_directory(None)
    protection.clear_key()
    protection._state_cache = None


def _unlock_headers():
    return {"X-StarkLLM-Internal": protection_api.internal_token()}


def test_unlock_token_matches_the_desktop_app(api):
    # the same value is asserted in desktop/test/data-key.test.js: both sides must compute the same token
    assert protection_api.internal_token() == "b69f9c3abf79e9a34f37e485a935c1483b0ce1a9090ee53ad5ac047ac2ad8efd"


def test_unlock_needs_the_internal_token(api):
    key = base64.b64encode(crypto.new_key()).decode()
    assert api.client.post("/api/v1/system/protection/unlock", json={"key": key}).status_code == 403
    assert api.client.post("/api/v1/system/protection/unlock", json={"key": key},
                           headers={"X-StarkLLM-Internal": "wrong"}).status_code == 403
    assert protection.key is None
    r = api.client.post("/api/v1/system/protection/unlock", json={"key": key}, headers=_unlock_headers())
    assert r.status_code == 200 and r.json()["key_available"] is True and r.json()["enabled"] is False


def test_lock_forgets_the_key_and_needs_the_token(api):
    key = base64.b64encode(crypto.new_key()).decode()
    api.client.post("/api/v1/system/protection/unlock", json={"key": key}, headers=_unlock_headers())
    protection.mark_enabled(True)
    assert api.client.post("/api/v1/system/protection/lock").status_code == 403
    assert protection.key is not None
    r = api.client.post("/api/v1/system/protection/lock", headers=_unlock_headers())
    assert r.status_code == 200 and r.json()["locked"] is True and protection.key is None
    again = api.client.post("/api/v1/system/protection/unlock", json={"key": key}, headers=_unlock_headers())
    assert again.status_code == 200 and again.json()["locked"] is False       # the same key opens it again


def test_unlock_rejects_a_bad_key_and_a_wrong_key(api):
    h = _unlock_headers()
    assert api.client.post("/api/v1/system/protection/unlock", json={"key": "not base64!"}, headers=h).status_code == 400
    assert api.client.post("/api/v1/system/protection/unlock", json={"key": base64.b64encode(b"short").decode()},
                           headers=h).status_code == 400
    protection.set_key(crypto.new_key()); protection.mark_enabled(True); protection.clear_key()
    other = base64.b64encode(crypto.new_key()).decode()
    assert api.client.post("/api/v1/system/protection/unlock", json={"key": other}, headers=h).status_code == 403


def test_status_and_dry_run_over_http(api):
    assert api.client.get("/api/v1/system/protection/status").json()["enabled"] is False
    protection.set_key(crypto.new_key())
    plan = api.client.post("/api/v1/system/protection/plan", json={"direction": "enable"}).json()
    assert plan["dry_run"] and "problems" in plan


def test_migrate_refuses_without_a_key(api):
    r = api.client.post("/api/v1/system/protection/migrate", json={"direction": "enable"})
    assert r.status_code == 409 and "key" in r.json()["detail"].lower()


def test_summary_tells_the_user_what_is_protected(api):
    body = api.client.get("/api/v1/system/protection/summary").json()
    assert body["enabled"] is False and body["protects"] and body["does_not_protect"]
    assert body["documents"]["protected"] == 0


def test_plain_zip_backup_is_refused_while_protection_is_on(api):
    protection.set_key(crypto.new_key()); protection.mark_enabled(True)
    r = api.client.get("/api/v1/system/backup")
    assert r.status_code == 409 and "encrypted backup" in r.json()["detail"]


def test_locked_engine_answers_423_not_500(api):
    from sqlalchemy.exc import StatementError

    @app.get("/__locked_probe")
    def probe():
        protection.sub_key("files")

    @app.get("/__locked_statement_probe")
    def statement_probe():
        raise StatementError("wrapped", "stmt", {}, ProtectionLocked("locked"))   # what SQLAlchemy does to a column type's error
    protection.set_key(crypto.new_key()); protection.mark_enabled(True); protection.clear_key()
    client = TestClient(app, raise_server_exceptions=False)
    for path in ("/__locked_probe", "/__locked_statement_probe"):
        r = client.get(path)
        assert r.status_code == 423 and r.json()["code"] == "protection_locked", path


# --- backup over HTTP --------------------------------------------------------------------------------------------

def _create(api, passphrase=PASS):
    return api.client.post("/api/v1/system/backup/create", json={"passphrase": passphrase})


def test_create_downloads_a_tested_backup_once(api):
    r = _create(api)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["report"]["ok"] and body["report"]["documents"] == 2 and body["filename"].endswith(".starkbackup")
    d = api.client.get(f"/api/v1/system/backup/download/{body['id']}?filename={body['filename']}")
    assert d.status_code == 200 and d.content.startswith(crypto.BACKUP_MAGIC) and LETTER not in d.content
    deadline = time.time() + 2
    while time.time() < deadline and api.client.get(f"/api/v1/system/backup/download/{body['id']}").status_code != 404:
        time.sleep(0.05)
    assert api.client.get(f"/api/v1/system/backup/download/{body['id']}").status_code == 404   # gone after one download
    assert api.client.get("/api/v1/system/backup/download/..%2f..%2fetc").status_code in (404, 422)


def test_create_with_a_short_passphrase_is_refused_with_a_code(api):
    r = _create(api, "short")
    assert r.status_code == 400 and r.json()["detail"]["code"] == "weak_passphrase"


def test_verify_an_existing_file_wrong_passphrase_and_damaged(api):
    body = _create(api).json()
    blob = api.client.get(f"/api/v1/system/backup/download/{body['id']}").content
    ok = api.client.post("/api/v1/system/backup/verify", files={"file": ("b.starkbackup", blob)}, data={"passphrase": PASS})
    assert ok.status_code == 200 and ok.json()["ok"]
    wrong = api.client.post("/api/v1/system/backup/verify", files={"file": ("b.starkbackup", blob)},
                            data={"passphrase": "some other passphrase"})
    assert wrong.status_code == 403 and wrong.json()["detail"]["code"] == "wrong_passphrase"
    cut = api.client.post("/api/v1/system/backup/verify", files={"file": ("b.starkbackup", blob[:len(blob) // 2])},
                          data={"passphrase": PASS})
    assert cut.status_code == 400 and cut.json()["detail"]["code"] == "damaged"
    junk = api.client.post("/api/v1/system/backup/verify", files={"file": ("x.starkbackup", b"hello")}, data={"passphrase": PASS})
    assert junk.json()["detail"]["code"] == "not_a_backup"


def test_restore_over_http_puts_the_backup_in_place(api):
    blob = api.client.get(f"/api/v1/system/backup/download/{_create(api).json()['id']}").content
    api.world.add_message("after the backup")
    api.world.client = None
    monkey = rag_service
    monkey.chroma_client = None
    import gc; gc.collect()
    wrong = api.client.post("/api/v1/system/backup/restore", files={"file": ("b", blob)}, data={"passphrase": "nope nope nope nope"})
    assert wrong.status_code == 403 and api.world.messages() == ["hello", "after the backup"]
    r = api.client.post("/api/v1/system/backup/restore", files={"file": ("b", blob)}, data={"passphrase": PASS})
    assert r.status_code == 200 and r.json()["restored"] is True, r.text
    assert api.world.messages() == ["hello"]
    assert api.client.get("/api/v1/system/backup/status").json()["undo_available"] is True
    assert api.client.post("/api/v1/system/backup/discard-undo").json()["removed"] is True


def test_locked_engine_still_loads_the_account_and_says_so_in_the_status(api):
    from app.db import models
    from app.db.session import SessionLocal
    protection.set_key(crypto.new_key()); protection.mark_enabled(True)
    db = SessionLocal()
    try:
        u = models.User(username="prof" + os.urandom(3).hex(), hashed_password="x", profile_context="my private profile")
        db.add(u); db.commit(); uid = u.id
        assert db.query(models.User).get(uid).profile_context == "my private profile"
        raw = db.execute(__import__("sqlalchemy").text("select profile_context from users where id=:i"), {"i": uid}).scalar()
        assert raw.startswith(crypto.TOKEN_PREFIX)
    finally:
        db.close()
    protection.clear_key()
    db = SessionLocal()
    try:
        assert db.query(models.User).get(uid).profile_context is None      # the account loads; the text stays locked
    finally:
        db.close()
    body = api.client.get("/api/v1/dashboard/system-status").json()
    assert body["protection"] == {"enabled": True, "locked": True}


def test_upload_index_preview_and_duplicate_with_protection_on(tmp_path, monkeypatch):
    """The whole path of a letter while protection is on: stored encrypted, read for indexing, chunk text stored
    protected, preview and download identical to the original, the same letter again recognised as a duplicate."""
    import uuid
    from app.api import documents as docs_api
    from app.api.auth import create_access_token, get_password_hash
    from app.db import models
    from app.db.session import SessionLocal
    from app.services.llm_service import llm_service

    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setattr(settings, "TEMP_DIR", str(tmp_path / "tmp"))
    protection.set_directory(str(tmp_path / "protection"))
    protection.set_key(crypto.new_key()); protection.mark_enabled(True)
    client_db = chromadb.PersistentClient(path=str(tmp_path / "chroma"), settings=chromadb.config.Settings(anonymized_telemetry=False))
    monkeypatch.setattr(rag_service, "chroma_client", client_db)
    monkeypatch.setattr(llm_service, "generate_embeddings_batch", lambda model, chunks: [[0.1, 0.2, 0.3] for _ in chunks])
    monkeypatch.setattr(llm_service, "generate_embeddings", lambda model, text: [0.1, 0.2, 0.3])
    threads = []
    real_thread = docs_api.threading.Thread
    monkeypatch.setattr(docs_api.threading, "Thread", lambda *a, **k: threads.append(real_thread(*a, **k)) or threads[-1])
    name = f"prot_{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        user = models.User(username=name, hashed_password=get_password_hash("x" * 12))
        db.add(user); db.commit()
        user_id = user.id
        ws = models.Workspace(name="Post", user_id=user_id); db.add(ws); db.commit()
        ws_id = ws.id
    finally:
        db.close()
    client = TestClient(app)
    h = {"Authorization": f"Bearer {create_access_token({'sub': name})}"}
    letter = "Finanzamt Rheinstadt\nDatum: 03.11.2026\nBitte zahlen Sie 412,00 EUR bis 30.11.2026.\n".encode()
    first = client.post(f"/api/v1/documents/{ws_id}/upload", files={"file": ("Brief.txt", letter)}, headers=h).json()
    for t in threads:
        t.join(30)
    stored = first["filepath"]
    assert vault.is_protected(stored) and b"Finanzamt" not in open(stored, "rb").read()
    coll = client_db.get_collection(f"user_{user_id}_workspace_{ws_id}")
    assert coll.count() >= 1 and all(d.startswith(crypto.TOKEN_PREFIX) for d in coll.get()["documents"])
    assert "Finanzamt" in rag_service.get_or_create_collection(ws_id, user_id).get()["documents"][0]
    download = client.get(f"/api/v1/documents/{ws_id}/documents/{first['id']}/file", headers=h)
    assert download.status_code == 200 and download.content == letter and int(download.headers["content-length"]) == len(letter)
    preview = client.get(f"/api/v1/documents/{ws_id}/preview/{first['id']}", headers=h).json()
    assert "Finanzamt" in str(preview)                                   # the first chunks, decrypted for the preview
    content = client.get(f"/api/v1/documents/{ws_id}/documents/{first['id']}/content", headers=h).json()
    assert "412,00 EUR" in str(content)
    facts = client.get(f"/api/v1/documents/{ws_id}/documents/{first['id']}/facts", headers=h).json()
    assert "412" in str(facts)                                           # the facts are found in the decrypted chunk text
    again = client.post(f"/api/v1/documents/{ws_id}/upload", files={"file": ("Kopie.txt", letter)}, headers=h).json()
    assert again.get("duplicate") is True and again["id"] == first["id"]
    protection.set_directory(None); protection.clear_key(); protection._state_cache = None


def test_lock_also_drops_the_decrypted_search_index_from_memory(api, tmp_path, monkeypatch):
    """With the start-up passphrase the engine is locked again at every start and when the app quits. The encrypted search
    index keeps its rows decrypted in memory while unlocked: locking must drop them, or a 'locked' engine would still answer."""
    from app.core.protection import ProtectionLocked
    from app.services import secure_index
    monkeypatch.setattr(settings, "SECURE_INDEX_DIR", str(tmp_path / "secure"))
    key = base64.b64encode(crypto.new_key()).decode()
    api.client.post("/api/v1/system/protection/unlock", json={"key": key}, headers=_unlock_headers())
    protection.mark_enabled(True)
    secure_index.release()
    coll = secure_index.secure_client().get_or_create_collection("user_1_workspace_1", metadata={"hnsw:space": "cosine"})
    coll.add(ids=["a"], documents=["Kuendigung Mueller"], embeddings=[[0.1, 0.2, 0.3]], metadatas=[{"page": 1}])
    assert coll.get(ids=["a"])["documents"] == ["Kuendigung Mueller"]
    assert api.client.post("/api/v1/system/protection/lock", headers=_unlock_headers()).status_code == 200
    assert secure_index._client is None                              # the decrypted rows are no longer held in memory
    with pytest.raises(ProtectionLocked):
        secure_index.secure_client().get_or_create_collection("user_1_workspace_1").get(ids=["a"])
    api.client.post("/api/v1/system/protection/unlock", json={"key": key}, headers=_unlock_headers())
    assert secure_index.secure_client().get_or_create_collection("user_1_workspace_1").get(ids=["a"])["documents"] == ["Kuendigung Mueller"]
    secure_index.release()
