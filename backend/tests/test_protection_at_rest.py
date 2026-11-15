"""Protection at rest (B6): uploaded documents, database text, vector-store text, the migration with its dry run
and rollback, and what a locked engine does."""
import hashlib
import os
import sqlite3

import chromadb
import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import StatementError
from sqlalchemy.orm import sessionmaker

from app.core import crypto
from app.core.protection import ProtectionLocked, protection
from app.db import models
from app.db.session import Base
from app.services import protection_migration as mig
from app.services import vault
from app.services.protected_collection import wrap

SECRET_TEXT = "Kuendigung Mietvertrag Frau Mueller IBAN DE41600500000001234567"


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """A private data folder, database and vector store; the process-wide protection state points to it."""
    from app.core.config import settings
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setattr(settings, "TEMP_DIR", str(tmp_path / "tmp"))
    os.makedirs(settings.UPLOAD_DIR)
    protection.set_directory(str(tmp_path / "protection"))
    protection.clear_key()
    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}")
    Base.metadata.create_all(engine)
    client = chromadb.PersistentClient(path=str(tmp_path / "chroma"),
                                       settings=chromadb.config.Settings(anonymized_telemetry=False))
    targets = mig.Targets(engine=engine, base=Base, upload_dir=settings.UPLOAD_DIR, chroma_client=client)
    yield type("Env", (), {"tmp": tmp_path, "engine": engine, "client": client, "targets": targets,
                           "Session": sessionmaker(bind=engine), "uploads": settings.UPLOAD_DIR})
    protection.set_directory(None)
    protection.clear_key()
    protection._state_cache = None


def _unlock_and_enable():
    protection.set_key(crypto.new_key())
    protection.mark_enabled(True)


def _raw(engine, sql):
    with engine.connect() as c:
        return c.execute(text(sql)).fetchall()


def _add_message(env, content):
    s = env.Session()
    u = models.User(username="u" + os.urandom(4).hex(), hashed_password="x")
    s.add(u); s.flush()
    ws = models.Workspace(user_id=u.id, name="w"); s.add(ws); s.flush()
    chat = models.Chat(workspace_id=ws.id, title="t"); s.add(chat); s.flush()
    s.add(models.Message(chat_id=chat.id, role="user", content=content, sources='{"kb":["a"]}'))
    s.commit(); s.close()


# --- state and key ---------------------------------------------------------------------------------------------

def test_default_is_off_and_nothing_is_protected(env):
    assert protection.status()["enabled"] is False
    assert protection.writes_protected() is False
    _add_message(env, SECRET_TEXT)
    assert _raw(env.engine, "select content from messages")[0][0] == SECRET_TEXT


def test_locked_engine_refuses_to_write_and_to_read_protected_values(env):
    _unlock_and_enable()
    _add_message(env, SECRET_TEXT)
    protection.clear_key()
    assert protection.status()["locked"] is True
    with pytest.raises((ProtectionLocked, StatementError)):
        _add_message(env, "second")                     # no silent fall back to plain text
    s = env.Session()
    with pytest.raises(ProtectionLocked):
        s.query(models.Message).first()
    s.close()


def test_wrong_key_is_refused_when_unlocking(env):
    _unlock_and_enable()
    protection.clear_key()
    with pytest.raises(crypto.WrongKey):
        protection.set_key(crypto.new_key())
    assert protection.key is None


def test_key_from_environment(env, monkeypatch):
    import base64
    key = crypto.new_key()
    monkeypatch.setenv("STARKLLM_DATA_KEY", base64.b64encode(key).decode())
    protection._env_loaded = False
    assert protection.key == key


# --- database text -----------------------------------------------------------------------------------------------

def test_database_text_is_encrypted_on_disk_and_read_back(env):
    _unlock_and_enable()
    _add_message(env, SECRET_TEXT)
    raw = _raw(env.engine, "select content, sources from messages")[0]
    assert SECRET_TEXT not in raw[0] and raw[0].startswith(crypto.TOKEN_PREFIX) and raw[1].startswith(crypto.TOKEN_PREFIX)
    s = env.Session()
    m = s.query(models.Message).first()
    assert m.content == SECRET_TEXT and m.sources == '{"kb":["a"]}'
    s.close()
    with open(env.tmp / "test.db", "rb") as f:
        assert SECRET_TEXT.encode() not in f.read()


