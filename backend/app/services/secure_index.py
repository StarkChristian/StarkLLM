"""Encrypted search index (docs/encryption-design.md, "Encrypted search index").

ChromaDB keeps vectors, metadata (file name, page, source path) and its write log readable on disk. This module is a
drop-in replacement for the part of the ChromaDB API that StarkLLM uses, with everything encrypted:

* One SQLite file. Every row (id, text, metadata, vector) is one AES-256-GCM blob; the collection name is a blob too.
  Row and collection keys in the file are HMACs, so not even the names of workspaces or documents are visible.
  The authenticated data of a blob is its collection and row key, so rows cannot be moved, swapped or edited undetected.
* A collection is decrypted into memory (numpy matrix + metadata) the first time it is used after the engine is unlocked,
  and searched by exact brute force: cosine, L2 or inner product, with the same distances ChromaDB reports.
  Exact search means recall 1.0 by construction (HNSW is approximate).
* Writes go to the file at once (one SQLite transaction per call); a crash leaves the old or the new state.
  Deleted rows are overwritten (secure_delete) and the file is rewritten from time to time (`compact`).

What an attacker with the disk still sees: how many rows each (unnamed) collection has, the size of each row (roughly
the length of the text), and when the file was changed. What a running, unlocked engine holds in memory is plain.
See the design note for the measured speed and memory.
"""
import hashlib
import hmac
import json
import logging
import os
import sqlite3
import struct
import threading
from typing import Any, Dict, List, Optional

import numpy as np
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.core import crypto
from app.core.protection import ProtectionLocked, ProtectionState, protection as default_protection

logger = logging.getLogger(__name__)

MISSING = object()
# Collections with more vectors than this are kept in memory as float16 (half the RAM, but each search first converts blocks
# back to float32, which is several times slower: measured in docs/encryption-design.md). Float32 is exact and fast, and
# fine for the sizes of a household archive (a few hundred thousand pieces of text at most).
FLOAT16_ABOVE = 1_000_000
COMPACT_AFTER_DELETES = 5000


class CollectionNotFound(ValueError):
    pass


class CollectionExists(ValueError):
    pass


# --- filters (the subset of ChromaDB's `where` and `where_document` that the code uses) ---------------------------------

def _same_type(a, b) -> bool:
    return isinstance(a, bool) == isinstance(b, bool)


def _cmp(op: str, value, operand) -> bool:
    if value is MISSING:
        return op in ("$ne", "$nin")
    try:
        if op == "$eq":
            return _same_type(value, operand) and value == operand
        if op == "$ne":
            return not (_same_type(value, operand) and value == operand)
        if op == "$in":
            return any(_same_type(value, o) and value == o for o in operand)
        if op == "$nin":
            return not any(_same_type(value, o) and value == o for o in operand)
        if isinstance(value, bool) or isinstance(operand, bool):
            return False
        if op == "$gt":
            return value > operand
        if op == "$gte":
            return value >= operand
        if op == "$lt":
            return value < operand
        if op == "$lte":
            return value <= operand
    except TypeError:
        return False
    raise ValueError(f"Unsupported filter operator {op}")


def match_where(where: Optional[dict], meta: Optional[dict]) -> bool:
    if not where:
        return True
    for key, cond in where.items():
        if key == "$and":
            ok = all(match_where(c, meta) for c in cond)
        elif key == "$or":
            ok = any(match_where(c, meta) for c in cond)
        else:
            value = meta.get(key, MISSING) if meta else MISSING
            if isinstance(cond, dict):
                ok = all(_cmp(op, value, operand) for op, operand in cond.items())
            else:
                ok = _cmp("$eq", value, cond)
        if not ok:
            return False
    return True


def match_document(where_document: Optional[dict], doc: Optional[str]) -> bool:
    if not where_document:
        return True
    for key, cond in where_document.items():
        if key == "$and":
            ok = all(match_document(c, doc) for c in cond)
        elif key == "$or":
            ok = any(match_document(c, doc) for c in cond)
        elif key == "$contains":
            ok = doc is not None and cond in doc
        elif key == "$not_contains":
            ok = doc is None or cond not in doc
        else:
            raise ValueError(f"Unsupported document filter {key}")
        if not ok:
            return False
    return True


# --- the encrypted file ---------------------------------------------------------------------------------------------

