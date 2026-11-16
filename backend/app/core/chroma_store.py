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


def wipe_index_leftovers(chroma_dir: str) -> bool:
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
