"""Moving the search index between ChromaDB and the encrypted index (dry run, switch, clean-up, rollback), the encrypted
index inside backups, and the whole path of a letter with the encrypted index on."""
import os
import uuid

import numpy as np
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from app.core.chroma_store import open_chroma
from app.core import crypto
from app.core.config import settings
from app.core.protection import protection
from app.db.session import Base
from app.main import app
from app.services import backup_service as bk
from app.services import protection_migration as mig
from app.services import secure_index as si
from app.services import vault
from app.services.protected_collection import wrap

SECRET = "Kuendigung Mietvertrag Frau Mueller IBAN DE41600500000001234567"
VEC = np.array([0.1234567, -2.5, 3.14159, 0.5], dtype="<f4")
PASS = "correct horse battery staple"
LIGHT = dict(time_cost=1, memory_kib=64, parallelism=1)


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setattr(settings, "TEMP_DIR", str(tmp_path / "tmp"))
    monkeypatch.setattr(settings, "SECURE_INDEX_DIR", str(tmp_path / "secure"))
    os.makedirs(settings.UPLOAD_DIR)
    protection.set_directory(str(tmp_path / "protection"))
    protection.clear_key()
    protection.set_key(crypto.new_key())
    protection.mark_enabled(True)
    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}")
    Base.metadata.create_all(engine)
    chroma = open_chroma(str(tmp_path / "chroma"))
    store = si.SecureStore(str(tmp_path / "secure" / "index.db"))
    secure = si.SecureClient(store)
    targets = mig.Targets(engine=engine, base=Base, upload_dir=settings.UPLOAD_DIR, chroma_client=chroma,
                          secure_factory=lambda: secure)
    si._client, si._client_path = secure, str(tmp_path / "secure" / "index.db")      # what the engine itself would open
    yield type("Env", (), {"tmp": tmp_path, "targets": targets, "chroma": chroma, "secure": secure, "store": store,
                           "engine": engine})
    si._client = None
    protection.set_directory(None)
    protection.clear_key()
    protection._state_cache = None


def fill_chroma(env, workspace="user_1_workspace_1"):
    """A ChromaDB collection as protection at rest leaves it: text encrypted, vectors and metadata readable."""
    coll = wrap(env.chroma.get_or_create_collection(workspace, metadata={"hnsw:space": "cosine"}))
    coll.add(ids=["a", "b"], documents=[SECRET, "Stadtwerke Zahlungserinnerung"], embeddings=[VEC.tolist(), [0.3, 0.2, 0.1, 0.0]],
             metadatas=[{"source": "/uploads/ab12_Steuerbescheid.pdf", "page": 0, "file_name": "Steuerbescheid.pdf"},
                        {"source": "/uploads/cd34_Rechnung.pdf", "page": 1}])
    memory = wrap(env.chroma.get_or_create_collection("long_term_memory"))
    memory.add(ids=["m1"], documents=["Der Nutzer wohnt in Aachen"], embeddings=[[1.0, 0.0, 0.0, 0.0]], metadatas=[{"workspace_id": 1}])


def all_bytes(folder):
    return b"".join(open(os.path.join(b, f), "rb").read() for b, _d, fs in os.walk(folder) for f in fs)


def test_dry_run_counts_and_changes_nothing(env):
    fill_chroma(env)
    before = all_bytes(env.tmp / "chroma")
    plan = mig.vector_plan(env.targets, True)
    assert plan["ok"] and plan["collections"] == 2 and plan["chunks"] == 3
    assert all_bytes(env.tmp / "chroma") == before and protection.vector_mode() == "chroma"
    assert env.secure.store.list_names() == []


def test_plan_needs_protection_on_and_a_key(env):
    protection.mark_enabled(False)
    assert "Turn on protection first." in mig.vector_plan(env.targets, True)["problems"]
    protection.clear_key()
    assert any("key" in p for p in mig.vector_plan(env.targets, True)["problems"])
    with pytest.raises(mig.MigrationError):
        mig.run_vectors(env.targets, True)