class SecureStore:
    """The SQLite file with the encrypted rows, and the open collections."""

    def __init__(self, path: str, state: Optional[ProtectionState] = None):
        self.path = path
        self._state = state
        self._lock = threading.RLock()
        self._keys = None                       # (master key, AESGCM, hmac key)
        self._collections: Dict[str, "SecureCollection"] = {}
        self._deletes = 0
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.execute("PRAGMA secure_delete = ON")
        self._db.execute("PRAGMA journal_mode = WAL")
        self._db.execute("PRAGMA synchronous = FULL")
        self._db.execute("CREATE TABLE IF NOT EXISTS collections (coll_id TEXT PRIMARY KEY, blob BLOB NOT NULL)")
        self._db.execute("CREATE TABLE IF NOT EXISTS rows (seq INTEGER PRIMARY KEY AUTOINCREMENT, coll_id TEXT NOT NULL, "
                         "row_id TEXT NOT NULL, blob BLOB NOT NULL, UNIQUE (coll_id, row_id))")

    @property
    def state(self) -> ProtectionState:
        return self._state or default_protection

    # keys
    def keys(self):
        master = self.state.key
        if master is None:
            raise ProtectionLocked("StarkLLM is locked: the key for your protected data has not been unlocked.")
        if self._keys is None or self._keys[0] != master:
            self._keys = (master, AESGCM(crypto.derive_key(master, "vectors")), crypto.derive_key(master, "vectors-index"))
            self._collections.clear()           # a different key: nothing decrypted so far is valid
        return self._keys

    def coll_id(self, name: str) -> str:
        return hmac.new(self.keys()[2], b"c:" + name.encode(), hashlib.sha256).hexdigest()[:32]

    def row_id(self, coll_id: str, row: str) -> str:
        return hmac.new(self.keys()[2], b"r:" + coll_id.encode() + b":" + row.encode(), hashlib.sha256).hexdigest()[:32]

    def seal(self, plain: bytes, aad: str) -> bytes:
        nonce = os.urandom(12)
        return nonce + self.keys()[1].encrypt(nonce, plain, aad.encode())

    def open(self, blob: bytes, aad: str) -> bytes:
        try:
            return self.keys()[1].decrypt(blob[:12], blob[12:], aad.encode())
        except InvalidTag:
            raise crypto.CorruptData("The search index was changed or is damaged.")

    # collections
    def _all_ids(self) -> List[str]:
        return [r[0] for r in self._db.execute("SELECT coll_id FROM collections ORDER BY rowid")]

    def list_names(self) -> List[str]:
        with self._lock:
            out = []
            for cid in self._all_ids():
                blob = self._db.execute("SELECT blob FROM collections WHERE coll_id=?", (cid,)).fetchone()[0]
                out.append(json.loads(self.open(blob, cid))["name"])
            return out

    def get_collection(self, name: str) -> "SecureCollection":
        with self._lock:
            cid = self.coll_id(name)
            if cid in self._collections:
                return self._collections[cid]
            row = self._db.execute("SELECT blob FROM collections WHERE coll_id=?", (cid,)).fetchone()
            if row is None:
                raise CollectionNotFound(f"Collection {name} does not exist.")
            meta = json.loads(self.open(row[0], cid))
            col = SecureCollection(self, cid, meta["name"], meta.get("metadata"))
            col._load()
            self._collections[cid] = col
            return col

    def create_collection(self, name: str, metadata: Optional[dict] = None, get_or_create: bool = False):
        with self._lock:
            cid = self.coll_id(name)
            exists = self._db.execute("SELECT 1 FROM collections WHERE coll_id=?", (cid,)).fetchone()
            if exists:
                if get_or_create:
                    return self.get_collection(name)
                raise CollectionExists(f"Collection {name} already exists.")
            blob = self.seal(json.dumps({"name": name, "metadata": metadata}).encode(), cid)
            self._db.execute("INSERT INTO collections (coll_id, blob) VALUES (?, ?)", (cid, blob))
            col = SecureCollection(self, cid, name, metadata)
            self._collections[cid] = col
            return col

    def delete_collection(self, name: str):
        with self._lock:
            cid = self.coll_id(name)
            if not self._db.execute("SELECT 1 FROM collections WHERE coll_id=?", (cid,)).fetchone():
                raise CollectionNotFound(f"Collection {name} does not exist.")
            self._db.execute("BEGIN")
            try:
                self._db.execute("DELETE FROM rows WHERE coll_id=?", (cid,))
                self._db.execute("DELETE FROM collections WHERE coll_id=?", (cid,))
                self._db.execute("COMMIT")
            except Exception:
                self._db.execute("ROLLBACK")
                raise
            self._collections.pop(cid, None)
            self._count_deletes(1000)

    def _count_deletes(self, n: int):
        self._deletes += n
        if self._deletes >= COMPACT_AFTER_DELETES:
            self.compact()

    def compact(self):
        """Rewrite the file so that deleted rows leave no trace in free pages."""
        with self._lock:
            self._db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self._db.execute("VACUUM")
            self._db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self._deletes = 0

    def close(self):
        with self._lock:
            self._collections.clear()
            self._db.close()

    def verify_all(self) -> dict:
        """Decrypt and authenticate every row. Returns {name: row count}. Raises CorruptData on any change."""
        with self._lock:
            counts = {}
            for name in self.list_names():
                self._collections.pop(self.coll_id(name), None)         # read from the file, not from memory
                counts[name] = self.get_collection(name).count()
            return counts


