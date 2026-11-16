"""Backup and restore with everything that protection at rest can lock at once: encrypted file names and titles in the
database (#104), the encrypted search index (#106), encrypted documents and text (#98). The weekly backup (this branch)
asks the engine for exactly this backup, so the round trip must hold."""
import os

import pytest
from sqlalchemy.orm import sessionmaker

from app.core import crypto
from app.core.protection import protection
from app.db import models
from app.services import backup_service as bk
from app.services import protection_migration as mig
from app.services import secure_index as si
from app.services import vault
from test_secure_index_migration import LIGHT, PASS, SECRET, env, fill_chroma, make_world  # noqa: F401  (fixture and helpers)

WS_NAME, CHAT_TITLE, FILE_NAME = "Steuern 2026 Familie Mueller", "Frage zum Bescheid Rheinstadt", "Kuendigung_Mueller.pdf"


def add_labels(env):
    s = sessionmaker(bind=env.engine)()
    u = models.User(username="owner", hashed_password="x")
    s.add(u); s.flush()
    ws = models.Workspace(user_id=u.id, name=WS_NAME); s.add(ws); s.flush()
    chat = models.Chat(workspace_id=ws.id, title=CHAT_TITLE); s.add(chat); s.flush()
    s.add(models.Message(chat_id=chat.id, role="user", content=SECRET))
    s.add(models.Document(workspace_id=ws.id, filename=FILE_NAME, filepath=os.path.join(env.tmp, "uploads", "1_letter.txt"),
                          file_type="pdf", status="indexed"))
    s.commit(); s.close()


def read_labels(engine):
    s = sessionmaker(bind=engine)()
    try:
        return (s.query(models.Workspace).one().name, s.query(models.Chat).one().title, s.query(models.Document).one().filename,
                s.query(models.Message).one().content)
    finally:
        s.close()


def test_everything_locked_survives_backup_restore_test_and_restore(env):
    fill_chroma(env)
    add_labels(env)
    mig.run_vectors(env.targets, True)                       # the search index is the encrypted one
    paths = make_world(env)
    out = str(env.tmp / "weekly.starkbackup")

    report = bk.create_and_test(out, PASS, paths=paths, chroma_client=env.chroma, secure_client=env.secure, kdf=LIGHT)
    assert report["ok"] and report["protected"] and report["collections"] >= 2 and report["documents"] == 1

    blob = open(out, "rb").read()
    for plain in (WS_NAME, CHAT_TITLE, FILE_NAME, SECRET, "Steuerbescheid", "Rechnung.pdf"):
        assert plain.encode() not in blob, plain
    # and inside the database that was backed up the labels are locked too (not only the file is)
    raw = open(paths.database, "rb").read()
    for plain in (WS_NAME, CHAT_TITLE, FILE_NAME, SECRET):
        assert plain.encode() not in raw, plain

    env.engine.dispose()
    s = sessionmaker(bind=env.engine)()                      # later changes that the restore must undo
    s.query(models.Chat).one().title = "changed later"
    s.commit(); s.close()
    env.engine.dispose()
    si.release()
    bk.stage_restore(out, PASS, paths)
    assert bk.apply_pending_restore(paths)["applied"]
    env.engine.dispose()
    protection._state_cache = None
    assert read_labels(env.engine) == (WS_NAME, CHAT_TITLE, FILE_NAME, SECRET)
    assert vault.read_bytes(os.path.join(env.tmp, "uploads", "1_letter.txt")) == SECRET.encode()
    store = si.SecureStore(str(env.tmp / "secure" / "index.db"))
    assert store.get_collection("user_1_workspace_1").get(ids=["a"])["documents"] == [SECRET]


def test_restore_test_fails_when_a_locked_label_cannot_be_decrypted(env, monkeypatch):
    add_labels(env)
    paths = make_world(env)
    out = str(env.tmp / "b.starkbackup")
    real = crypto.encrypt_text
    # a backup made with a different key for one label would read back as damaged: the restore test must say so
    other = crypto.new_key()
    calls = {"n": 0}

    def wrong_key_once(key, text, context=""):
        calls["n"] += 1
        return real(other if text == 'forged.pdf' else key, text, context)
    env.engine.dispose()
    s = sessionmaker(bind=env.engine)()
    monkeypatch.setattr(crypto, "encrypt_text", wrong_key_once)
    s.query(models.Document).one().filename = 'forged.pdf'
    s.commit(); s.close()
    monkeypatch.undo()
    bk.create_backup(out, PASS, paths=paths, secure_client=env.secure, kdf=LIGHT)
    with pytest.raises(bk.BackupError) as e:
        bk.restore_test(out, PASS)
    assert e.value.code == "mismatch"