def test_move_to_the_encrypted_index_and_nothing_readable_is_left(env):
    fill_chroma(env)
    report = mig.run_vectors(env.targets, True)
    assert report["ok"] and report["counts"]["vectors"] == 3 and protection.vector_mode() == "secure"
    coll = env.secure.get_collection("user_1_workspace_1")
    got = coll.get(include=["documents", "metadatas", "embeddings"])
    assert got["documents"][0] == SECRET and got["metadatas"][0]["file_name"] == "Steuerbescheid.pdf"
    assert np.allclose(got["embeddings"][0], VEC) and coll.metadata == {"hnsw:space": "cosine"}
    assert env.secure.get_collection("long_term_memory").get()["documents"] == ["Der Nutzer wohnt in Aachen"]
    assert env.chroma.list_collections() == []
    traces = all_bytes(env.tmp / "chroma")
    for needle in (b"Steuerbescheid", b"/uploads/", VEC.tobytes(), b"file_name"):
        assert needle not in traces, needle
    env.store._db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    secure_bytes = all_bytes(env.tmp / "secure")
    for needle in (b"Steuerbescheid", b"Mueller", b"user_1_workspace", VEC.tobytes(), b"long_term_memory"):
        assert needle not in secure_bytes, needle


def test_the_engine_uses_the_encrypted_index_after_the_switch(env):
    from app.services.memory_service import memory_service
    from app.services.rag_service import rag_service
    fill_chroma(env)
    mig.run_vectors(env.targets, True)
    col = rag_service.get_or_create_collection(1, 1)
    assert isinstance(col, si.SecureCollection) and col.count() == 2
    assert col.query(query_embeddings=[VEC.tolist()], n_results=1)["documents"][0] == [SECRET]
    memory_service.memory_collection = None
    assert [m["content"] for m in memory_service.get_memories(1)] == ["Der Nutzer wohnt in Aachen"]
    assert rag_service.get_or_create_kb_collection(5).count() == 0
    assert "user_5_knowledge_base" in env.secure.store.list_names()
    rag_service.vector_client().delete_collection("user_5_knowledge_base")


def test_move_back_to_chroma_seals_the_text_again(env):
    fill_chroma(env)
    mig.run_vectors(env.targets, True)
    report = mig.run_vectors(env.targets, False)
    assert report["ok"] and protection.vector_mode() == "chroma" and env.secure.store.list_names() == []
    stored = env.chroma.get_collection("user_1_workspace_1").get()
    assert all(d.startswith(crypto.TOKEN_PREFIX) for d in stored["documents"])
    assert wrap(env.chroma.get_collection("user_1_workspace_1")).get(ids=["a"])["documents"] == [SECRET]
    assert env.chroma.get_collection("user_1_workspace_1").metadata == {"hnsw:space": "cosine"}


def test_turning_protection_off_moves_the_index_back_first(env):
    fill_chroma(env)
    mig.run_vectors(env.targets, True)
    mig.run(env.targets, "disable")
    assert not protection.enabled and protection.vector_mode() == "chroma"
    assert env.chroma.get_collection("user_1_workspace_1").get(ids=["a"])["documents"] == [SECRET]      # plain again
    assert env.secure.store.list_names() == []


def test_a_failed_copy_leaves_the_old_index_in_use_and_a_new_run_finishes(env, monkeypatch):
    fill_chroma(env)
    real = si.SecureCollection.add
    calls = {"n": 0}

    def flaky(self, *a, **k):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("disk full")
        return real(self, *a, **k)
    monkeypatch.setattr(si.SecureCollection, "add", flaky)
    with pytest.raises(mig.MigrationError):
        mig.run_vectors(env.targets, True)
    monkeypatch.setattr(si.SecureCollection, "add", real)
    assert protection.vector_mode() == "chroma" and protection.status()["migration"]["state"] == "failed"
    assert env.chroma.get_collection("user_1_workspace_1").count() == 2
    assert mig.run_vectors(env.targets, True)["ok"] and protection.vector_mode() == "secure"
    assert env.secure.get_collection("user_1_workspace_1").count() == 2


def test_a_run_stopped_after_the_switch_only_cleans_up(env):
    fill_chroma(env)
    mig._copy_into_secure(env.targets, {"vectors": 0})
    protection.set_vector_mode("secure")                                                # stopped here: the switch was done
    env.chroma.delete_collection("long_term_memory")                                     # ... and half of the clean-up
    env.secure.get_collection("user_1_workspace_1").delete(ids=["b"])                    # a change in the encrypted index since
    mig.run_vectors(env.targets, True)
    assert env.chroma.list_collections() == []
    assert env.secure.get_collection("user_1_workspace_1").count() == 1                 # the secure copy was not overwritten


