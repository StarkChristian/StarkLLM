"""Encrypted backup and restore (B7): the file, the restore test, wrong passphrases, damaged files, and putting a
backup in place."""
import base64
import hashlib
import os
import shutil
import sqlite3

import pytest

from app.core.chroma_store import open_chroma
from app.core import crypto
from app.core.config import settings
from app.core.protection import protection
from app.services import backup_service as bk
from app.services import protection_migration as mig
from app.services import vault

LIGHT = dict(time_cost=1, memory_kib=64, parallelism=1)        # cheap Argon2id settings for tests
PASS = "correct horse battery staple"
LETTER = b"Kuendigung Mietvertrag Frau Mueller IBAN DE41600500000001234567"


class World:
    """A data folder like the real one: database, uploads, vector store; optionally protected."""

    def __init__(self, root):
        self.root = str(root)
        self.paths = bk.Paths(database=os.path.join(self.root, "starkllm.db"), uploads=os.path.join(self.root, "uploads"),
                              chroma=os.path.join(self.root, "chroma"), protection_dir=os.path.join(self.root, "protection"),
                              root=self.root)
        os.makedirs(self.paths.uploads)
        con = sqlite3.connect(self.paths.database)
        con.execute("create table users (id integer primary key, username text)")
        con.execute("create table messages (id integer primary key, chat_id integer, content text)")
        con.execute("insert into users values (1, 'owner')")
        con.commit(); con.close()
        self.client = open_chroma(self.paths.chroma)

    def add_message(self, text):
        con = sqlite3.connect(self.paths.database)
        con.execute("insert into messages (chat_id, content) values (1, ?)", (text,))
        con.commit(); con.close()

    def add_document(self, name, data):
        path = os.path.join(self.paths.uploads, name)
        vault.write_bytes(path, data)
        return path

    def add_chunks(self, name="user_1_workspace_1"):
        coll = self.client.get_or_create_collection(name)
        coll.add(ids=["a", "b"], documents=["one", "two"], embeddings=[[0.1, 0.2, 0.3], [0.3, 0.2, 0.1]],
                 metadatas=[{"page": 1}, {"page": 2}])

    def fill(self):
        self.add_message("hello")
        self.add_document("1_letter.txt", LETTER)
        self.add_document("2_scan.pdf", os.urandom(2 * crypto.CHUNK + 11))
        self.add_chunks()

    def messages(self):
        con = sqlite3.connect(self.paths.database)
        try:
            return [r[0] for r in con.execute("select content from messages order by id")]
        finally:
            con.close()


@pytest.fixture()
def world(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "TEMP_DIR", str(tmp_path / "tmp"))
    protection.set_directory(str(tmp_path / "data" / "protection"))
    protection.clear_key()
    w = World(tmp_path / "data")
    yield w
    protection.set_directory(None)
    protection.clear_key()
    protection._state_cache = None


def make(world, out=None, passphrase=PASS, **kw):
    out = out or os.path.join(os.path.dirname(world.root), "backup" + bk.EXTENSION)
    bk.create_backup(out, passphrase, paths=world.paths, chroma_client=world.client, kdf=LIGHT, app_version="9.9", **kw)
    return out


def protect(world):
    protection.set_key(crypto.new_key())
    protection.mark_enabled(True)


# --- the happy path ---------------------------------------------------------------------------------------------

def test_backup_of_plain_data_passes_the_restore_test(world):
    world.fill()
    path = make(world)
    report = bk.restore_test(path, PASS)
    assert report["ok"] and report["documents"] == 2 and report["tables"] == 2 and report["rows"] == 2
    assert report["collections"] == 1 and report["protected"] is False
    assert report["app_version"] == "9.9" and report["size"] == os.path.getsize(path)


def test_backup_file_reveals_nothing_without_the_passphrase(world):
    world.fill()
    path = make(world)
    blob = open(path, "rb").read()
    assert blob.startswith(crypto.BACKUP_MAGIC)
    for needle in (LETTER, b"Mueller", b"starkllm", b"SQLite format", b"uploads/"):
        assert needle not in blob


