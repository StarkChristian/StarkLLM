"""ChromaDB on Windows: every collection stays readable with many open (the HNSW index pool), and no readable
leftovers stay in the HNSW index files (see app.core.chroma_store)."""
import os
import platform

import pytest

from app.core import chroma_store


def test_every_collection_stays_readable_with_many_collections_open(tmp_path):
    # 64 pool shards: with one index per shard (ChromaDB's own size on Windows) 65 small collections always push
    # some out, and reading one that had been read before failed with "Nothing found on disk" (on the first read
    # ChromaDB rebuilds the index from its write-ahead log, so each collection is read once here)
    client = chroma_store.open_chroma(str(tmp_path / "chroma"))
    for i in range(65):
        coll = client.create_collection(f"coll_{i}")
        coll.add(ids=["a"], documents=[f"text {i}"], embeddings=[[float(i), 1.0, 0.5]])
        assert coll.count() == 1
    for i in range(65):
        coll = client.get_collection(f"coll_{i}")
        assert coll.get(include=["embeddings"])["embeddings"][0][0] == float(i)
        assert coll.query(query_embeddings=[[float(i), 1.0, 0.5]], n_results=1)["documents"] == [[f"text {i}"]]


@pytest.mark.skipif(platform.system() != "Windows", reason="ChromaDB sizes the pool from the file limit only on Windows")
def test_the_index_pool_has_room_in_every_shard_on_windows(tmp_path):
    client = chroma_store.open_chroma(str(tmp_path / "chroma"))
    assert client._server.hnsw_cache_size // 64 >= 16


def _files(folder):
    return {os.path.relpath(os.path.join(b, f), folder): open(os.path.join(b, f), "rb").read()
            for b, _d, fs in os.walk(folder) for f in fs}


def test_leftovers_in_the_index_files_are_wiped_and_the_store_keeps_working(tmp_path):
    # hnswlib writes its uncleared buffers into data_level0.bin when an index is created; on Windows they can hold
    # text the process had in memory (seen: chunk text and metadata after protection was turned on)
    path = str(tmp_path / "chroma")
    client = chroma_store.open_chroma(path)
    keep = client.create_collection("keep_me")
    keep.add(ids=["a"], documents=["kept"], embeddings=[[0.5, 1.0, 0.25]])
    gone = client.create_collection("delete_me")
    gone.add(ids=["b"], documents=["gone"], embeddings=[[1.0, 0.0, 0.0]])
    assert keep.count() == 1 and gone.count() == 1
    planted = 0
    for name in _files(path):
        if name.endswith("data_level0.bin"):
            with open(os.path.join(path, name), "r+b") as f:     # what the uncleared buffer can contain
                f.seek(3000)
                f.write(b"LEFTOVER Kuendigung Mietvertrag")
            planted += 1
    assert planted == 2
    client.delete_collection("delete_me")
    assert chroma_store.wipe_index_leftovers(path)
    assert not [n for n, data in _files(path).items() if b"LEFTOVER" in data]
    assert keep.get(include=["embeddings"])["embeddings"][0].tolist() == [0.5, 1.0, 0.25]
    assert keep.query(query_embeddings=[[0.5, 1.0, 0.25]], n_results=1)["documents"] == [["kept"]]
    keep.add(ids=["c"], documents=["more"], embeddings=[[0.0, 1.0, 0.0]])
    assert keep.count() == 2


def test_persisted_vectors_are_left_alone(tmp_path):
    path = str(tmp_path / "chroma")
    client = chroma_store.open_chroma(path)
    coll = client.create_collection("big")
    coll.add(ids=[str(i) for i in range(1100)], embeddings=[[float(i), 1.0, 0.5] for i in range(1100)])
    assert coll.count() == 1100                      # 1000 of them are written to the index files
    before = _files(path)
    index_files = {n: d for n, d in before.items() if n.endswith("data_level0.bin")}
    assert index_files and any(d.strip(b"\0") for d in index_files.values())
    assert chroma_store.wipe_index_leftovers(path)
    after = _files(path)
    assert {n: after[n] for n in index_files} == index_files
    assert coll.get(ids=["999"], include=["embeddings"])["embeddings"][0].tolist() == [999.0, 1.0, 0.5]


