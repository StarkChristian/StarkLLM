"""Switching protection at rest on or off for the data that already exists (B6).

enable   protects what is stored: text columns in the database, uploaded documents, chunk text in the vector store.
disable  the same in reverse; it is also the rollback of a migration that went wrong.

Rules that make this safe:
* `dry_run` only counts and checks; it changes nothing (a test compares the data folder before and after).
* Every reader accepts protected and plain values, so the migration may stop at any point (error, crash, power loss)
  and the app still works; running it again continues where it stopped (converted items are skipped).
* A file is replaced only after the new copy was read back and compared with the original.
* A database value is changed only if it still has the value the migration read (compare-and-set), so a message
  written in the same second is never overwritten.
* Before anything is changed, the database is copied, encrypted, to data/protection/pre-migration.db.enc. It stays
  until the user finalizes (it is the "undo" for the database).
"""
import logging
import os
import shutil
import sqlite3
import tempfile
import time
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Optional

from sqlalchemy import text

from app.core import crypto
from app.core.config import settings
from app.core.protection import ProtectedText, ProtectionLocked, ProtectionState, protection as default_protection
from app.services import vault

logger = logging.getLogger(__name__)
BATCH = 200
_RUN_LOCK = threading.Lock()


class MigrationError(Exception):
    pass


@dataclass
class Targets:
    """What a migration touches. The defaults are the running engine; tests pass their own."""
    engine: object
    base: object
    upload_dir: str
    chroma_client: object
    state: ProtectionState = None
    secure_factory: Optional[Callable[[], object]] = None   # the encrypted index (opened only when needed)

    def __post_init__(self):
        self.state = self.state or default_protection

    def secure(self):
        if self.secure_factory is None:
            from app.services.secure_index import secure_client
            return secure_client()
        return self.secure_factory()


def default_targets() -> Targets:
    from app.db.session import Base, engine
    from app.services.rag_service import rag_service
    return Targets(engine=engine, base=Base, upload_dir=os.path.abspath(settings.UPLOAD_DIR),
                   chroma_client=rag_service.chroma_client)


def protected_columns(base):
    """(table, column, context) of every ProtectedText column."""
    out = []
    for table in base.metadata.sorted_tables:
        for col in table.columns:
            if isinstance(col.type, ProtectedText) and "id" in table.columns:
                out.append((table.name, col.name, col.type.context))
    return out


def _is_plain(raw) -> bool:
    return isinstance(raw, str) and not crypto.is_token(raw)


def _upload_files(upload_dir: str):
    for root, _dirs, files in os.walk(upload_dir):
        for name in files:
            if not name.endswith((".protecting", ".unprotecting")):
                yield os.path.join(root, name)


def _collections(client):
    for c in client.list_collections():
        yield client.get_collection(getattr(c, "name", c))


def _chunks_of(collection, only_ids=None):
    ids = only_ids if only_ids is not None else collection.get(include=[]).get("ids", [])
    for i in range(0, len(ids), BATCH):
        yield ids[i:i + BATCH]


# --- Dry run -------------------------------------------------------------------------------------------------------