def test_rows_written_while_copying_are_not_lost(env, monkeypatch):
    fill_chroma(env)
    real = si.SecureClient.create_collection
    chroma_col = wrap(env.chroma.get_collection("user_1_workspace_1"))

    def late(self, name, metadata=None, **k):
        if name == "user_1_workspace_1":
            chroma_col.add(ids=["late"], documents=["written in between"], embeddings=[[1.0, 1.0, 1.0, 1.0]], metadatas=[{"page": 5}])
        return real(self, name, metadata, **k)
    monkeypatch.setattr(si.SecureClient, "create_collection", late)
    mig.run_vectors(env.targets, True)
    assert env.secure.get_collection("user_1_workspace_1").get(ids=["late"])["documents"] == ["written in between"]


# --- backups ---------------------------------------------------------------------------------------------------------

def make_world(env):
    paths = bk.Paths(database=str(env.tmp / "test.db"), uploads=settings.UPLOAD_DIR, chroma=str(env.tmp / "chroma"),
                     protection_dir=str(env.tmp / "protection"), root=str(env.tmp), secure_index=str(env.tmp / "secure"))
    vault.write_bytes(os.path.join(settings.UPLOAD_DIR, "1_letter.txt"), SECRET.encode())
    return paths


def test_backup_and_restore_test_cover_the_encrypted_index(env):
    fill_chroma(env)
    mig.run_vectors(env.targets, True)
    paths = make_world(env)
    out = str(env.tmp / "b.starkbackup")
    manifest = bk.create_backup(out, PASS, paths=paths, chroma_client=env.chroma, secure_client=env.secure, kdf=LIGHT)
    assert manifest["secure_collections"] == {"user_1_workspace_1": 2, "long_term_memory": 1}
    assert "secure/index.db" in manifest["files"]
    blob = open(out, "rb").read()
    assert SECRET.encode() not in blob and b"Steuerbescheid" not in blob
    report = bk.restore_test(out, PASS)
    assert report["ok"] and report["collections"] == 2 and report["protected"]


def test_restore_test_catches_a_changed_encrypted_index(env, monkeypatch):
    fill_chroma(env)
    mig.run_vectors(env.targets, True)
    paths = make_world(env)
    monkeypatch.setattr(bk, "_secure_counts", lambda c: {"user_1_workspace_1": 99})
    out = str(env.tmp / "b.starkbackup")
    bk.create_backup(out, PASS, paths=paths, secure_client=env.secure, kdf=LIGHT)
    with pytest.raises(bk.BackupError) as e:
        bk.restore_test(out, PASS)
    assert e.value.code == "mismatch" and "encrypted search index" in e.value.message


def test_restore_brings_the_encrypted_index_back_and_it_opens_with_the_backup_key(env):
    fill_chroma(env)
    mig.run_vectors(env.targets, True)
    paths = make_world(env)
    out = str(env.tmp / "b.starkbackup")
    bk.create_backup(out, PASS, paths=paths, secure_client=env.secure, kdf=LIGHT)
    env.secure.get_collection("user_1_workspace_1").delete(ids=["a"])           # later changes
    si.release()
    bk.stage_restore(out, PASS, paths)
    result = bk.apply_pending_restore(paths)
    assert result["applied"] and os.path.exists(os.path.join(result["undo"], "secure", "index.db"))
    protection._state_cache = None
    store = si.SecureStore(str(env.tmp / "secure" / "index.db"))
    assert store.get_collection("user_1_workspace_1").get(ids=["a"])["documents"] == [SECRET]
    assert protection.vector_mode() == "secure"


# --- the whole path of a letter, with the encrypted index on --------------------------------------------------------

