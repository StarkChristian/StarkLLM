"""Opening the ChromaDB store (one place for the engine, backups and tests).

On Windows ChromaDB sizes the in-memory pool of its HNSW indexes from the C runtime's stdio limit, which it reads from
the old msvcrt.dll: 512 // 5 = 102 indexes. The pool is split into 64 shards by index id, so each shard holds only
one index, and opening a second index in the same shard pushes the first out. An index that is still below its
sync_threshold (1000 vectors) exists only in that pool, so after it is pushed out ChromaDB cannot read it any more
("Error creating hnsw segment reader: Nothing found on disk") until a write to that collection or a restart rebuilds
it from the write-ahead log. Which collections share a shard depends on their random ids, so this hit at random:
search, protection on/off and backups on the engine without Docker. Linux has a large file limit, so Docker never
saw it.

The fix: raise the stdio limit of the C runtime that Python and ChromaDB's bindings really use (ucrtbase, the files
of persisted HNSW indexes are opened there) and size the pool from that limit the same way ChromaDB does. That gives
1638 indexes, 25 per shard."""
import contextlib
import ctypes
import logging
import os
import platform
import sqlite3
import struct
import threading
import uuid
from typing import Optional

import chromadb
from chromadb.api.rust import RustBindingsAPI

logger = logging.getLogger(__name__)

STDIO_LIMIT = 8192            # the most the Universal CRT allows
_FILES_PER_INDEX = 5          # what ChromaDB reckons per HNSW index (4 data files and the metadata)
_prepared = False


def _hnsw_pool_size() -> int:
    return ctypes.cdll.ucrtbase._getmaxstdio() // _FILES_PER_INDEX


def prepare() -> None:
    """Make ChromaDB's index pool big enough on Windows. Idempotent; does nothing on other systems."""
    global _prepared
    if _prepared or platform.system() != "Windows":
        _prepared = True
        return
    _prepared = True
    try:
        ucrt = ctypes.cdll.ucrtbase
        if ucrt._getmaxstdio() < STDIO_LIMIT and ucrt._setmaxstdio(STDIO_LIMIT) == -1:
            logger.warning("Could not raise the open file limit to %s.", STDIO_LIMIT)
    except (OSError, AttributeError) as e:
        logger.warning("Could not raise the open file limit: %s", e)
        return
    original = RustBindingsAPI.__init__

    def __init__(self, system):
        original(self, system)
        self.hnsw_cache_size = max(self.hnsw_cache_size, _hnsw_pool_size())

    RustBindingsAPI.__init__ = __init__


def open_chroma(path: str):
    """The ChromaDB store in `path` (a store already open in this process is reused, as ChromaDB does)."""
    prepare()
    return chromadb.PersistentClient(path=path, settings=chromadb.config.Settings(anonymized_telemetry=False))


# --- Leftovers in the HNSW files ----------------------------------------------------------------------------------------
#
# When ChromaDB creates the files of an HNSW index (header.bin, data_level0.bin, length.bin, link_lists.bin in a folder
# named after the segment), hnswlib writes its whole freshly allocated, never cleared buffers into data_level0.bin and
# length.bin (initPersistentIndex). On Windows the heap hands back freed memory as it was, so these files can contain
# whatever the process had in memory a moment before: chunk text, metadata, file names, also text that protection at
# rest keeps encrypted elsewhere. Real vectors are only written there when the index is persisted (from 1000 vectors
# on; the header then counts them). ChromaDB also never deletes the folder of a deleted collection.

_HNSW_HEADER = struct.Struct("<i6QiI3QdQ")      # hnswlib HEADER_FIELDS, written field by field (100 bytes)
_SLACK_FILES = ("data_level0.bin", "length.bin")


def _persisted_elements(folder: str) -> Optional[int]:
    """How many vectors the index in `folder` has written to disk (None: not an hnswlib index we understand)."""
    try:
        with open(os.path.join(folder, "header.bin"), "rb") as f:
            raw = f.read(_HNSW_HEADER.size)
    except OSError:
        return None
    if len(raw) != _HNSW_HEADER.size:
        return None
    fields = _HNSW_HEADER.unpack(raw)
    return fields[3] if fields[0] == 1 else None      # version 1; cur_element_count


def _zero_file(path: str) -> None:
    size = os.path.getsize(path)
    with open(path, "r+b") as f:      # ChromaDB may still hold the file open (Windows allows writing, not deleting)
        done = 0
        while done < size:
            step = min(1 << 20, size - done)
            f.write(b"\0" * step)
            done += step
        f.flush()
        os.fsync(f.fileno())


# Collections below this many vectors have never written vectors into their index files: ChromaDB persists an HNSW
# index from hnsw:sync_threshold (1000, StarkLLM never changes it) on. Below it, zeroing data_level0.bin/length.bin
# cannot touch real data, even if ChromaDB writes to the collection at the same time.
SAFE_BELOW = 900