def test_backup_of_protected_data_keeps_documents_protected_and_carries_the_key(world):
    protect(world)
    world.fill()
    path = make(world)
    report = bk.restore_test(path, PASS)
    assert report["ok"] and report["protected"] is True and report["documents"] == 2


def test_two_backups_of_the_same_data_differ(world):
    world.fill()
    a = open(make(world), "rb").read()
    b = open(make(world, out=os.path.join(world.root, "..", "b" + bk.EXTENSION)), "rb").read()
    assert a != b and a[:len(crypto.BACKUP_MAGIC)] == b[:len(crypto.BACKUP_MAGIC)]


def test_create_and_test_runs_the_restore_test_and_nothing_is_left_behind(world):
    world.fill()
    out = os.path.join(os.path.dirname(world.root), "x" + bk.EXTENSION)
    report = bk.create_and_test(out, PASS, paths=world.paths, chroma_client=world.client, kdf=LIGHT)
    assert report["ok"] and os.path.exists(out)
    tmp = settings.TEMP_DIR
    assert not [d for d in os.listdir(tmp) if d.startswith(("restore-test", "vectors-"))]


def test_restore_test_does_not_touch_the_data(world):
    world.fill()
    path = make(world)
    before = sorted((p, hashlib.sha256(open(p, "rb").read()).hexdigest())
                    for p, _ in bk._walk(world.root) if not p.endswith(bk.EXTENSION))
    bk.restore_test(path, PASS)
    after = sorted((p, hashlib.sha256(open(p, "rb").read()).hexdigest())
                   for p, _ in bk._walk(world.root) if not p.endswith(bk.EXTENSION))
    assert before == after


# --- refusals ---------------------------------------------------------------------------------------------------

def expect(code, fn, *args):
    with pytest.raises(bk.BackupError) as e:
        fn(*args)
    assert e.value.code == code, e.value.message
    return e.value


def test_wrong_passphrase_is_refused_with_a_clear_message(world):
    world.fill()
    path = make(world)
    err = expect("wrong_passphrase", bk.restore_test, path, "another passphrase entirely")
    assert "passphrase" in err.message.lower() and "Nothing was restored" in err.message


def test_weak_passphrase_is_refused_when_creating(world):
    world.fill()
    expect("weak_passphrase", bk.create_backup, os.path.join(world.root, "x"), "short", world.paths)


def test_not_a_backup_and_empty_and_garbage(world, tmp_path):
    (tmp_path / "a.bin").write_bytes(b"")
    (tmp_path / "b.bin").write_bytes(os.urandom(500))
    (tmp_path / "c.zip").write_bytes(b"PK\x03\x04" + os.urandom(100))
    for name in ("a.bin", "b.bin", "c.zip"):
        expect("not_a_backup", bk.restore_test, str(tmp_path / name), PASS)
    expect("unreadable", bk.restore_test, str(tmp_path / "missing.bin"), PASS)


def test_newer_format_is_refused(world):
    world.fill()
    path = make(world)
    blob = bytearray(open(path, "rb").read())
    blob[len(crypto.BACKUP_MAGIC) - 1] = 2
    open(path, "wb").write(bytes(blob))
    expect("newer_version", bk.restore_test, path, PASS)