def test_upload_search_facts_and_memory_with_the_encrypted_index(env, monkeypatch):
    from app.api import documents as docs_api
    from app.api.auth import create_access_token, get_password_hash
    from app.db import models
    from app.db.session import SessionLocal
    from app.services.llm_service import llm_service
    from app.services.memory_service import memory_service
    from app.services.rag_service import rag_service
    protection.set_vector_mode("secure")
    monkeypatch.setattr(llm_service, "generate_embeddings_batch", lambda model, chunks: [[0.1, 0.2, 0.3] for _ in chunks])
    monkeypatch.setattr(llm_service, "generate_embeddings", lambda model, text: [0.1, 0.2, 0.3])
    threads = []
    real_thread = docs_api.threading.Thread
    monkeypatch.setattr(docs_api.threading, "Thread", lambda *a, **k: threads.append(real_thread(*a, **k)) or threads[-1])
    name = f"sec_{uuid.uuid4().hex[:8]}"
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
    col = rag_service.get_or_create_collection(ws_id, user_id)
    assert isinstance(col, si.SecureCollection) and col.count() >= 1
    assert "Finanzamt" in col.get()["documents"][0] and col.get()["metadatas"][0]["source"] == first["filepath"]
    assert col.query(query_embeddings=[[0.1, 0.2, 0.3]], n_results=1, where={"source": first["filepath"]})["ids"][0]
    assert col.get(where_document={"$contains": "412,00"}, limit=1, include=[])["ids"]
    facts = client.get(f"/api/v1/documents/{ws_id}/documents/{first['id']}/facts", headers=h).json()
    assert "412" in str(facts)
    content = client.get(f"/api/v1/documents/{ws_id}/documents/{first['id']}/content", headers=h).json()
    assert "412,00 EUR" in str(content)
    env.store._db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    assert b"Finanzamt" not in all_bytes(env.tmp / "secure") and first["filepath"].encode() not in all_bytes(env.tmp / "secure")
    memory_service.memory_collection = None
    mem = memory_service.memory_collection
    assert isinstance(mem, si.SecureCollection)
    mem.add(ids=["m1"], documents=["Der Nutzer heisst Mueller"], embeddings=[[0.1, 0.2, 0.3]], metadatas=[{"workspace_id": ws_id}])
    assert memory_service.get_memories(ws_id) == [{"id": "m1", "content": "Der Nutzer heisst Mueller"}]
    assert memory_service.delete_memory(ws_id, "m1") is True
    client.delete(f"/api/v1/workspaces/{ws_id}", headers=h)
    assert f"user_{user_id}_workspace_{ws_id}" not in env.secure.store.list_names()


# --- over HTTP -------------------------------------------------------------------------------------------------------

def test_move_the_index_over_http_with_a_dry_run_first(env, monkeypatch):
    import time
    from app.api.auth import get_current_user
    from app.api.system import require_admin

    class Admin:
        id = 1
        username = "owner"
    app.dependency_overrides[get_current_user] = lambda: Admin()
    app.dependency_overrides[require_admin] = lambda: Admin()
    monkeypatch.setattr(mig, "default_targets", lambda: env.targets)
    monkeypatch.setattr(mig, "_busy_documents", lambda targets: 0)
    try:
        client = TestClient(app)
        fill_chroma(env)
        plan = client.post("/api/v1/system/protection/vectors/plan", json={"mode": "secure"}).json()
        assert plan["ok"] and plan["chunks"] == 3 and protection.vector_mode() == "chroma"
        assert client.post("/api/v1/system/protection/vectors/migrate", json={"mode": "bogus"}).status_code == 422
        assert client.post("/api/v1/system/protection/vectors/migrate", json={"mode": "secure"}).status_code == 202
        deadline = time.time() + 20
        while time.time() < deadline and client.get("/api/v1/system/protection/status").json()["migration"]["state"] != "done":
            time.sleep(0.1)
        status = client.get("/api/v1/system/protection/status").json()
        assert status["vector_mode"] == "secure" and status["migration"]["state"] == "done"
        summary = client.get("/api/v1/system/protection/summary").json()
        assert summary["vector_mode"] == "secure" and any("search index itself" in p for p in summary["protects"])
        assert not any("show topics" in p for p in summary["does_not_protect"])
        protection.clear_key()
        assert client.post("/api/v1/system/protection/vectors/migrate", json={"mode": "chroma"}).status_code == 409
    finally:
        app.dependency_overrides.clear()