def _plant_leftover(folder):
    # what hnswlib leaves on Windows: readable text in a freshly created, never saved index file
    with open(os.path.join(folder, "data_level0.bin"), "r+b") as f:
        f.write(b"Steuerbescheid file_name /uploads/")


def _index_folders(path):
    return [os.path.join(path, d) for d in os.listdir(path) if os.path.isdir(os.path.join(path, d))]


def test_while_in_use_small_new_indexes_are_cleaned_and_big_ones_wait(tmp_path, monkeypatch):
    path = str(tmp_path / "chroma")
    client = chroma_store.open_chroma(path)
    small = client.create_collection("small_one")
    small.add(ids=["a"], documents=["x"], embeddings=[[0.1, 0.2, 0.3]])
    assert small.count() == 1
    big = client.create_collection("big_one")
    big.add(ids=["b"], documents=["y"], embeddings=[[0.3, 0.2, 0.1]])
    assert big.count() == 1
    folders = _index_folders(path)
    assert len(folders) == 2
    for f in folders:
        _plant_leftover(f)
    # make the second collection count as "near its first save"
    monkeypatch.setattr(chroma_store, "SAFE_BELOW", 1)
    assert chroma_store.wipe_index_leftovers(path, while_in_use=True)
    dirty = [f for f in folders if b"Steuerbescheid" in open(os.path.join(f, "data_level0.bin"), "rb").read()]
    assert len(dirty) == 2, "with SAFE_BELOW=1 no collection is small enough: nothing in use is touched"
    monkeypatch.setattr(chroma_store, "SAFE_BELOW", 900)
    assert chroma_store.wipe_index_leftovers(path, while_in_use=True)
    for f in folders:
        assert b"Steuerbescheid" not in open(os.path.join(f, "data_level0.bin"), "rb").read()
    assert small.query(query_embeddings=[[0.1, 0.2, 0.3]], n_results=1)["documents"] == [["x"]]
    small.add(ids=["c"], documents=["z"], embeddings=[[0.2, 0.2, 0.2]])
    assert small.count() == 2


def test_writes_ask_for_a_clean_up_only_while_protection_is_on(monkeypatch):
    from app.services import protected_collection as pc

    calls = []
    monkeypatch.setattr(chroma_store, "scrub_soon", lambda path, delay=None: calls.append(path))

    class Inner:
        def add(self, **kw):
            assert chroma_store.WRITE_LOCK._is_owned(), "writes run under the lock the clean-up takes"
            return "added"

    class Off:
        enabled = False

    class On:
        enabled = True

    monkeypatch.setattr(pc, "seal_documents", lambda d: d)
    monkeypatch.setattr(pc, "protection", Off())
    assert pc.ProtectedCollection(Inner()).add(ids=["1"], documents=["x"]) == "added"
    assert calls == []
    monkeypatch.setattr(pc, "protection", On())
    assert pc.ProtectedCollection(Inner()).add(ids=["1"], documents=["x"]) == "added"
    assert len(calls) == 1


def test_scrub_soon_runs_once_for_a_batch_of_writes(tmp_path, monkeypatch):
    import threading
    runs = []
    done = threading.Event()

    def fake(path, while_in_use=False):
        runs.append(path)
        done.set()
        return True

    monkeypatch.setattr(chroma_store, "wipe_index_leftovers", fake)
    for _ in range(5):
        chroma_store.scrub_soon(str(tmp_path), delay=0.2)
    assert done.wait(5)
    import time
    time.sleep(0.4)
    assert runs == [str(tmp_path)]