def test_every_kind_of_damage_is_detected(world):
    world.fill()
    path = make(world)
    blob = open(path, "rb").read()
    n = len(blob)
    damaged = {}
    for pos in (10, 20, bk.HEADER_LEN - 1, bk.HEADER_LEN + 3, n // 3, n // 2, n - 40, n - 1):   # header, salt, body, tag
        b = bytearray(blob); b[pos] ^= 0x01
        damaged[f"flip@{pos}"] = bytes(b)
    for cut in (n - 1, n - 16, n - 17, n // 2, bk.HEADER_LEN + 5, bk.HEADER_LEN, 12, 3, 0):
        damaged[f"cut@{cut}"] = blob[:cut]
    damaged["appended"] = blob + b"more"
    damaged["appended-chunk"] = blob + blob[bk.HEADER_LEN:bk.HEADER_LEN + 200]
    bad = path + ".bad"
    for label, data in damaged.items():
        open(bad, "wb").write(data)
        with pytest.raises(bk.BackupError) as e:
            bk.restore_test(bad, PASS)
        assert e.value.code in ("wrong_passphrase", "damaged", "not_a_backup", "newer_version"), label


def test_a_backup_cut_at_a_chunk_boundary_is_detected(world):
    world.add_document("big.bin", os.urandom(4 * crypto.CHUNK))      # random data does not compress: several chunks
    path = make(world)
    blob = open(path, "rb").read()
    boundary = bk.HEADER_LEN + 2 * (crypto.CHUNK + crypto.TAG_LEN)
    assert len(blob) > boundary + 100
    open(path, "wb").write(blob[:boundary])
    expect("damaged", bk.restore_test, path, PASS)


def test_restore_test_catches_a_document_that_changed_during_the_backup(world, monkeypatch):
    world.fill()
    monkeypatch.setattr(vault, "sha256", lambda p: "0" * 64)
    path = make(world)
    monkeypatch.undo()
    err = expect("mismatch", bk.restore_test, path, PASS)
    assert "document" in err.message.lower()


def test_restore_test_catches_different_database_rows(world, monkeypatch):
    world.fill()
    real = bk.table_digests
    calls = {"n": 0}

    def lying(db):
        out = real(db)
        calls["n"] += 1
        if calls["n"] == 1:
            out["messages"] = {"rows": 99, "sha256": "f" * 64}
        return out
    monkeypatch.setattr(bk, "table_digests", lying)
    path = make(world)
    err = expect("mismatch", bk.restore_test, path, PASS)
    assert "messages" in err.message


def test_restore_test_catches_a_different_vector_store(world, monkeypatch):
    world.fill()
    real = bk._collection_counts
    monkeypatch.setattr(bk, "_collection_counts", lambda c: {**real(c), "user_1_workspace_1": 5} if c is world.client else real(c))
    path = make(world)
    monkeypatch.undo()
    expect("mismatch", bk.restore_test, path, PASS)


def test_backup_refuses_while_documents_are_processed_and_while_locked(world):
    world.fill()
    expect("busy", bk.create_backup, os.path.join(world.root, "x"), PASS, world.paths, None, None, "", LIGHT, lambda: 2)
    protect(world)
    protection.clear_key()
    expect("locked", bk.create_backup, os.path.join(world.root, "x"), PASS, world.paths)


def test_failed_backup_leaves_no_partial_file(world, monkeypatch):
    world.fill()
    out = os.path.join(os.path.dirname(world.root), "x" + bk.EXTENSION)
    monkeypatch.setattr(bk, "table_digests", lambda db: (_ for _ in ()).throw(RuntimeError("boom")))
    with pytest.raises(RuntimeError):
        bk.create_backup(out, PASS, paths=world.paths, kdf=LIGHT)
    assert not os.path.exists(out) and not os.path.exists(out + ".part")


# --- restore -----------------------------------------------------------------------------------------------------

def _tree(world):
    out = {}
    for base, _d, files in os.walk(world.paths.uploads):
        for f in files:
            out[f] = hashlib.sha256(open(os.path.join(base, f), "rb").read()).hexdigest()
    return out


def test_restore_puts_the_backup_in_place_and_keeps_the_old_data(world):
    world.fill()
    path = make(world)
    docs_then, msgs_then = _tree(world), world.messages()
    # later: the user deletes a letter and writes more
    os.remove(os.path.join(world.paths.uploads, "1_letter.txt"))
    world.add_message("written after the backup")
    world.add_document("3_new.txt", b"new")
    world.client = None
    import gc; gc.collect()
    report = bk.stage_restore(path, PASS, world.paths)
    assert report["staged"] and bk.pending_restore(world.paths)
    result = bk.apply_pending_restore(world.paths)
    assert result["applied"] and not bk.pending_restore(world.paths)
    assert _tree(world) == docs_then and world.messages() == msgs_then
    undo = result["undo"]
    assert os.path.exists(os.path.join(undo, "database")) and os.path.exists(os.path.join(undo, "uploads", "3_new.txt"))
    assert bk.discard_undo(world.paths) and not os.path.exists(world.paths.undo)


def test_restore_of_a_protected_backup_returns_the_key_and_reads_the_documents(world):
    protect(world)
    key = protection.key
    world.fill()
    path = make(world)
    protection.clear_key(); protection.mark_enabled  # a "new PC": no state, no key
    shutil.rmtree(world.paths.protection_dir)
    protection._state_cache = None
    bk.stage_restore(path, PASS, world.paths)
    assert bk.staged_data_key(world.paths) == base64.b64encode(key).decode()
    result = bk.apply_pending_restore(world.paths)
    protection._state_cache = None
    protection.set_key(base64.b64decode(result["data_key"]))
    assert protection.enabled and not protection.locked
    assert vault.read_bytes(os.path.join(world.paths.uploads, "1_letter.txt")) == LETTER
    assert not os.path.exists(os.path.join(world.paths.protection_dir, "data-key.b64"))   # the key is not left on disk


def test_wrong_passphrase_or_damaged_file_changes_nothing_when_restoring(world):
    world.fill()
    path = make(world)
    world.add_message("keep me")
    before = (_tree(world), world.messages())
    expect("wrong_passphrase", bk.stage_restore, path, "not the passphrase", world.paths)
    blob = bytearray(open(path, "rb").read()); blob[len(blob) // 2] ^= 1
    open(path, "wb").write(bytes(blob))
    expect("damaged", bk.stage_restore, path, PASS, world.paths)
    assert (_tree(world), world.messages()) == before
    assert not os.path.exists(world.paths.staging) and not bk.pending_restore(world.paths)


def test_locked_files_leave_the_data_as_it_was_and_the_restore_pending(world, monkeypatch):
    world.fill()
    path = make(world)
    world.add_message("current")
    before = (_tree(world), world.messages())
    world.client = None
    import gc; gc.collect()
    bk.stage_restore(path, PASS, world.paths)
    real_move, calls = shutil.move, {"n": 0}

    def flaky(src, dst, *a, **k):
        calls["n"] += 1
        if calls["n"] == 4:                                        # fails half way through
            raise PermissionError("file is in use")
        return real_move(src, dst, *a, **k)
    monkeypatch.setattr(shutil, "move", flaky)
    expect("locked_files", bk.apply_pending_restore, world.paths)
    monkeypatch.undo()
    assert (_tree(world), world.messages()) == before
    assert bk.pending_restore(world.paths)
    assert bk.apply_pending_restore(world.paths)["applied"]         # the next start finishes it
    assert world.messages() == ["hello"]


def test_malicious_archive_member_names_are_refused(world, tmp_path):
    import io, tarfile
    header, salt = bk._make_header(LIGHT)
    key = crypto.passphrase_key(PASS, salt, **LIGHT)
    for name in ("../evil.txt", "/abs.txt", "uploads/../../evil.txt", "other/x"):
        out = tmp_path / "evil.starkbackup"
        with open(out, "wb") as raw, crypto.StreamWriter(raw, key, header) as stream, \
                tarfile.open(fileobj=stream, mode="w|gz") as tar:
            info = tarfile.TarInfo(name); info.size = 3
            tar.addfile(info, io.BytesIO(b"bad"))
        expect("damaged", bk.restore_test, str(out), PASS)
        assert not (tmp_path / "evil.txt").exists()