def test_plain_text_that_looks_like_a_token_survives_with_protection_off(env):
    tricky = crypto.TOKEN_PREFIX + "abcd$xyz"
    _add_message(env, tricky)
    s = env.Session()
    assert s.query(models.Message).first().content == tricky
    s.close()


def test_old_plain_rows_stay_readable_after_protection_is_switched_on(env):
    _add_message(env, "written before")
    _unlock_and_enable()
    s = env.Session()
    assert s.query(models.Message).first().content == "written before"
    s.close()


# --- uploaded documents --------------------------------------------------------------------------------------------

def test_uploaded_document_is_stored_encrypted_and_reads_back(env):
    _unlock_and_enable()
    path = os.path.join(env.uploads, "ab12_letter.txt")
    vault.write_text(path, SECRET_TEXT)
    assert vault.is_protected(path)
    assert SECRET_TEXT.encode() not in open(path, "rb").read()
    assert vault.read_text(path) == SECRET_TEXT
    assert vault.size(path) == len(SECRET_TEXT.encode())
    assert vault.sha256(path) == hashlib.sha256(SECRET_TEXT.encode()).hexdigest()
    with vault.plain_path(path) as readable:
        assert open(readable, encoding="utf-8").read() == SECRET_TEXT
        assert readable.endswith("ab12_letter.txt")
    assert not os.path.exists(readable)                 # the decrypted copy is gone


def test_plain_documents_pass_through_unchanged(env):
    path = os.path.join(env.uploads, "old.txt")
    open(path, "w").write("old plain text")
    assert not vault.is_protected(path)
    with vault.plain_path(path) as readable:
        assert readable == path
    assert vault.read_text(path) == "old plain text"