def plan(targets: Targets, direction: str) -> dict:
    """Count what a migration would change and check that it can run. Changes nothing."""
    if direction not in ("enable", "disable"):
        raise ValueError("direction must be 'enable' or 'disable'")
    want_plain = direction == "enable"      # enable converts plain items; disable converts protected ones
    report = {"direction": direction, "dry_run": True, "problems": [], "database": {}, "files": {"todo": 0, "done": 0,
              "bytes": 0}, "vectors": {"todo": 0, "done": 0}}
    if targets.state.key is None:
        report["problems"].append("The key is not available: unlock StarkLLM first.")
    with targets.engine.connect() as conn:
        for table, col, _ctx in protected_columns(targets.base):
            rows = conn.execute(text(f'SELECT "{col}" FROM "{table}" WHERE "{col}" IS NOT NULL')).fetchall()
            todo = sum(1 for (v,) in rows if _is_plain(v) == want_plain)
            report["database"][f"{table}.{col}"] = {"todo": todo, "done": len(rows) - todo}
    biggest = 0
    for path in _upload_files(targets.upload_dir):
        size = os.path.getsize(path)
        if vault.is_protected(path) == want_plain:       # already in the wanted state
            report["files"]["done"] += 1
        else:
            report["files"]["todo"] += 1
            report["files"]["bytes"] += size
            biggest = max(biggest, size)
    for coll in _collections(targets.chroma_client):
        for ids in _chunks_of(coll):
            docs = coll.get(ids=ids, include=["documents"]).get("documents") or []
            docs = [d for d in docs if isinstance(d, str)]
            plain = sum(1 for d in docs if _is_plain(d))
            report["vectors"]["todo" if want_plain else "done"] += plain
            report["vectors"]["done" if want_plain else "todo"] += len(docs) - plain
    free = shutil.disk_usage(targets.upload_dir if os.path.isdir(targets.upload_dir) else ".").free
    if biggest * 2 > free:
        report["problems"].append("Not enough free disk space to convert the largest document.")
    if _busy_documents(targets):
        report["problems"].append("Documents are still being processed. Try again when they are finished.")
    report["ok"] = not report["problems"]
    return report


def _busy_documents(targets: Targets) -> int:
    try:
        with targets.engine.connect() as conn:
            return conn.execute(text("SELECT COUNT(*) FROM documents WHERE status IN "
                                     "('uploading','extracting','chunking','embedding')")).scalar() or 0
    except Exception:
        return 0


# --- Run -----------------------------------------------------------------------------------------------------------

def _progress(store: ProtectionState, **fields):
    migration = dict(store.state().get("migration") or {})
    migration.update(fields)
    store.save_state(migration=migration)


def _convert_value(state: ProtectionState, raw, ctx: str, to_protected: bool):
    plain = state.open_text(raw, ctx)
    if to_protected:
        return crypto.encrypt_text(state.sub_key("fields"), plain, ctx)
    return crypto.PLAIN_ESCAPE + plain if plain.startswith((crypto.TOKEN_PREFIX, crypto.PLAIN_ESCAPE)) else plain


def _migrate_database(targets: Targets, to_protected: bool, counts: dict):
    for table, col, ctx in protected_columns(targets.base):
        with targets.engine.connect() as conn:
            rows = conn.execute(text(f'SELECT id, "{col}" FROM "{table}" WHERE "{col}" IS NOT NULL')).fetchall()
        todo = [(i, v) for i, v in rows if _is_plain(v) == to_protected]
        for start in range(0, len(todo), BATCH):
            with targets.engine.begin() as conn:
                for row_id, raw in todo[start:start + BATCH]:
                    new = _convert_value(targets.state, raw, ctx, to_protected)
                    conn.execute(text(f'UPDATE "{table}" SET "{col}" = :new WHERE id = :id AND "{col}" = :old'),
                                 {"new": new, "id": row_id, "old": raw})
                    counts["database"] += 1
            _progress(targets.state, step="database", done=counts["database"])


def _migrate_files(targets: Targets, to_protected: bool, counts: dict):
    for path in list(_upload_files(targets.upload_dir)):
        changed = vault.protect_file(path) if to_protected else vault.unprotect_file(path)
        if changed:
            counts["files"] += 1
            _progress(targets.state, step="files", done=counts["files"])


TMP_SUFFIX = "__protecting"


def _convert_batch(targets: Targets, got: dict, to_protected: bool, all_rows: bool):
    """(ids, documents, metadatas, embeddings) of one fetched batch with the documents converted."""
    docs = got["documents"] or []
    keep = [i for i, d in enumerate(docs) if isinstance(d, str) and (all_rows or _is_plain(d) == to_protected)]
    emb = got["embeddings"]
    out_docs = []
    for i in keep:
        d = docs[i]
        out_docs.append(_convert_value(targets.state, d, "vectors.document", to_protected)
                        if _is_plain(d) == to_protected else d)
    return ([got["ids"][i] for i in keep], out_docs, [got["metadatas"][i] for i in keep],
            [[float(x) for x in emb[i]] for i in keep])