def _small_vector_segments(con) -> set:
    """Vector segments whose collection holds fewer than SAFE_BELOW vectors (counted in the metadata segment)."""
    rows = con.execute(
        "SELECT v.id, COUNT(e.id) FROM segments v "
        "JOIN segments m ON m.collection = v.collection AND m.scope = 'METADATA' "
        "LEFT JOIN embeddings e ON e.segment_id = m.id "
        "WHERE v.scope = 'VECTOR' GROUP BY v.id")
    return {seg for seg, n in rows if n < SAFE_BELOW}


def wipe_index_leftovers(chroma_dir: str, while_in_use: bool = False) -> bool:
    """Remove readable leftovers from the HNSW files of the store in `chroma_dir`:
    - the folders of deleted collections: every file is overwritten with zeros, then deleted (if ChromaDB still holds
      a file open, Windows keeps the zeroed file until ChromaDB lets go);
    - indexes that have not written any vector yet: their data_level0.bin and length.bin hold nothing but the
      uncleared buffer and are overwritten with zeros (the vectors live in memory and in ChromaDB's log until the
      index is persisted, which writes them again).
    Returns False if a file could not be overwritten."""
    if not os.path.isdir(chroma_dir):
        return True
    try:
        con = sqlite3.connect(f"file:{os.path.join(chroma_dir, 'chroma.sqlite3')}?mode=ro", uri=True, timeout=5)
        try:
            live = {row[0] for row in con.execute("SELECT id FROM segments")}
            small = _small_vector_segments(con) if while_in_use else None
        finally:
            con.close()
    except sqlite3.Error as e:
        logger.warning("Could not read the segments of %s: %s", chroma_dir, e)
        return False
    ok = True
    for entry in os.scandir(chroma_dir):
        try:
            uuid.UUID(entry.name)
        except ValueError:
            continue
        if not entry.is_dir():
            continue
        orphan = entry.name not in live
        if not orphan and _persisted_elements(entry.path) != 0:
            continue                                          # persisted vectors (or unknown format): leave it
        if not orphan and small is not None and entry.name not in small:
            continue                                          # in use and near its first save: next time
        for name in os.listdir(entry.path) if orphan else _SLACK_FILES:
            path = os.path.join(entry.path, name)
            if not os.path.isfile(path):
                continue
            try:
                _zero_file(path)
            except OSError as e:
                logger.warning("Could not overwrite %s: %s", path, e)
                ok = False
                continue
            if orphan:
                with contextlib.suppress(OSError):
                    os.remove(path)
        if orphan:
            with contextlib.suppress(OSError):
                os.rmdir(entry.path)
    return ok


# --- While protection at rest is on --------------------------------------------------------------------------------------
#
# The clean-up above runs after every move between the readable and the encrypted index. A collection that is created
# later, while protection is on and the search index is still ChromaDB's, gets the same uncleared buffers in its new
# index files. So while protection is on, every write to ChromaDB (through ProtectedCollection) asks for a clean-up a
# few seconds later, and the engine runs one at start. Writes and the clean-up never run at the same time (WRITE_LOCK);
# indexes close to their first save are left for the next run (SAFE_BELOW).

WRITE_LOCK = threading.RLock()
SCRUB_DELAY = 5.0
_scrub_timer_lock = threading.Lock()
_Thread = threading.Thread          # the real class: tests may replace threading.Thread to watch indexing threads


class _DelayedScrub(_Thread):
    def __init__(self, delay: float, action):
        _Thread.__init__(self, name="chroma-scrub", daemon=True)
        self._delay = delay
        self._action = action
        self._cancelled = threading.Event()

    def cancel(self):
        self._cancelled.set()

    def run(self):
        if not self._cancelled.wait(self._delay):
            self._action()


_scrub_timer: Optional[_DelayedScrub] = None


def scrub_now(chroma_dir: str) -> bool:
    with WRITE_LOCK:
        ok = wipe_index_leftovers(chroma_dir, while_in_use=True)
    if not ok:
        logger.warning("Some ChromaDB index files could not be cleaned; the next write or start tries again.")
    return ok


def scrub_soon(chroma_dir: str, delay: float = SCRUB_DELAY) -> None:
    """Clean the index files `delay` seconds after the last write (one run for a whole batch of writes)."""
    global _scrub_timer

    def run():
        try:
            scrub_now(chroma_dir)
        except Exception as e:                               # never let a clean-up break indexing
            logger.warning("ChromaDB index clean-up failed: %s", e)

    with _scrub_timer_lock:
        if _scrub_timer is not None:
            _scrub_timer.cancel()
        _scrub_timer = _DelayedScrub(delay, run)
        _scrub_timer.start()