# --- one collection ------------------------------------------------------------------------------------------------

class SecureCollection:
    """The ChromaDB collection API as StarkLLM uses it, over encrypted rows. Not the whole API: see the methods."""

    def __init__(self, store: SecureStore, coll_id: str, name: str, metadata: Optional[dict]):
        self._store, self._cid = store, coll_id
        self.name, self.metadata = name, metadata
        self._ids: List[str] = []
        self._docs: List[Optional[str]] = []
        self._metas: List[Optional[dict]] = []
        self._pos: Dict[str, int] = {}
        self._mat = np.zeros((0, 0), dtype=np.float32)
        self._n = 0
        self._sq: Optional[np.ndarray] = None            # squared norms (l2), lazily
        self._norm: Optional[np.ndarray] = None          # norms (cosine), lazily
        self._eq: Dict[str, Dict[Any, List[int]]] = {}   # metadata key -> value -> positions, lazily
        self._lock = store._lock

    @property
    def space(self) -> str:
        return (self.metadata or {}).get("hnsw:space", "l2")

    @property
    def dim(self) -> int:
        return self._mat.shape[1]

    # --- file <-> memory ---
    def _load(self):
        db = self._store._db
        total = db.execute("SELECT COUNT(*) FROM rows WHERE coll_id=?", (self._cid,)).fetchone()[0]
        mat = None
        for row_id, blob in db.execute("SELECT row_id, blob FROM rows WHERE coll_id=? ORDER BY seq", (self._cid,)):
            plain = self._store.open(blob, self._cid + row_id)
            jlen, dim = struct.unpack(">II", plain[:8])
            body = json.loads(plain[8:8 + jlen])
            if mat is None:      # one allocation, filled row by row: no second copy of the matrix while loading
                mat = np.empty((total, dim), dtype=np.float16 if total > FLOAT16_ABOVE else np.float32)
            mat[len(self._ids)] = np.frombuffer(plain[8 + jlen:], dtype="<f4", count=dim)
            self._ids.append(body["id"])
            self._docs.append(body["doc"])
            self._metas.append(body["meta"])
        self._n = len(self._ids)
        self._pos = {i: p for p, i in enumerate(self._ids)}
        if mat is not None:
            self._mat = mat
        self._invalidate()

    def _invalidate(self):
        self._sq = self._norm = None
        self._eq = {}

    def _blob(self, row_id: str, id_: str, doc, meta, vec: np.ndarray) -> bytes:
        body = json.dumps({"id": id_, "doc": doc, "meta": meta}, ensure_ascii=False).encode()
        raw = np.asarray(vec, dtype="<f4").tobytes()
        return self._store.seal(struct.pack(">II", len(body), len(vec)) + body + raw, self._cid + row_id)

    # --- writes ---
    def _check(self, ids, embeddings, metadatas, documents, need_embeddings=True):
        if isinstance(ids, str):
            ids = [ids]
        n = len(ids)
        if len(set(ids)) != n:
            raise ValueError("Expected IDs to be unique.")
        for name, value in (("embeddings", embeddings), ("metadatas", metadatas), ("documents", documents)):
            if value is not None and len(value) != n:
                raise ValueError(f"Number of {name} ({len(value)}) does not match number of ids ({n}).")
        if need_embeddings and embeddings is None:
            raise ValueError("Embeddings are required: this index does not compute them.")
        if embeddings is not None:
            emb = np.asarray(embeddings, dtype=np.float32)
            if emb.ndim != 2:
                raise ValueError("Embeddings must be a list of vectors.")
            if self._n and emb.shape[1] != self.dim:
                raise ValueError(f"Collection expecting embedding with dimension of {self.dim}, got {emb.shape[1]}")
            embeddings = emb
        return list(ids), embeddings

    def _write(self, ids, vecs, metas, docs, mode: str):
        """mode: add (existing ids are kept), upsert (replace; metadata is merged like ChromaDB), update."""
        with self._lock:
            store = self._store
            db = store._db
            db.execute("BEGIN")
            try:
                for i, id_ in enumerate(ids):
                    p = self._pos.get(id_)
                    if p is not None and mode == "add":
                        continue
                    if p is None and mode == "update":
                        continue
                    doc = docs[i] if docs is not None else (self._docs[p] if p is not None else None)
                    meta = metas[i] if metas is not None else None
                    if p is not None:
                        old = self._metas[p]
                        meta = ({**(old or {}), **meta} if meta is not None and old else (meta if meta is not None else old))
                        vec = vecs[i] if vecs is not None else np.asarray(self._mat[p], dtype=np.float32)
                    else:
                        vec = vecs[i]
                    rid = store.row_id(self._cid, id_)
                    blob = self._blob(rid, id_, doc, meta, vec)
                    db.execute("INSERT INTO rows (coll_id, row_id, blob) VALUES (?, ?, ?) "
                               "ON CONFLICT (coll_id, row_id) DO UPDATE SET blob = excluded.blob", (self._cid, rid, blob))
                    self._apply(p, id_, doc, meta, vec)
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                self._reload()
                raise
            self._invalidate()

    def _apply(self, p, id_, doc, meta, vec):
        vec = np.asarray(vec, dtype=self._mat.dtype if self._mat.size else np.float32)
        if p is None:
            if self._n == 0:
                self._mat = np.zeros((16, len(vec)), dtype=vec.dtype)
            elif self._n == self._mat.shape[0]:
                grown = np.zeros((self._n * 2, self.dim), dtype=self._mat.dtype)
                grown[:self._n] = self._mat[:self._n]
                self._mat = grown
            self._mat[self._n] = vec
            self._pos[id_] = self._n
            self._ids.append(id_)
            self._docs.append(doc)
            self._metas.append(meta)
            self._n += 1
        else:
            self._mat[p] = vec
            self._docs[p] = doc
            self._metas[p] = meta

    def _reload(self):
        self._ids, self._docs, self._metas, self._pos, self._n = [], [], [], {}, 0
        self._mat = np.zeros((0, 0), dtype=np.float32)
        self._load()

    def add(self, ids, embeddings=None, metadatas=None, documents=None, **_):
        ids, emb = self._check(ids, embeddings, metadatas, documents)
        self._write(ids, emb, metadatas, documents, "add")

    def upsert(self, ids, embeddings=None, metadatas=None, documents=None, **_):
        ids, emb = self._check(ids, embeddings, metadatas, documents)
        self._write(ids, emb, metadatas, documents, "upsert")

    def update(self, ids, embeddings=None, metadatas=None, documents=None, **_):
        ids, emb = self._check(ids, embeddings, metadatas, documents, need_embeddings=False)
        self._write(ids, emb, metadatas, documents, "update")

    def delete(self, ids=None, where=None, where_document=None, **_):
        with self._lock:
            if ids is None and where is None and where_document is None:
                raise ValueError("Expected at least one of ids, where or where_document.")
            positions = self._select(ids, where, where_document)
            if not len(positions):
                return
            db = self._store._db
            db.execute("BEGIN")
            try:
                db.executemany("DELETE FROM rows WHERE coll_id=? AND row_id=?",
                               [(self._cid, self._store.row_id(self._cid, self._ids[p])) for p in positions])
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
            drop = set(int(p) for p in positions)
            keep = [p for p in range(self._n) if p not in drop]
            self._ids = [self._ids[p] for p in keep]
            self._docs = [self._docs[p] for p in keep]
            self._metas = [self._metas[p] for p in keep]
            self._mat = self._mat[keep] if keep else np.zeros((0, 0), dtype=self._mat.dtype)
            self._n = len(keep)
            self._pos = {i: p for p, i in enumerate(self._ids)}
            self._invalidate()
            self._store._count_deletes(len(positions))

    def modify(self, name: Optional[str] = None, metadata: Optional[dict] = None, **_):
        with self._lock:
            store = self._store
            new_name = name or self.name
            new_cid = store.coll_id(new_name)
            if new_cid != self._cid:
                if store._db.execute("SELECT 1 FROM collections WHERE coll_id=?", (new_cid,)).fetchone():
                    raise CollectionExists(f"Collection {new_name} already exists.")
            meta = metadata if metadata is not None else self.metadata
            rows = store._db.execute("SELECT row_id, blob FROM rows WHERE coll_id=?", (self._cid,)).fetchall()
            plains = [(rid, store.open(b, self._cid + rid)) for rid, b in rows]
            store._db.execute("BEGIN")
            try:
                store._db.execute("DELETE FROM collections WHERE coll_id=?", (self._cid,))
                store._db.execute("INSERT INTO collections (coll_id, blob) VALUES (?, ?)",
                                  (new_cid, store.seal(json.dumps({"name": new_name, "metadata": meta}).encode(), new_cid)))
                for rid, plain in plains:
                    jlen = struct.unpack(">I", plain[:4])[0]
                    new_rid = store.row_id(new_cid, json.loads(plain[8:8 + jlen])["id"])
                    store._db.execute("UPDATE rows SET coll_id=?, row_id=?, blob=? WHERE coll_id=? AND row_id=?",
                                      (new_cid, new_rid, store.seal(plain, new_cid + new_rid), self._cid, rid))
                store._db.execute("COMMIT")
            except Exception:
                store._db.execute("ROLLBACK")
                raise
            store._collections.pop(self._cid, None)
            self._cid, self.name, self.metadata = new_cid, new_name, meta
            store._collections[new_cid] = self

    # --- reads ---
    def count(self) -> int:
        return self._n

    def _equality_positions(self, key: str, value) -> Optional[List[int]]:
        if isinstance(value, (list, dict)):
            return None
        index = self._eq.get(key)
        if index is None:
            index = {}
            for p in range(self._n):
                m = self._metas[p]
                if m and key in m and isinstance(m[key], (str, int, float, bool)):
                    index.setdefault((isinstance(m[key], bool), m[key]), []).append(p)
            self._eq[key] = index
        return index.get((isinstance(value, bool), value), [])

    def _fast_where(self, where) -> Optional[set]:
        """Positions for the simple filters that are used all the time (a field equals / is in); None = scan."""
        if not where or len(where) != 1:
            return None
        (key, cond), = where.items()
        if key == "$and":
            sets = [self._fast_where(c) for c in cond]
            if any(s is None for s in sets):
                return None
            out = sets[0]
            for s in sets[1:]:
                out = out & s
            return out
        if key.startswith("$"):
            return None
        if not isinstance(cond, dict):
            found = self._equality_positions(key, cond)
            return None if found is None else set(found)
        if len(cond) == 1:
            (op, operand), = cond.items()
            if op == "$eq":
                found = self._equality_positions(key, operand)
                return None if found is None else set(found)
            if op == "$in" and isinstance(operand, list):
                out = set()
                for v in operand:
                    found = self._equality_positions(key, v)
                    if found is None:
                        return None
                    out.update(found)
                return out
        return None

    def _select(self, ids=None, where=None, where_document=None) -> np.ndarray:
        """Positions (in insertion order) of the rows matching all given conditions."""
        if isinstance(ids, str):
            ids = [ids]
        if ids is not None:
            cand = sorted({self._pos[i] for i in ids if i in self._pos})
        else:
            fast = self._fast_where(where) if where else None
            cand = sorted(fast) if fast is not None else range(self._n)
            if fast is not None:
                where = None
        out = []
        for p in cand:
            if where and not match_where(where, self._metas[p]):
                continue
            if where_document and not match_document(where_document, self._docs[p]):
                continue
            out.append(p)
        return np.asarray(out, dtype=np.int64)

    def _shape(self, positions, include, ids_only_ok=True) -> dict:
        inc = set(include)
        pos = [int(p) for p in positions]
        return {
            "ids": [self._ids[p] for p in pos],
            "documents": [self._docs[p] for p in pos] if "documents" in inc else None,
            "metadatas": [self._metas[p] for p in pos] if "metadatas" in inc else None,
            "embeddings": (np.asarray(self._mat[pos], dtype=np.float32) if pos else np.zeros((0, max(self.dim, 0)), np.float32))
            if "embeddings" in inc else None,
            "uris": None, "data": None, "included": sorted(inc),
        }

    def get(self, ids=None, where=None, where_document=None, limit=None, offset=None,
            include=("metadatas", "documents"), **_) -> dict:
        with self._lock:
            pos = self._select(ids, where, where_document)
            if offset:
                pos = pos[offset:]
            if limit is not None:
                pos = pos[:limit]
            return self._shape(pos, include)

    def peek(self, limit=10) -> dict:
        return self.get(limit=limit)

    def _distances(self, q: np.ndarray, pos: np.ndarray) -> np.ndarray:
        mat = self._mat[:self._n]
        sub = mat if len(pos) == self._n else mat[pos]
        sub32 = sub.astype(np.float32, copy=False)
        dots = sub32 @ q
        if self.space == "cosine":
            if self._norm is None:
                self._norm = np.linalg.norm(mat.astype(np.float32, copy=False), axis=1)
            norms = self._norm if len(pos) == self._n else self._norm[pos]
            qn = float(np.linalg.norm(q))
            denom = np.maximum(norms * qn, 1e-30)
            return 1.0 - dots / denom
        if self.space == "ip":
            return 1.0 - dots
        if self._sq is None:
            m32 = mat.astype(np.float32, copy=False)
            self._sq = np.einsum("ij,ij->i", m32, m32)
        sq = self._sq if len(pos) == self._n else self._sq[pos]
        return np.maximum(sq + float(q @ q) - 2.0 * dots, 0.0)

    def query(self, query_embeddings=None, n_results: int = 10, where=None, where_document=None,
              include=("metadatas", "documents", "distances"), **_) -> dict:
        if query_embeddings is None:
            raise ValueError("This index searches by embedding only.")
        with self._lock:
            qs = np.asarray(query_embeddings, dtype=np.float32)
            if qs.ndim == 1:
                qs = qs[None, :]
            out = {"ids": [], "documents": [], "metadatas": [], "distances": [], "embeddings": []}
            inc = set(include)
            allpos = self._select(None, where, where_document) if (where or where_document) else np.arange(self._n)
            if self._n and qs.shape[1] != self.dim:
                raise ValueError(f"Collection expecting embedding with dimension of {self.dim}, got {qs.shape[1]}")
            for q in qs:
                k = min(n_results, len(allpos))
                if k == 0:
                    top, dist = np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.float32)
                else:
                    d = self._distances(q, allpos)
                    if k < len(d):
                        part = np.argpartition(d, k - 1)[:k]
                        order = part[np.lexsort((part, d[part]))]       # ties: insertion order
                    else:
                        order = np.lexsort((np.arange(len(d)), d))
                    top, dist = allpos[order], d[order]
                out["ids"].append([self._ids[int(p)] for p in top])
                out["documents"].append([self._docs[int(p)] for p in top])
                out["metadatas"].append([self._metas[int(p)] for p in top])
                out["distances"].append([float(x) for x in dist])
                out["embeddings"].append(np.asarray(self._mat[[int(p) for p in top]], dtype=np.float32) if len(top) else
                                         np.zeros((0, max(self.dim, 0)), np.float32))
            return {
                "ids": out["ids"],
                "documents": out["documents"] if "documents" in inc else None,
                "metadatas": out["metadatas"] if "metadatas" in inc else None,
                "distances": out["distances"] if "distances" in inc else None,
                "embeddings": out["embeddings"] if "embeddings" in inc else None,
                "uris": None, "data": None, "included": sorted(inc),
            }