def _copy_protected(targets: Targets, old, new, counts: dict, skip: set) -> set:
    copied = set()
    ids = [i for i in old.get(include=[]).get("ids", []) if i not in skip]
    for start in range(0, len(ids), BATCH):
        got = old.get(ids=ids[start:start + BATCH], include=["documents", "metadatas", "embeddings"])
        b_ids, b_docs, b_meta, b_emb = _convert_batch(targets, got, True, True)
        if b_ids:
            new.add(ids=b_ids, documents=b_docs, metadatas=b_meta, embeddings=b_emb)
            copied.update(b_ids)
            counts["vectors"] += len(b_ids)
            _progress(targets.state, step="vectors", done=counts["vectors"])
    return copied


def _migrate_vectors_enable(targets: Targets, counts: dict):
    """Protect the chunk text by copying each collection into a new one and deleting the old one. Updating in
    place would leave the old plain text in ChromaDB's write log (embeddings_queue), which a copy does not."""
    client = targets.chroma_client
    names = [getattr(c, "name", c) for c in client.list_collections()]
    for name in [n for n in names if n.endswith(TMP_SUFFIX)]:          # leftovers of an interrupted run
        base = name[:-len(TMP_SUFFIX)]
        if base in names:
            client.delete_collection(name)                              # incomplete copy: start over
        else:
            client.get_collection(name).modify(name=base)               # the original was already removed
    for name in [getattr(c, "name", c) for c in client.list_collections()]:
        old = client.get_collection(name)
        docs = old.get(include=["documents"]).get("documents") or []
        if not any(isinstance(d, str) and _is_plain(d) for d in docs):
            continue
        new = client.create_collection(name + TMP_SUFFIX, metadata=old.metadata)
        copied = _copy_protected(targets, old, new, counts, set())
        copied |= _copy_protected(targets, old, new, counts, copied)    # rows added while copying
        if new.count() < old.count():
            client.delete_collection(name + TMP_SUFFIX)
            raise MigrationError(f"The copy of '{name}' is incomplete.")
        client.delete_collection(name)
        new.modify(name=name)


def _migrate_vectors(targets: Targets, to_protected: bool, counts: dict):
    if to_protected:
        return _migrate_vectors_enable(targets, counts)
    for coll in _collections(targets.chroma_client):
        for ids in _chunks_of(coll):
            got = coll.get(ids=ids, include=["documents", "metadatas", "embeddings"])
            b_ids, b_docs, b_meta, b_emb = _convert_batch(targets, got, False, False)
            if b_ids:
                coll.upsert(ids=b_ids, documents=b_docs, metadatas=b_meta, embeddings=b_emb)
                counts["vectors"] += len(b_ids)
                _progress(targets.state, step="vectors", done=counts["vectors"])


def _checkpoint(con, attempts: int = 20, pause: float = 0.25) -> bool:
    """Move the write-ahead log into the database file and empty it. The pragma does not raise when another connection
    is still reading (it only reports busy), and then the old plain text would stay in the -wal file: try again."""
    for _ in range(attempts):
        busy, _log, _done = con.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        if not busy:
            return True
        time.sleep(pause)
    return False


def _vacuum(path: str) -> bool:
    """Rewrite a SQLite file so that the plain text of changed rows no longer sits in its free pages (SQLite does
    not erase them on its own), and empty its write-ahead log. Needs a moment without other readers and writers: it
    retries for a few seconds, and reports False if the file could not be cleaned."""
    if not path or not os.path.exists(path):
        return True
    try:
        con = sqlite3.connect(path, timeout=5, isolation_level=None)
        try:
            con.execute("PRAGMA secure_delete = ON")
            ok = _checkpoint(con)
            con.execute("VACUUM")
            return _checkpoint(con) and ok
        finally:
            con.close()
    except sqlite3.Error as e:
        logger.warning("Could not clean %s after the migration: %s", path, e)
        return False


