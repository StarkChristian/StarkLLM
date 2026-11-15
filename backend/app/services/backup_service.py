"""Encrypted backup and restore (B7).

One file (extension .starkbackup):

    header   "SLLMBKP" 0x01 | kdf id (1 = Argon2id) | time cost u32 | memory KiB u32 | lanes u8 | salt 16 bytes
    body     AES-256-GCM chunks (see core/crypto.py), key = Argon2id(passphrase, salt), header authenticated
             inside: a gzip-compressed tar with
                 db/starkllm.db           consistent snapshot of the database (SQLite online backup)
                 uploads/...              the uploaded documents exactly as stored (protected ones stay protected)
                 chroma/...               the vector store
                 protection/state.json    and, when protection at rest is on, protection/data-key.b64 (the data key;
                                          the backup is encrypted, so the key travels safely with its data)
                 manifest.json            last: format, versions, sizes and SHA-256 of every file, the SHA-256 of every
                                          document's own content, row counts and row hashes of every table,
                                          the number of chunks in every vector collection

A backup is only trusted after the *restore test*: the whole file is read (every chunk is authenticated), unpacked into a
temporary folder, and compared with the manifest: file hashes, document content hashes, database integrity and row
hashes, protected values decrypt, the vector store opens and has the same number of chunks. Nothing in the real data
folder is touched by the test. The same code runs after every backup, on request for an existing file, and before a
restore (a restore of a file that fails the test is refused).
"""
import base64
import contextlib
import gzip
import hashlib
import io
import json
import logging
import os
import shutil
import sqlite3
import struct
import tarfile
import tempfile
import zlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Iterator, Optional

from app.core import crypto
from app.core.config import settings
from app.core.protection import ProtectionState, protection as default_protection
from app.services import vault

logger = logging.getLogger(__name__)

FORMAT = 1
EXTENSION = ".starkbackup"
MIN_PASSPHRASE = 12
HEADER_STRUCT = struct.Struct(">BIIB16s")                     # kdf id, time cost, memory KiB, lanes, salt
HEADER_LEN = len(crypto.BACKUP_MAGIC) + HEADER_STRUCT.size
ALLOWED_TOP = ("db/", "uploads/", "chroma/", "protection/")