class SecureClient:
    """The part of chromadb's client that StarkLLM uses, over a SecureStore."""

    def __init__(self, store: SecureStore):
        self.store = store

    def get_or_create_collection(self, name: str, metadata: Optional[dict] = None, **_):
        return self.store.create_collection(name, metadata, get_or_create=True)

    def create_collection(self, name: str, metadata: Optional[dict] = None, **_):
        return self.store.create_collection(name, metadata)

    def get_collection(self, name: str, **_):
        return self.store.get_collection(name)

    def delete_collection(self, name: str):
        self.store.delete_collection(name)

    def list_collections(self, **_):
        return [self.store.get_collection(n) for n in self.store.list_names()]


_client: Optional[SecureClient] = None
_client_path: Optional[str] = None


def default_path() -> str:
    from app.core.config import settings
    return os.path.abspath(settings.SECURE_INDEX_DIR)


def secure_client() -> SecureClient:
    """The engine's encrypted index (one per process; follows settings.SECURE_INDEX_DIR)."""
    global _client, _client_path
    path = os.path.join(default_path(), "index.db")
    if _client is None or _client_path != path:
        if _client is not None:
            _client.store.close()
        _client, _client_path = SecureClient(SecureStore(path)), path
    return _client


def release():
    """Close the file (before it is replaced by a restore)."""
    global _client, _client_path
    if _client is not None:
        _client.store.close()
    _client, _client_path = None, None