def _scrub(targets: Targets) -> dict:
    """Remove traces of the old values from the database files (see _vacuum)."""
    result = {}
    url = targets.engine.url
    if url.get_backend_name() == "sqlite" and url.database:
        targets.engine.dispose()
        result["database"] = _vacuum(url.database)
    chroma_path = getattr(getattr(targets.chroma_client, "get_settings", lambda: None)(), "persist_directory", None)
    if chroma_path:
        result["vectors"] = _vacuum(os.path.join(chroma_path, "chroma.sqlite3"))
    return result


def _safety_copy_of_database(targets: Targets):
    """An encrypted copy of the database before anything is changed (the undo for the database)."""
    if targets.engine.url.get_backend_name() != "sqlite" or not targets.engine.url.database:
        return
    os.makedirs(targets.state.directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=targets.state.directory, suffix=".db")
    os.close(fd)
    try:
        src = sqlite3.connect(targets.engine.url.database)
        dst = sqlite3.connect(tmp)
        try:
            src.backup(dst)
        finally:
            dst.close()
            src.close()
        with open(tmp, "rb") as f:
            data = f.read()
        crypto.encrypt_bytes_to_file(safety_copy_path(targets.state), targets.state.sub_key("files"), data)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def safety_copy_path(state: ProtectionState) -> str:
    return os.path.join(state.directory, "pre-migration.db.enc")


def run(targets: Targets, direction: str, *, rollback_on_error: bool = True,
        on_done: Optional[Callable[[dict], None]] = None) -> dict:
    """Run the migration. Returns the report; raises MigrationError if it could not even start."""
    if direction not in ("enable", "disable"):
        raise ValueError("direction must be 'enable' or 'disable'")
    if not _RUN_LOCK.acquire(blocking=False):
        raise MigrationError("A migration is already running.")
    state = targets.state
    to_protected = direction == "enable"
    counts = {"database": 0, "files": 0, "vectors": 0}
    try:
        checked = plan(targets, direction)
        if not checked["ok"]:
            raise MigrationError(" ".join(checked["problems"]))
        started = datetime.now(timezone.utc).isoformat(timespec="seconds")
        _progress(state, state="running", direction=direction, step="start", done=0, started_at=started, error=None)
        try:
            _safety_copy_of_database(targets)
            if to_protected:
                state.mark_enabled(True)       # from now on new data is written protected
            else:
                if state.vector_mode() == "secure":
                    _vectors_to_chroma(targets, counts)     # the encrypted index only exists while protection is on
                state.mark_enabled(False)      # from now on new data is written plain; old data is read as before
            _migrate_database(targets, to_protected, counts)
            _migrate_files(targets, to_protected, counts)
            _migrate_vectors(targets, to_protected, counts)
            counts["cleaned"] = _scrub(targets) if to_protected else {}
            left = plan(targets, direction)
            remaining = (sum(v["todo"] for v in left["database"].values()) + left["files"]["todo"]
                         + left["vectors"]["todo"])
            if remaining:
                raise MigrationError(f"{remaining} items could not be converted.")
        except Exception as e:
            logger.error("Protection migration (%s) failed: %s", direction, e, exc_info=True)
            _progress(state, state="failed", error=str(e)[:300], counts=counts)
            if rollback_on_error and to_protected:
                try:
                    run_reverse_after_failure(targets)
                    _progress(state, state="rolled_back", error=str(e)[:300])
                except Exception as e2:
                    logger.error("Rollback failed too: %s", e2, exc_info=True)
                    _progress(state, state="failed", error=f"{e} / rollback: {e2}"[:300])
            raise MigrationError(str(e))
        finished = datetime.now(timezone.utc).isoformat(timespec="seconds")
        _progress(state, state="done", direction=direction, finished_at=finished, counts=counts,
                  safety_copy=os.path.exists(safety_copy_path(state)), step="done")
        report = {"ok": True, "direction": direction, "counts": counts, "dry_run": False}
        if on_done:
            on_done(report)
        return report
    finally:
        _RUN_LOCK.release()