def test_changed_protected_document_is_refused(env):
    _unlock_and_enable()
    path = os.path.join(env.uploads, "x.txt")
    vault.write_bytes(path, b"A" * 5000)
    blob = bytearray(open(path, "rb").read())
    blob[len(blob) // 2] ^= 1
    open(path, "wb").write(bytes(blob))
    with pytest.raises(crypto.CryptoError):
        vault.read_bytes(path)


def test_locked_engine_cannot_read_or_write_documents(env):
    _unlock_and_enable()
    path = os.path.join(env.uploads, "x.txt")
    vault.write_text(path, "secret")
    protection.clear_key()
    with pytest.raises(ProtectionLocked):
        vault.read_text(path)
    with pytest.raises(ProtectionLocked):
        vault.write_text(os.path.join(env.uploads, "y.txt"), "new")


# --- vector store ------------------------------------------------------------------------------------------------

def _fill_collection(env, name="user_1_workspace_1"):
    coll = wrap(env.client.get_or_create_collection(name))
    coll.add(ids=["a", "b"], documents=[SECRET_TEXT, "Stadtwerke Zahlungserinnerung"],
             embeddings=[[0.1, 0.2, 0.3], [0.3, 0.2, 0.1]], metadatas=[{"page": 1}, {"page": 2}])
    return coll


def test_vector_store_text_is_encrypted_but_the_wrapper_returns_plain_text(env):
    _unlock_and_enable()
    coll = _fill_collection(env)
    stored = env.client.get_collection("user_1_workspace_1").get()["documents"]
    assert all(d.startswith(crypto.TOKEN_PREFIX) for d in stored)
    assert coll.get(ids=["a"])["documents"] == [SECRET_TEXT]
    hit = coll.query(query_embeddings=[[0.1, 0.2, 0.3]], n_results=1)
    assert hit["documents"][0] == [SECRET_TEXT] and hit["metadatas"][0] == [{"page": 1}]
    assert coll.count() == 2 and coll.name == "user_1_workspace_1"


# --- migration ---------------------------------------------------------------------------------------------------

def _tree_hashes(root):
    out = {}
    for base, _d, files in os.walk(root):
        for f in files:
            p = os.path.join(base, f)
            out[p] = hashlib.sha256(open(p, "rb").read()).hexdigest()
    return out


def _populate_plain(env):
    _add_message(env, SECRET_TEXT)
    for name, data in (("one.txt", b"first letter"), ("two.pdf", os.urandom(3 * crypto.CHUNK + 5))):
        open(os.path.join(env.uploads, name), "wb").write(data)
    _fill_collection(env)
    return {n: open(os.path.join(env.uploads, n), "rb").read() for n in ("one.txt", "two.pdf")}


def test_dry_run_counts_and_changes_nothing(env):
    _populate_plain(env)
    protection.set_key(crypto.new_key())
    before = (_tree_hashes(env.tmp / "chroma"), _tree_hashes(env.uploads), open(env.tmp / "test.db", "rb").read())
    report = mig.plan(env.targets, "enable")
    assert report["dry_run"] and report["ok"]
    assert report["files"]["todo"] == 2 and report["vectors"]["todo"] == 2
    assert report["database"]["messages.content"]["todo"] == 1
    after = (_tree_hashes(env.tmp / "chroma"), _tree_hashes(env.uploads), open(env.tmp / "test.db", "rb").read())
    assert before == after and protection.enabled is False


def test_dry_run_without_key_reports_the_problem(env):
    report = mig.plan(env.targets, "enable")
    assert not report["ok"] and "key" in report["problems"][0].lower()
    with pytest.raises(mig.MigrationError):
        mig.run(env.targets, "enable")


def test_enable_protects_everything_and_data_still_reads(env):
    originals = _populate_plain(env)
    protection.set_key(crypto.new_key())
    result = mig.run(env.targets, "enable")
    assert {k: result["counts"][k] for k in ("database", "files", "vectors")} == {"database": 4, "files": 2, "vectors": 2}  # content, sources, workspace name, chat title
    assert result["counts"]["cleaned"] == {"database": True, "vectors": True}   # no plain traces left in the files
    assert protection.enabled
    for name, data in originals.items():
        path = os.path.join(env.uploads, name)
        assert vault.is_protected(path) and vault.read_bytes(path) == data
        assert data not in open(path, "rb").read()
    assert SECRET_TEXT not in _raw(env.engine, "select content from messages")[0][0]
    assert all(d.startswith(crypto.TOKEN_PREFIX) for d in env.client.get_collection("user_1_workspace_1").get()["documents"])
    assert wrap(env.client.get_collection("user_1_workspace_1")).get(ids=["a"])["documents"] == [SECRET_TEXT]
    leaks = [os.path.join(b, f) for b, _d, fs in os.walk(env.tmp) for f in fs
             if SECRET_TEXT.encode() in open(os.path.join(b, f), "rb").read()]
    assert leaks == []
    # nothing left to do: a second run is a no-op
    assert mig.plan(env.targets, "enable")["files"]["todo"] == 0
    assert os.path.exists(mig.safety_copy_path(protection))


def test_safety_copy_is_encrypted_and_finalize_removes_it(env):
    _populate_plain(env)
    protection.set_key(crypto.new_key())
    mig.run(env.targets, "enable")
    path = mig.safety_copy_path(protection)
    assert crypto.is_encrypted_file(path)
    data = crypto.decrypt_file_bytes(path, protection.sub_key("files"))
    assert data.startswith(b"SQLite format 3")
    assert mig.finalize(env.targets) is True and not os.path.exists(path)


def test_disable_is_the_rollback_and_restores_plain_data(env):
    originals = _populate_plain(env)
    protection.set_key(crypto.new_key())
    mig.run(env.targets, "enable")
    mig.run(env.targets, "disable")
    assert protection.enabled is False
    assert _raw(env.engine, "select content from messages")[0][0] == SECRET_TEXT
    for name, data in originals.items():
        assert open(os.path.join(env.uploads, name), "rb").read() == data
    assert env.client.get_collection("user_1_workspace_1").get(ids=["a"])["documents"] == [SECRET_TEXT]


def test_failed_enable_rolls_back_automatically(env, monkeypatch):
    originals = _populate_plain(env)
    protection.set_key(crypto.new_key())
    real = vault.protect_file
    calls = {"n": 0}

    def flaky(path):
        calls["n"] += 1
        if calls["n"] == 2:
            raise OSError("disk full")
        return real(path)
    monkeypatch.setattr(vault, "protect_file", flaky)
    with pytest.raises(mig.MigrationError):
        mig.run(env.targets, "enable")
    monkeypatch.setattr(vault, "protect_file", real)
    assert protection.enabled is False
    assert protection.status()["migration"]["state"] == "rolled_back"
    assert _raw(env.engine, "select content from messages")[0][0] == SECRET_TEXT
    for name, data in originals.items():
        assert open(os.path.join(env.uploads, name), "rb").read() == data


def test_interrupted_migration_leaves_a_working_mixed_state_and_can_continue(env, monkeypatch):
    originals = _populate_plain(env)
    protection.set_key(crypto.new_key())
    real = vault.protect_file
    calls = {"n": 0}

    def crash(path):
        calls["n"] += 1
        if calls["n"] == 2:
            raise KeyboardInterrupt()               # a crash is not an Exception: nothing can clean up
        return real(path)
    monkeypatch.setattr(vault, "protect_file", crash)
    with pytest.raises(KeyboardInterrupt):
        mig.run(env.targets, "enable", rollback_on_error=False)
    monkeypatch.setattr(vault, "protect_file", real)
    mig._RUN_LOCK.acquire(blocking=False) or None
    try:
        mig._RUN_LOCK.release()
    except RuntimeError:
        pass
    # mixed state: one file protected, one plain, both readable
    read = {n: vault.read_bytes(os.path.join(env.uploads, n)) for n in originals}
    assert read == originals
    assert sorted(vault.is_protected(os.path.join(env.uploads, n)) for n in originals) == [False, True]
    result = mig.run(env.targets, "enable")
    assert result["ok"] and mig.plan(env.targets, "enable")["files"]["todo"] == 0


def test_enable_refuses_while_documents_are_being_processed(env):
    _add_message(env, "x")
    s = env.Session()
    ws = s.query(models.Workspace).first()
    s.add(models.Document(workspace_id=ws.id, filename="a.pdf", filepath="p", file_type="pdf", status="embedding"))
    s.commit(); s.close()
    protection.set_key(crypto.new_key())
    with pytest.raises(mig.MigrationError, match="still being processed"):
        mig.run(env.targets, "enable")


def test_migration_does_not_overwrite_a_row_changed_meanwhile(env):
    _add_message(env, "old text")
    protection.set_key(crypto.new_key())
    protection.mark_enabled(True)
    with env.engine.begin() as c:                      # the migration read "old text" but the row changed since
        c.execute(text("update messages set content = 'new text'"))
        n = c.execute(text('UPDATE "messages" SET "content" = :new WHERE id = 1 AND "content" = :old'),
                      {"new": "TOKEN", "old": "old text"}).rowcount
    assert n == 0


LABELS = ("Mueller Steuern 2025", "Vermieter Post", "Kuendigung Wohnung", "Bescheid_AENDERUNG.pdf", "Mahnung beantworten")


def _add_labels(env):
    s = env.Session()
    u = models.User(username="l" + os.urandom(4).hex(), hashed_password="x"); s.add(u); s.flush()
    ws = models.Workspace(user_id=u.id, name=LABELS[0]); s.add(ws); s.flush()
    folder = models.ChatFolder(workspace_id=ws.id, name=LABELS[1]); s.add(folder); s.flush()
    s.add(models.Chat(workspace_id=ws.id, title=LABELS[2], folder_id=folder.id))
    s.add(models.Document(workspace_id=ws.id, filename=LABELS[3], filepath="p", file_type="pdf", status="indexed"))
    s.add(models.PromptTemplate(user_id=u.id, title=LABELS[4], content="x"))
    s.commit(); s.close()


def test_migration_protects_names_and_titles_and_leaves_no_plain_trace(env):
    _add_labels(env)
    protection.set_key(crypto.new_key())
    plan = mig.plan(env.targets, "enable")
    for column in ("workspaces.name", "chat_folders.name", "chats.title", "documents.filename", "prompt_templates.title"):
        assert plan["database"][column]["todo"] == 1, column
    result = mig.run(env.targets, "enable")
    assert result["counts"]["cleaned"]["database"] is True
    data = open(env.tmp / "test.db", "rb").read()
    assert not [label for label in LABELS if label.encode() in data]
    s = env.Session()
    assert s.query(models.Workspace).first().name == LABELS[0] and s.query(models.Document).first().filename == LABELS[3]
    s.close()
    mig.run(env.targets, "disable")
    assert [r[0] for r in _raw(env.engine, "select name from workspaces")] == [LABELS[0]]
    assert [r[0] for r in _raw(env.engine, "select title from chats")] == [LABELS[2]]


def test_failed_enable_rolls_back_the_labels_too(env, monkeypatch):
    _add_labels(env)
    protection.set_key(crypto.new_key())
    real, calls = mig._migrate_files, {"n": 0}

    def fail_once(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError("disk full")
        return real(*a, **k)
    monkeypatch.setattr(mig, "_migrate_files", fail_once)
    with pytest.raises(mig.MigrationError):
        mig.run(env.targets, "enable")
    monkeypatch.undo()
    assert [r[0] for r in _raw(env.engine, "select name from workspaces")] == [LABELS[0]]
    assert [r[0] for r in _raw(env.engine, "select filename from documents")] == [LABELS[3]]
