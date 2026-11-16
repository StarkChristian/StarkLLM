"""ChromaDB keeps reading every collection when many are open (the HNSW index pool on Windows, see chroma_store)."""
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
