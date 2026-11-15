"""The encrypted search index (SecureCollection): same answers as ChromaDB for everything StarkLLM asks, nothing readable
in the file, damage detected, crash safe."""
import os
import random
import sqlite3

import chromadb
import numpy as np
import pytest

from app.core import crypto
from app.core.protection import ProtectionLocked, protection
from app.services import secure_index as si

DOCS = ["Alpha Brief 12", "beta letter", "Gamma", "delta ersetzt x", "Mietvertrag Müller", "Stadtwerke Rechnung"]
METAS = [{"p": 1, "s": "x", "f": True, "source": "/u/a.pdf"}, {"p": 2, "s": "y", "source": "/u/b.pdf"}, {"p": 3, "s": "x", "source": "/u/a.pdf"},
         {"p": 4, "source": "/u/c.pdf"}, {"p": 5, "s": "y", "document_id": 7}, {"p": 6, "document_id": 8}]
EMBS = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [0.5, 0.5, 0.5], [2, 0, 1]]
WHERES = [{"p": 2}, {"p": {"$gt": 1}}, {"$and": [{"p": {"$gte": 2}}, {"p": {"$lte": 3}}]}, {"s": {"$ne": "x"}},
          {"s": {"$nin": ["x"]}}, {"s": {"$in": ["x", "y"]}}, {"$or": [{"p": 1}, {"p": 4}]}, {"f": True}, {"missing": 1},
          {"s": "x"}, {"source": {"$in": ["/u/a.pdf", "/u/c.pdf"]}}, {"$and": [{"s": "x"}, {"source": "/u/a.pdf"}]},
          {"document_id": {"$in": [7, 8]}}, {"p": {"$lt": 3}}, {"p": {"$lte": 3}}, {"p": {"$eq": 4}}]
WHERE_DOCS = [{"$contains": "Brief"}, {"$contains": "brief"}, {"$or": [{"$contains": "ersetzt"}, {"$contains": "Gamma"}]},
              {"$not_contains": "Alpha"}, {"$and": [{"$contains": "a"}, {"$contains": "e"}]}]


@pytest.fixture()
def keyed(tmp_path):
    protection.set_directory(str(tmp_path / "protection"))
    protection.clear_key()
    protection.set_key(crypto.new_key())
    yield tmp_path
    protection.set_directory(None)
    protection.clear_key()
    protection._state_cache = None


def pair(tmp_path, metadata=None, name="coll_probe"):
    chroma = chromadb.PersistentClient(path=str(tmp_path / "chroma"), settings=chromadb.config.Settings(anonymized_telemetry=False))
    store = si.SecureStore(str(tmp_path / "idx" / "index.db"))
    c = chroma.get_or_create_collection(name, metadata=metadata)
    s = si.SecureClient(store).get_or_create_collection(name, metadata=metadata)
    for col in (c, s):
        col.add(ids=list("abcdef"), documents=DOCS, embeddings=EMBS, metadatas=METAS)
    return c, s, store


def same(a, b):
    """Results equal, numpy arrays compared by value."""
    if isinstance(a, dict):
        return all(same(a[k], b[k]) for k in ("ids", "documents", "metadatas", "distances", "embeddings") if k in a and a[k] is not None)
    if isinstance(a, np.ndarray) or isinstance(b, np.ndarray):
        return np.allclose(np.asarray(a, dtype=float), np.asarray(b, dtype=float), atol=1e-5)
    if isinstance(a, (list, tuple)):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if isinstance(a, float):
        return abs(a - b) < 1e-5
    return a == b


def same_up_to_ties(ids_a, ids_b, distances) -> bool:
    """Equal answers; rows with exactly the same distance may come in either order (and one of them may be cut off)."""
    if len(ids_a) != len(ids_b):
        return False
    groups = {}
    for i, d in zip(ids_b, distances):
        groups.setdefault(round(d, 5), []).append(i)
    pos, last = 0, max(groups) if groups else None
    for d in sorted(groups):
        size = len(groups[d])
        part = ids_a[pos:pos + size]
        if d != last and set(part) != set(groups[d]):
            return False
        pos += size
    return True


@pytest.mark.parametrize("where", WHERES)
def test_where_filters_give_the_same_rows_as_chromadb(keyed, where):
    c, s, _ = pair(keyed)
    assert s.get(where=where)["ids"] == c.get(where=where)["ids"], where
    assert same(s.get(where=where, include=["documents", "metadatas"]), c.get(where=where, include=["documents", "metadatas"]))


