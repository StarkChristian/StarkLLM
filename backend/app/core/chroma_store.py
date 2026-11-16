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
import ctypes
import logging
import platform

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