def run_reverse_after_failure(targets: Targets):
    """Undo a half-done 'enable': convert everything back to plain and switch protection off."""
    counts = {"database": 0, "files": 0, "vectors": 0}
    targets.state.mark_enabled(False)
    _migrate_database(targets, False, counts)
    _migrate_files(targets, False, counts)
    _migrate_vectors(targets, False, counts)


# --- Search index: ChromaDB <-> the encrypted index ---------------------------------------------------------------------
#
# to "secure": every ChromaDB collection is copied (text decrypted, vectors and metadata as they are) into the encrypted
# index and verified; then the mode is switched; then the ChromaDB collections are deleted and its file is rewritten, so
# the readable vectors and metadata are gone. "chroma" is the same in reverse. Stopping at any point is safe: before the
# switch the old index is still the one in use (a new run starts the copy again), after it the leftover collections
# of the old index are removed by the next run.

def _chroma_names(client):
    return [getattr(c, "name", c) for c in client.list_collections() if not getattr(c, "name", c).endswith(TMP_SUFFIX)]


def vector_plan(targets: Targets, to_secure: bool) -> dict:
    """Dry run for the search-index move. Changes nothing."""
    report = {"to": "secure" if to_secure else "chroma", "dry_run": True, "problems": [], "collections": 0, "chunks": 0}
    if targets.state.key is None:
        report["problems"].append("The key is not available: unlock StarkLLM first.")
    if to_secure and not targets.state.enabled:
        report["problems"].append("Turn on protection first.")
    if _busy_documents(targets):
        report["problems"].append("Documents are still being processed. Try again when they are finished.")
    if not report["problems"]:
        if to_secure:
            for name in _chroma_names(targets.chroma_client):
                report["collections"] += 1
                report["chunks"] += targets.chroma_client.get_collection(name).count()
        else:
            for name in targets.secure().store.list_names():
                report["collections"] += 1
                report["chunks"] += targets.secure().get_collection(name).count()
    report["ok"] = not report["problems"]
    return report


def _copy_into_secure(targets: Targets, counts: dict):
    secure = targets.secure()
    for name in _chroma_names(targets.chroma_client):
        old = targets.chroma_client.get_collection(name)
        try:
            secure.delete_collection(name)                 # a copy from an earlier, stopped run: start again
        except Exception:
            pass
        new = secure.create_collection(name, metadata=old.metadata)
        done = set()
        for _pass in range(2):                             # the second pass picks up rows written while copying
            ids = [i for i in old.get(include=[]).get("ids", []) if i not in done]
            for start in range(0, len(ids), BATCH):
                got = old.get(ids=ids[start:start + BATCH], include=["documents", "metadatas", "embeddings"])
                docs = [targets.state.open_text(d, "vectors.document") if isinstance(d, str) else d for d in got["documents"]]
                new.add(ids=got["ids"], documents=docs, metadatas=got["metadatas"],
                        embeddings=[[float(x) for x in e] for e in got["embeddings"]])
                done.update(got["ids"])
                counts["vectors"] += len(got["ids"])
                _progress(targets.state, step="vectors", done=counts["vectors"])
        if new.count() < old.count():
            raise MigrationError(f"The copy of '{name}' in the encrypted index is incomplete.")