@pytest.mark.parametrize("wd", WHERE_DOCS)
def test_document_filters_give_the_same_rows_as_chromadb(keyed, wd):
    c, s, _ = pair(keyed)
    assert s.get(where_document=wd)["ids"] == c.get(where_document=wd)["ids"], wd
    assert s.get(where_document=wd, limit=1, include=[])["ids"] == c.get(where_document=wd, limit=1, include=[])["ids"]


def test_get_shapes_ids_limit_offset_and_include(keyed):
    c, s, _ = pair(keyed)
    assert s.get()["ids"] == c.get()["ids"] == list("abcdef")
    assert s.get(ids=["c", "zzz", "a"])["ids"] == c.get(ids=["c", "zzz", "a"])["ids"]
    assert s.get(limit=2, offset=1)["ids"] == c.get(limit=2, offset=1)["ids"]
    assert s.get(include=[])["documents"] is None and c.get(include=[])["documents"] is None
    assert same(s.get(ids=["a"], include=["embeddings"])["embeddings"], c.get(ids=["a"], include=["embeddings"])["embeddings"])
    assert s.get(ids=["d"])["metadatas"] == c.get(ids=["d"])["metadatas"]
    assert s.get(ids=["a"], where={"p": 1})["ids"] == c.get(ids=["a"], where={"p": 1})["ids"] == ["a"]
    assert s.get(ids=["b"], where={"p": 1})["ids"] == c.get(ids=["b"], where={"p": 1})["ids"] == []
    assert s.count() == c.count() == 6


@pytest.mark.parametrize("space", [None, "cosine", "ip"])
def test_query_distances_order_and_shape_equal_chromadb(keyed, space):
    c, s, _ = pair(keyed, metadata={"hnsw:space": space} if space else None, name="coll_" + (space or "l2"))
    queries = [[1, 0.1, 0], [0, 0, 1], [0.3, 0.3, 0.9]]
    for kwargs in ({"n_results": 3}, {"n_results": 10}, {"n_results": 2, "where": {"s": "x"}},
                   {"n_results": 3, "where": {"$or": [{"p": 1}, {"p": 5}]}}, {"n_results": 3, "where": {"p": 1000}},
                   {"n_results": 4, "where_document": {"$contains": "e"}}):
        a, b = s.query(query_embeddings=queries, **kwargs), c.query(query_embeddings=queries, **kwargs)
        assert same(a["distances"], b["distances"]), (space, kwargs)
        for ids_a, ids_b, dist in zip(a["ids"], b["ids"], b["distances"]):
            assert same_up_to_ties(ids_a, ids_b, dist), (space, kwargs, ids_a, ids_b)


def test_query_include_embeddings_and_missing_parts(keyed):
    c, s, _ = pair(keyed)
    a = s.query(query_embeddings=[[1, 0, 0]], n_results=2, include=["embeddings", "documents"])
    b = c.query(query_embeddings=[[1, 0, 0]], n_results=2, include=["embeddings", "documents"])
    assert a["ids"] == b["ids"] and same(a["embeddings"][0], b["embeddings"][0]) and a["distances"] is None


def test_writes_behave_like_chromadb(keyed):
    c, s, _ = pair(keyed)
    for col in (c, s):
        col.add(ids=["a"], documents=["dup"], embeddings=[[9, 9, 9]], metadatas=[{"p": 99}])       # existing id: ignored
        col.upsert(ids=["a", "n"], documents=["A2", "N"], embeddings=[[2, 0, 0], [0, 2, 0]], metadatas=[{"p": 10}, {"p": 11}])
        col.update(ids=["b"], documents=["B2"], embeddings=[[0, 1, 0]])
        col.delete(where={"p": 999})
        col.delete(ids=["c"])
        col.delete(where={"s": "y"})
    assert s.get()["ids"] == c.get()["ids"]
    assert same(s.get(include=["documents", "metadatas", "embeddings"]), c.get(include=["documents", "metadatas", "embeddings"]))
    assert s.count() == c.count()
    with pytest.raises(ValueError, match="dimension"):
        s.add(ids=["z"], documents=["z"], embeddings=[[1, 2]])
    with pytest.raises(ValueError):
        s.add(ids=["q", "q"], documents=["a", "b"], embeddings=[[1, 2, 3], [1, 2, 3]])