class BackupError(Exception):
    """A backup or restore that must not go on. `code` is stable (the UI translates it), `message` is plain English."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


# --- Where the data lives --------------------------------------------------------------------------------------------

@dataclass
class Paths:
    database: str
    uploads: str
    chroma: str
    protection_dir: str
    root: str                        # parent of the above: restore-staging and restore-undo live here

    @property
    def staging(self) -> str:
        return os.path.join(self.root, "restore-staging")

    @property
    def undo(self) -> str:
        return os.path.join(self.root, "restore-undo")


def default_paths() -> Paths:
    url = settings.SQLITE_URL
    db = os.path.abspath(url.split("///", 1)[1]) if url.startswith("sqlite:///") else ""
    chroma = os.path.abspath(settings.CHROMA_PERSIST_DIRECTORY)
    return Paths(database=db, uploads=os.path.abspath(settings.UPLOAD_DIR), chroma=chroma,
                 protection_dir=os.path.abspath(settings.PROTECTION_DIR), root=os.path.dirname(chroma))


# --- Passphrase and container ----------------------------------------------------------------------------------------

def check_passphrase(passphrase: str):
    if not isinstance(passphrase, str) or len(passphrase) < MIN_PASSPHRASE:
        raise BackupError("weak_passphrase", f"Use a passphrase of at least {MIN_PASSPHRASE} characters. "
                          "Anyone who gets the backup file can try to guess it.")


def _make_header(kdf: dict) -> tuple:
    salt = os.urandom(16)
    header = crypto.BACKUP_MAGIC + HEADER_STRUCT.pack(crypto.KDF_ARGON2ID, kdf["time_cost"], kdf["memory_kib"],
                                                      kdf["parallelism"], salt)
    return header, salt


def _read_header(raw) -> tuple:
    header = raw.read(HEADER_LEN)
    if len(header) < len(crypto.BACKUP_MAGIC) or header[:len(crypto.BACKUP_MAGIC) - 1] != crypto.BACKUP_MAGIC[:-1]:
        raise BackupError("not_a_backup", "This is not a StarkLLM backup file.")
    if header[len(crypto.BACKUP_MAGIC) - 1] != crypto.BACKUP_MAGIC[-1]:
        raise BackupError("newer_version", "This backup was made by a newer version of StarkLLM. Update StarkLLM first.")
    if len(header) < HEADER_LEN:
        raise BackupError("damaged", "The backup file is damaged or incomplete.")
    kdf_id, t, m, p, salt = HEADER_STRUCT.unpack(header[len(crypto.BACKUP_MAGIC):])
    if kdf_id != crypto.KDF_ARGON2ID:
        raise BackupError("newer_version", "This backup uses a method this version of StarkLLM does not know.")
    return header, {"time_cost": t, "memory_kib": m, "parallelism": p}, salt


class _Reader(io.RawIOBase):
    """File-like view of the decrypted chunks (tarfile reads from it)."""

    def __init__(self, chunks: Iterator[bytes]):
        self._chunks, self._buf = chunks, b""

    def readable(self):
        return True

    def readinto(self, b):
        while not self._buf:
            try:
                self._buf = next(self._chunks)
            except StopIteration:
                return 0
        n = min(len(b), len(self._buf))
        b[:n], self._buf = self._buf[:n], self._buf[n:]
        return n


def _hash_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def table_digests(db_path: str) -> dict:
    """Row count and SHA-256 over all rows of every table: what 'the same database rows' means in the restore test."""
    out = {}
    con = sqlite3.connect(db_path)
    try:
        for (name,) in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' "
                                   "ORDER BY name").fetchall():
            h, n = hashlib.sha256(), 0
            try:
                rows = con.execute(f'SELECT * FROM "{name}" ORDER BY rowid')
            except sqlite3.OperationalError:
                rows = con.execute(f'SELECT * FROM "{name}"')
            for row in rows:
                h.update(repr(row).encode("utf-8", "surrogatepass"))
                n += 1
            out[name] = {"rows": n, "sha256": h.hexdigest()}
    finally:
        con.close()
    return out


# --- Create ----------------------------------------------------------------------------------------------------------

def _sqlite_snapshot(src: str, dst: str):
    s, d = sqlite3.connect(src), sqlite3.connect(dst)
    try:
        s.backup(d)
    finally:
        d.close()
        s.close()


def _walk(root: str):
    for base, _dirs, files in os.walk(root):
        for name in sorted(files):
            if name.endswith((".protecting", ".unprotecting", "-wal", "-shm")):
                continue
            full = os.path.join(base, name)
            yield full, os.path.relpath(full, root).replace(os.sep, "/")


def _collection_counts(chroma_client) -> dict:
    if chroma_client is None:
        return {}
    return {getattr(c, "name", c): chroma_client.get_collection(getattr(c, "name", c)).count()
            for c in chroma_client.list_collections()}


def create_backup(out_path: str, passphrase: str, paths: Paths = None, chroma_client=None, state: ProtectionState = None,
                  app_version: str = "", kdf: Optional[dict] = None, busy_check: Optional[Callable[[], int]] = None) -> dict:
    """Write an encrypted backup to out_path. Returns the manifest. Does not run the restore test (see create_and_test)."""
    check_passphrase(passphrase)
    paths, state, kdf = paths or default_paths(), state or default_protection, kdf or crypto.DEFAULT_KDF
    if busy_check and busy_check():
        raise BackupError("busy", "Documents are still being processed. Make the backup when they are finished.")
    if state.locked:
        raise BackupError("locked", "StarkLLM is locked: unlock it first, a backup needs the key to check your documents.")
    header, salt = _make_header(kdf)
    key = crypto.passphrase_key(passphrase, salt, **kdf)
    manifest = {"format": FORMAT, "app_version": app_version, "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "files": {}, "documents": {}, "tables": {}, "collections": _collection_counts(chroma_client),
                "protection": {"enabled": state.enabled, "key_id": state.state().get("key_id")}}
    scratch = tempfile.mkdtemp(dir=vault.temp_dir())
    tmp_out = out_path + ".part"
    try:
        with open(tmp_out, "wb") as raw, crypto.StreamWriter(raw, key, header) as stream, \
                tarfile.open(fileobj=stream, mode="w|gz") as tar:
            def add(src: str, arcname: str):
                info = tar.gettarinfo(src, arcname=arcname)
                info.uid = info.gid = 0
                info.uname = info.gname = ""
                with open(src, "rb") as f:
                    tar.addfile(info, f)
                manifest["files"][arcname] = {"size": os.path.getsize(src), "sha256": _hash_file(src)}

            def add_bytes(data: bytes, arcname: str):
                info = tarfile.TarInfo(arcname)
                info.size, info.mtime = len(data), int(datetime.now().timestamp())
                tar.addfile(info, io.BytesIO(data))
                manifest["files"][arcname] = {"size": len(data), "sha256": hashlib.sha256(data).hexdigest()}

            if paths.database and os.path.exists(paths.database):
                snap = os.path.join(scratch, "starkllm.db")
                _sqlite_snapshot(paths.database, snap)
                manifest["tables"] = table_digests(snap)
                add(snap, "db/starkllm.db")
            if os.path.isdir(paths.uploads):
                for full, rel in _walk(paths.uploads):
                    add(full, "uploads/" + rel)
                    manifest["documents"]["uploads/" + rel] = {"sha256": vault.sha256(full), "size": vault.size(full)}
            if os.path.isdir(paths.chroma):
                for full, rel in _walk(paths.chroma):
                    if rel == "chroma.sqlite3":
                        snap = os.path.join(scratch, "chroma.sqlite3")
                        _sqlite_snapshot(full, snap)
                        add(snap, "chroma/" + rel)
                    else:
                        add(full, "chroma/" + rel)
            if state.enabled and os.path.exists(state.state_path):
                add_bytes(json.dumps(state.state(), indent=2).encode(), "protection/state.json")
                add_bytes(base64.b64encode(state.key), "protection/data-key.b64")
            add_bytes(json.dumps(manifest, indent=2).encode(), "manifest.json")
        os.replace(tmp_out, out_path)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
        if os.path.exists(tmp_out):
            os.remove(tmp_out)
    return manifest


# --- Read, restore test ----------------------------------------------------------------------------------------------

def _safe_member(name: str) -> bool:
    return (name == "manifest.json" or name.startswith(ALLOWED_TOP)) and ".." not in name.split("/") \
        and not name.startswith("/") and "\\" not in name and ":" not in name


def extract_backup(path: str, passphrase: str, dest: str) -> dict:
    """Authenticate the whole file and unpack it into `dest`. Returns the manifest. Nothing outside `dest` is written."""
    try:
        raw = open(path, "rb")
    except OSError as e:
        raise BackupError("unreadable", f"The backup file cannot be opened: {e.strerror or e}")
    with raw:
        header, kdf, salt = _read_header(raw)
        try:
            key = crypto.passphrase_key(passphrase, salt, **kdf)
        except crypto.CorruptData:
            raise BackupError("damaged", "The backup file is damaged.")
        chunks = crypto.read_stream(raw, key, HEADER_LEN, header)
        try:
            with tarfile.open(fileobj=io.BufferedReader(_Reader(chunks)), mode="r|gz") as tar:
                for member in tar:
                    if not _safe_member(member.name) or not member.isreg():
                        raise BackupError("damaged", "The backup contains an unexpected entry.")
                    target = os.path.join(dest, *member.name.split("/"))
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    with open(target, "wb") as out:
                        shutil.copyfileobj(tar.extractfile(member), out)
            for _ in chunks:        # tar stops at its end marker: read on, so the final chunk is checked as well
                pass
        except crypto.WrongKey:
            raise BackupError("wrong_passphrase", "Wrong passphrase, or the backup file was changed. Nothing was restored.")
        except crypto.CorruptData:
            raise BackupError("damaged", "The backup file is damaged, incomplete or was changed. Nothing was restored.")
        except (tarfile.TarError, EOFError, gzip.BadGzipFile, zlib.error):
            raise BackupError("damaged", "The backup file is damaged or incomplete. Nothing was restored.")
    manifest_path = os.path.join(dest, "manifest.json")
    if not os.path.exists(manifest_path):
        raise BackupError("damaged", "The backup file is incomplete (no manifest).")
    try:
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)
        manifest["files"], manifest["documents"], manifest["tables"], manifest["collections"]
    except (ValueError, KeyError):
        raise BackupError("damaged", "The backup's manifest is damaged.")
    if manifest.get("format", 0) > FORMAT:
        raise BackupError("newer_version", "This backup was made by a newer version of StarkLLM. Update StarkLLM first.")
    return manifest


def _check_against_manifest(dest: str, manifest: dict) -> dict:
    """The comparison of the restore test. Returns counts; raises BackupError at the first difference."""
    seen = {rel for _full, rel in _walk(dest) if rel != "manifest.json"}
    expected = set(manifest["files"])
    if seen != expected:
        raise BackupError("mismatch", "The backup does not contain the files it lists: "
                          f"{len(expected - seen)} missing, {len(seen - expected)} unexpected.")
    for rel, info in manifest["files"].items():
        full = os.path.join(dest, *rel.split("/"))
        if os.path.getsize(full) != info["size"] or _hash_file(full) != info["sha256"]:
            raise BackupError("mismatch", f"A file in the backup does not match its checksum: {rel}")
    report = {"files": len(expected), "documents": 0, "rows": 0, "tables": 0, "collections": 0, "protected": False}

    key = None
    prot = manifest.get("protection") or {}
    if prot.get("enabled"):
        try:
            key = base64.b64decode(open(os.path.join(dest, "protection", "data-key.b64"), "rb").read())
            if crypto.key_id(key) != prot.get("key_id"):
                raise ValueError("key id")
        except Exception:
            raise BackupError("mismatch", "The backup's key does not match its data.")
        report["protected"] = True

    # documents: the content of every document (decrypted if protected) against the hash taken from the live data
    for rel, info in manifest["documents"].items():
        full = os.path.join(dest, *rel.split("/"))
        h, size = hashlib.sha256(), 0
        try:
            for block in _content_blocks(full, key):
                h.update(block)
                size += len(block)
        except crypto.CryptoError:
            raise BackupError("mismatch", f"A document in the backup cannot be decrypted: {rel}")
        if h.hexdigest() != info["sha256"] or size != info["size"]:
            raise BackupError("mismatch", f"A document in the backup does not match: {rel}")
        report["documents"] += 1

    # database: integrity, row hashes, and every protected value must decrypt
    db = os.path.join(dest, "db", "starkllm.db")
    if os.path.exists(db):
        con = sqlite3.connect(db)
        try:
            if con.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise BackupError("mismatch", "The database in the backup is damaged.")
            if key is not None:
                fields = crypto.derive_key(key, "fields")
                for table, col, ctx in _protected_columns():
                    try:
                        rows = con.execute(f'SELECT "{col}" FROM "{table}" WHERE "{col}" IS NOT NULL').fetchall()
                    except sqlite3.OperationalError:
                        continue
                    for (value,) in rows:
                        if crypto.is_token(value):
                            crypto.decrypt_text(fields, value, ctx)
        except crypto.CryptoError:
            raise BackupError("mismatch", "A protected value in the backup's database cannot be decrypted.")
        finally:
            con.close()
        digests = table_digests(db)
        if digests != manifest["tables"]:
            bad = sorted(t for t in set(digests) | set(manifest["tables"]) if digests.get(t) != manifest["tables"].get(t))
            raise BackupError("mismatch", f"Database rows in the backup do not match: {', '.join(bad)}")
        report["tables"], report["rows"] = len(digests), sum(t["rows"] for t in digests.values())

    # vector store: opens, and has as many chunks as when the backup was made
    chroma_dir = os.path.join(dest, "chroma")
    if manifest["collections"] and os.path.isdir(chroma_dir):
        report["collections"] = _check_vector_store(chroma_dir, manifest["collections"])
    return report


def _content_blocks(path: str, key: Optional[bytes]):
    """The content of a document in the unpacked backup: decrypted if it is protected."""
    if crypto.is_encrypted_file(path):
        if key is None:
            raise crypto.CorruptData("A protected document but no key.")
        yield from crypto.iter_decrypted(path, crypto.derive_key(key, "files"))
        return
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            yield block


def _protected_columns():
    from app.db.session import Base
    from app.services.protection_migration import protected_columns
    return protected_columns(Base)


def _check_vector_store(chroma_dir: str, expected: dict) -> int:
    import chromadb
    copy = tempfile.mkdtemp(dir=vault.temp_dir(), prefix="vectors-")   # opening a store writes to it: open a copy
    try:
        shutil.copytree(chroma_dir, os.path.join(copy, "c"))
        client = chromadb.PersistentClient(path=os.path.join(copy, "c"),
                                           settings=chromadb.config.Settings(anonymized_telemetry=False))
        got = _collection_counts(client)
    except Exception as e:
        raise BackupError("mismatch", f"The vector store in the backup cannot be opened: {e}")
    finally:
        with contextlib.suppress(Exception):
            from chromadb.api.shared_system_client import SharedSystemClient
            SharedSystemClient.clear_system_cache()
        shutil.rmtree(copy, ignore_errors=True)
    if got != expected:
        raise BackupError("mismatch", "The vector store in the backup has different content than when it was saved.")
    return len(got)


def restore_test(path: str, passphrase: str) -> dict:
    """Unpack the backup into a temporary folder and compare everything with its manifest. The real data is not touched."""
    scratch = tempfile.mkdtemp(dir=vault.temp_dir(), prefix="restore-test-")
    try:
        manifest = extract_backup(path, passphrase, scratch)
        report = _check_against_manifest(scratch, manifest)
        report.update(ok=True, created=manifest.get("created"), app_version=manifest.get("app_version"),
                      size=os.path.getsize(path))
        return report
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def create_and_test(out_path: str, passphrase: str, **kwargs) -> dict:
    """Make a backup and run the restore test on the file just written. A backup that fails the test is deleted."""
    manifest = create_backup(out_path, passphrase, **kwargs)
    try:
        report = restore_test(out_path, passphrase)
    except BackupError:
        with contextlib.suppress(OSError):
            os.remove(out_path)
        raise
    report["manifest"] = {"documents": len(manifest["documents"]), "tables": len(manifest["tables"])}
    return report


# --- Restore ---------------------------------------------------------------------------------------------------------

COMPONENTS = ("database", "uploads", "chroma", "protection")


def _component_paths(paths: Paths) -> dict:
    return {"database": paths.database, "uploads": paths.uploads, "chroma": paths.chroma,
            "protection": paths.protection_dir}


def _staged_component_paths(stage: str) -> dict:
    return {"database": os.path.join(stage, "db", "starkllm.db"), "uploads": os.path.join(stage, "uploads"),
            "chroma": os.path.join(stage, "chroma"), "protection": os.path.join(stage, "protection")}


def stage_restore(path: str, passphrase: str, paths: Paths = None) -> dict:
    """Test the backup, then unpack it next to the data, ready to be put in place. Refuses a backup that fails the test."""
    paths = paths or default_paths()
    shutil.rmtree(paths.staging, ignore_errors=True)
    os.makedirs(paths.staging)
    try:
        manifest = extract_backup(path, passphrase, paths.staging)   # authenticates the whole file first
        report = _check_against_manifest(paths.staging, manifest)    # the restore test, on the staged files
        for part in ("uploads", "chroma"):
            os.makedirs(os.path.join(paths.staging, part), exist_ok=True)
        with open(os.path.join(paths.staging, "READY"), "w") as f:
            f.write(manifest.get("created", ""))
    except Exception:
        shutil.rmtree(paths.staging, ignore_errors=True)
        raise
    report.update(ok=True, staged=True, created=manifest.get("created"), app_version=manifest.get("app_version"))
    return report


def staged_data_key(paths: Paths = None) -> Optional[str]:
    """The data key (base64) of a staged restore, if the backup was protected: the desktop app stores it in the
    Windows key store so the restored data can be opened after the restart."""
    key_file = os.path.join((paths or default_paths()).staging, "protection", "data-key.b64")
    if os.path.exists(key_file):
        with open(key_file, "rb") as f:
            return f.read().decode("ascii")
    return None


def pending_restore(paths: Paths = None) -> bool:
    return os.path.exists(os.path.join((paths or default_paths()).staging, "READY"))


def apply_pending_restore(paths: Paths = None) -> Optional[dict]:
    """Put a staged restore in place. The current data is moved to restore-undo/<time>, not deleted. If a move fails
    (a locked file on Windows) everything is moved back and the restore stays pending for the next start."""
    paths = paths or default_paths()
    if not pending_restore(paths):
        return None
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    undo = os.path.join(paths.undo, stamp)
    current, staged = _component_paths(paths), _staged_component_paths(paths.staging)
    done = []                                                      # (component, moved-away-to or None)
    try:
        os.makedirs(undo, exist_ok=True)
        for comp in COMPONENTS:
            dst, src = current[comp], staged[comp]
            if comp == "database" and not dst:
                continue
            away = os.path.join(undo, comp)
            had = os.path.exists(dst)
            if had:
                shutil.move(dst, away)
            done.append([comp, away if had else None, False])
            if os.path.exists(src):
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.move(src, dst)
                done[-1][2] = True
            elif comp in ("uploads", "chroma"):
                os.makedirs(dst, exist_ok=True)
        for side in ("-wal", "-shm"):                              # leftovers of the old database must not meet the new one
            with contextlib.suppress(OSError):
                os.remove(paths.database + side)
    except OSError as e:
        logger.error("Restore could not be put in place (%s); putting the current data back", e)
        for comp, away, moved_in in reversed(done):
            dst = current[comp]
            with contextlib.suppress(OSError):
                if moved_in:                                       # back to staging: the next start uses it
                    shutil.move(dst, staged[comp])
                elif os.path.exists(dst):
                    shutil.rmtree(dst) if os.path.isdir(dst) else os.remove(dst)
            if away and os.path.exists(away):
                with contextlib.suppress(OSError):
                    shutil.move(away, dst)
        raise BackupError("locked_files", "The data files are in use. StarkLLM will put the backup in place the next "
                          "time it starts; close it completely and open it again.")
    shutil.rmtree(paths.staging, ignore_errors=True)
    result = {"applied": True, "undo": undo, "data_key": None}
    key_file = os.path.join(paths.protection_dir, "data-key.b64")
    if os.path.exists(key_file):                                   # the data key comes from the backup, never stays on disk
        with open(key_file, "rb") as f:
            result["data_key"] = f.read().decode("ascii")
        os.remove(key_file)
    return result


def discard_undo(paths: Paths = None) -> bool:
    paths = paths or default_paths()
    existed = os.path.isdir(paths.undo)
    shutil.rmtree(paths.undo, ignore_errors=True)
    return existed