def _copy_into_chroma(targets: Targets, counts: dict):
    secure = targets.secure()
    for name in secure.store.list_names():
        old = secure.get_collection(name)
        try:
            targets.chroma_client.delete_collection(name)
        except Exception:
            pass
        new = targets.chroma_client.get_or_create_collection(name, metadata=old.metadata)
        ids = old.get(include=[])["ids"]
        for start in range(0, len(ids), BATCH):
            got = old.get(ids=ids[start:start + BATCH], include=["documents", "metadatas", "embeddings"])
            docs = [targets.state.seal_text(d, "vectors.document") if isinstance(d, str) else d for d in got["documents"]]
            embs = [[float(x) for x in e] for e in got["embeddings"]]
            with_meta = [i for i, m in enumerate(got["metadatas"]) if m]
            without = [i for i, m in enumerate(got["metadatas"]) if not m]        # ChromaDB does not take empty metadata
            if with_meta:
                new.add(ids=[got["ids"][i] for i in with_meta], documents=[docs[i] for i in with_meta],
                        metadatas=[got["metadatas"][i] for i in with_meta], embeddings=[embs[i] for i in with_meta])
            if without:
                new.add(ids=[got["ids"][i] for i in without], documents=[docs[i] for i in without],
                        embeddings=[embs[i] for i in without])
            counts["vectors"] += len(got["ids"])
            _progress(targets.state, step="vectors", done=counts["vectors"])
        if new.count() < old.count():
            raise MigrationError(f"The copy of '{name}' in ChromaDB is incomplete.")


def _vectors_to_secure(targets: Targets, counts: dict):
    if targets.state.vector_mode() != "secure":             # after the switch only the clean-up is left (a stopped run)
        _copy_into_secure(targets, counts)
        targets.state.set_vector_mode("secure")            # the switch: from now on the encrypted index is used
    for name in _chroma_names(targets.chroma_client):      # ... and the readable one is removed
        targets.chroma_client.delete_collection(name)
    counts["cleaned"] = _scrub(targets)


def _vectors_to_chroma(targets: Targets, counts: dict):
    if targets.state.vector_mode() == "secure":
        _copy_into_chroma(targets, counts)
        targets.state.set_vector_mode("chroma")
    secure = targets.secure()
    for name in list(secure.store.list_names()):
        secure.delete_collection(name)
    secure.store.compact()


def run_vectors(targets: Targets, to_secure: bool) -> dict:
    """Move the search index to the encrypted index (or back). Raises MigrationError; leaves a working state."""
    if not _RUN_LOCK.acquire(blocking=False):
        raise MigrationError("A migration is already running.")
    state = targets.state
    counts = {"database": 0, "files": 0, "vectors": 0}
    try:
        checked = vector_plan(targets, to_secure)
        if not checked["ok"]:
            raise MigrationError(" ".join(checked["problems"]))
        _progress(state, state="running", direction="secure-index" if to_secure else "plain-index", step="start", done=0,
                  started_at=datetime.now(timezone.utc).isoformat(timespec="seconds"), error=None)
        try:
            (_vectors_to_secure if to_secure else _vectors_to_chroma)(targets, counts)
        except Exception as e:
            logger.error("Search index move failed: %s", e, exc_info=True)
            _progress(state, state="failed", error=str(e)[:300], counts=counts)
            raise MigrationError(str(e))
        _progress(state, state="done", finished_at=datetime.now(timezone.utc).isoformat(timespec="seconds"), counts=counts,
                  step="done")
        return {"ok": True, "counts": counts, "dry_run": False}
    finally:
        _RUN_LOCK.release()


def finalize(targets: Targets) -> bool:
    """Delete the safety copy of the database (after the user checked that everything works)."""
    path = safety_copy_path(targets.state)
    existed = os.path.exists(path)
    if existed:
        os.remove(path)
    _progress(targets.state, safety_copy=False)
    return existed


def restore_database_from_safety_copy(targets: Targets) -> bool:
    """Put the database copy from before the migration back (last resort; text written since is lost)."""
    path = safety_copy_path(targets.state)
    if not os.path.exists(path):
        return False
    data = crypto.decrypt_file_bytes(path, targets.state.sub_key("files"))
    targets.engine.dispose()
    with open(targets.engine.url.database, "wb") as f:
        f.write(data)
    return True