def test_random_data_matches_chromadb_exact_search(keyed):
    rng = np.random.default_rng(3)
    data = rng.normal(size=(300, 16)).astype(np.float32)
    chroma = chromadb.PersistentClient(path=str(keyed / "chroma"), settings=chromadb.config.Settings(anonymized_telemetry=False))
    store = si.SecureStore(str(keyed / "idx" / "index.db"))
    for space in ("l2", "cosine"):
        c = chroma.get_or_create_collection("rnd_" + space, metadata={"hnsw:space": space})
        s = si.SecureClient(store).get_or_create_collection("rnd_" + space, metadata={"hnsw:space": space})
        ids = [f"id{i}" for i in range(300)]
        metas = [{"k": i % 7, "g": f"g{i % 3}"} for i in range(300)]
        docs = [f"doc {i}" for i in range(300)]
        for col in (c, s):
            col.add(ids=ids, embeddings=data.tolist(), documents=docs, metadatas=metas)
        hits = total = 0
        for q in rng.normal(size=(20, 16)).astype(np.float32):
            a = s.query(query_embeddings=[q.tolist()], n_results=10, where={"k": {"$in": [1, 2, 3]}})
            b = c.query(query_embeddings=[q.tolist()], n_results=10, where={"k": {"$in": [1, 2, 3]}})
            total += 10
            hits += len(set(a["ids"][0]) & set(b["ids"][0]))
            assert same(a["distances"][0][:3], b["distances"][0][:3])
        assert hits / total > 0.95        # Chroma's HNSW is approximate; the secure search is exact


# --- encryption at rest ---------------------------------------------------------------------------------------------

def test_nothing_readable_in_the_file(keyed):
    store = si.SecureStore(str(keyed / "idx" / "index.db"))
    col = si.SecureClient(store).get_or_create_collection("user_1_workspace_42")
    secret = "Kuendigung Mietvertrag Frau Mueller IBAN DE41600500000001234567"
    vec = np.array([0.1234567, -2.5, 3.14159], dtype="<f4")
    col.add(ids=["doc-77-chunk-0"], documents=[secret], embeddings=[vec.tolist()],
            metadatas=[{"source": "/uploads/ab12_Steuerbescheid.pdf", "file_name": "Steuerbescheid.pdf", "page": 3}])
    store._db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    blob = b"".join(open(os.path.join(os.path.dirname(store.path), f), "rb").read() for f in os.listdir(os.path.dirname(store.path)))
    for needle in (b"Kuendigung", b"Mueller", b"Steuerbescheid", b"user_1_workspace", b"workspace_42", b"doc-77", b"/uploads",
                   b"source", b"page", vec.tobytes(), b"file_name"):
        assert needle not in blob, needle


def test_locked_index_refuses_everything(keyed):
    store = si.SecureStore(str(keyed / "idx" / "index.db"))
    client = si.SecureClient(store)
    col = client.get_or_create_collection("c1_locked")
    col.add(ids=["a"], documents=["x"], embeddings=[[1.0, 2.0]])
    protection.clear_key()
    with pytest.raises(ProtectionLocked):
        client.get_collection("c1_locked")
    with pytest.raises(ProtectionLocked):
        client.get_or_create_collection("other_locked")
    with pytest.raises(ProtectionLocked):
        client.list_collections()
    protection.set_key(protection_key := crypto.new_key())          # a different key does not open it
    with pytest.raises((crypto.CryptoError, si.CollectionNotFound)):
        si.SecureStore(store.path).get_collection("c1_locked")
    assert protection_key


def test_changed_row_is_detected_and_rows_cannot_be_swapped(keyed):
    path = str(keyed / "idx" / "index.db")
    store = si.SecureStore(path)
    col = si.SecureClient(store).get_or_create_collection("c1_tamper")
    col.add(ids=["a", "b"], documents=["first", "second"], embeddings=[[1.0, 0.0], [0.0, 1.0]])
    store.close()
    db = sqlite3.connect(path)
    rows = db.execute("SELECT seq, blob FROM rows ORDER BY seq").fetchall()
    db.execute("UPDATE rows SET blob=? WHERE seq=?", (rows[1][1], rows[0][0]))        # row b's blob in row a's place
    db.commit()
    store2 = si.SecureStore(path)
    with pytest.raises(crypto.CorruptData):
        store2.get_collection("c1_tamper")
    db.execute("UPDATE rows SET blob=? WHERE seq=?", (rows[0][1], rows[0][0]))
    flipped = bytearray(rows[1][1]); flipped[30] ^= 1
    db.execute("UPDATE rows SET blob=? WHERE seq=?", (bytes(flipped), rows[1][0]))
    db.commit()
    db.close()
    with pytest.raises(crypto.CorruptData):
        si.SecureStore(path).get_collection("c1_tamper")


def test_survives_restart_and_a_crash_in_the_middle_of_a_write(keyed, monkeypatch):
    path = str(keyed / "idx" / "index.db")
    store = si.SecureStore(path)
    col = si.SecureClient(store).get_or_create_collection("c1_crash")
    col.add(ids=["a", "b"], documents=["one", "two"], embeddings=[[1.0, 0.0], [0.0, 1.0]], metadatas=[{"k": 1}, {"k": 2}])
    real = col._blob
    calls = {"n": 0}

    def dying(*a, **k):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("power loss")
        return real(*a, **k)
    monkeypatch.setattr(col, "_blob", dying)
    with pytest.raises(RuntimeError):
        col.upsert(ids=["a", "c", "d"], documents=["A!", "C", "D"], embeddings=[[5.0, 5.0]] * 3)
    monkeypatch.undo()
    assert col.get()["ids"] == ["a", "b"] and col.get(ids=["a"])["documents"] == ["one"]      # all or nothing, also in memory
    store.close()
    again = si.SecureStore(path).get_collection("c1_crash")
    assert again.get()["ids"] == ["a", "b"] and again.get(ids=["b"])["metadatas"] == [{"k": 2}]
    assert again.query(query_embeddings=[[0.0, 1.0]], n_results=1)["ids"] == [["b"]]


def test_delete_compaction_rename_and_listing(keyed):
    store = si.SecureStore(str(keyed / "idx" / "index.db"))
    client = si.SecureClient(store)
    col = client.get_or_create_collection("c1_keep")
    col.add(ids=[f"i{n}" for n in range(50)], documents=[f"text {n}" for n in range(50)], embeddings=np.eye(50, 4).tolist())
    col.delete(where={"k": 1})
    col.delete(ids=[f"i{n}" for n in range(10)])
    store.compact()
    assert col.count() == 40 and "text 3" not in open(store.path, "rb").read().decode("latin-1")
    col.modify(name="c1_renamed")
    assert sorted(client.store.list_names()) == ["c1_renamed"]
    assert si.SecureStore(store.path).get_collection("c1_renamed").count() == 40
    client.delete_collection("c1_renamed")
    assert client.store.list_names() == []
    with pytest.raises(si.CollectionNotFound):
        client.get_collection("c1_renamed")
    with pytest.raises(si.CollectionExists):
        client.create_collection("c1_x"), client.create_collection("c1_x")


def test_large_collections_use_half_precision_memory(keyed, monkeypatch):
    monkeypatch.setattr(si, "FLOAT16_ABOVE", 10)
    store = si.SecureStore(str(keyed / "idx" / "index.db"))
    col = si.SecureClient(store).get_or_create_collection("c1_big", metadata={"hnsw:space": "cosine"})
    rng = np.random.default_rng(1)
    data = rng.normal(size=(40, 8)).astype(np.float32)
    col.add(ids=[str(i) for i in range(40)], embeddings=data.tolist(), documents=["x"] * 40)
    store.close()
    again = si.SecureStore(store.path).get_collection("c1_big")
    assert again._mat.dtype == np.float16
    assert again.query(query_embeddings=[data[5].tolist()], n_results=1)["ids"] == [["5"]]


def test_filter_index_follows_writes(keyed):
    store = si.SecureStore(str(keyed / "idx" / "index.db"))
    col = si.SecureClient(store).get_or_create_collection("c1_idx")
    col.add(ids=["a", "b"], documents=["1", "2"], embeddings=[[1.0, 0], [0, 1.0]], metadatas=[{"doc": 1}, {"doc": 2}])
    assert col.get(where={"doc": 1})["ids"] == ["a"]
    col.add(ids=["c"], documents=["3"], embeddings=[[1.0, 1.0]], metadatas=[{"doc": 1}])
    assert col.get(where={"doc": 1})["ids"] == ["a", "c"]
    col.delete(where={"doc": 1})
    assert col.get(where={"doc": 1})["ids"] == [] and col.get(where={"doc": {"$in": [2]}})["ids"] == ["b"]
    col.upsert(ids=["b"], documents=["2"], embeddings=[[1.0, 0]], metadatas=[{"doc": 5}])
    assert col.get(where={"doc": 2})["ids"] == [] and col.get(where={"doc": 5})["ids"] == ["b"]
