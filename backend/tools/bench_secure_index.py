"""Speed, recall and memory of the encrypted search index against ChromaDB (numbers for docs/encryption-design.md).

    python tools/bench_secure_index.py --n 100000 --dim 768 --kind clustered [--no-chroma] [--queries 200]

Prints one JSON line. Synthetic vectors: "random" (Gaussian) or "clustered" (a mixture of 60 Gaussians, like topics).
Recall is measured against an independent exact search in numpy, so it shows the recall of ChromaDB's approximate (HNSW)
search; the encrypted index searches exactly.
"""
import argparse
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from app.core import crypto  # noqa: E402
from app.core.protection import protection  # noqa: E402
from app.services import secure_index as si  # noqa: E402


def rss_mb() -> float:
    with open("/proc/self/status") as f:
        for line in f:
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) / 1024
    return 0.0


def make_data(n, dim, kind, rng):
    if kind == "random":
        return rng.normal(size=(n, dim)).astype(np.float32)
    centers = rng.normal(size=(60, dim)).astype(np.float32) * 3
    labels = rng.integers(0, 60, size=n)
    return (centers[labels] + rng.normal(size=(n, dim)).astype(np.float32)).astype(np.float32)


def pct(values, p):
    return round(float(np.percentile(values, p)) * 1000, 2)


def child(work: str, n: int):
    """Open the index file in a fresh process; report load time, memory, latency and recall (exact answers are in exact.json)."""
    queries = np.load(os.path.join(work, "queries.npy"))
    exact = [set(x) for x in json.load(open(os.path.join(work, "exact.json")))]
    protection.set_directory(os.path.join(work, "protection"))
    base = rss_mb()                                   # interpreter + numpy + cryptography, nothing loaded yet
    t = time.time()
    store = si.SecureStore(os.path.join(work, "secure", "index.db"))
    col = si.SecureClient(store).get_collection("bench")
    out = {"secure_load_s": round(time.time() - t, 2), "secure_ram_mb": round(rss_mb() - base)}
    lat, hits = [], 0
    for q, want in zip(queries, exact):
        t = time.time()
        got = col.query(query_embeddings=[q.tolist()], n_results=10)
        lat.append(time.time() - t)
        hits += len(want & set(got["ids"][0]))
    out.update(secure_p50_ms=pct(lat, 50), secure_p95_ms=pct(lat, 95), secure_recall10=round(hits / (10 * len(queries)), 4))
    lat = []
    for q in queries[:50]:                            # with a metadata filter (a fifth of all documents)
        t = time.time()
        col.query(query_embeddings=[q.tolist()], n_results=10, where={"document_id": {"$in": list(range(0, n // 5, 5))}})
        lat.append(time.time() - t)
    out["secure_filtered_p50_ms"] = pct(lat, 50)
    t = time.time()
    for k in range(50):
        col.get(where={"source": f"/uploads/{k:06d}_Brief.pdf"})
    out["secure_get_by_source_ms"] = round((time.time() - t) / 50 * 1000, 2)
    out["secure_peak_ram_mb"] = round(rss_mb() - base)
    print(json.dumps(out))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--child")
    ap.add_argument("--n", type=int, default=10000)
    ap.add_argument("--dim", type=int, default=768)
    ap.add_argument("--kind", default="clustered")
    ap.add_argument("--queries", type=int, default=200)
    ap.add_argument("--space", default="cosine")
    ap.add_argument("--no-chroma", action="store_true")
    a = ap.parse_args()
    if a.child:
        return child(a.child, a.n)
    rng = np.random.default_rng(7)
    work = tempfile.mkdtemp(prefix="bench-")
    protection.set_directory(os.path.join(work, "protection"))
    protection.set_key(crypto.new_key())
    data = make_data(a.n, a.dim, a.kind, rng)
    queries = (data[rng.choice(a.n, a.queries, replace=False)] + rng.normal(size=(a.queries, a.dim)).astype(np.float32) * 0.3)
    ids = [f"chunk-{i}" for i in range(a.n)]
    docs = [f"Letter {i}: Bitte zahlen Sie {i % 997},00 EUR bis zum 30.11.2026. IBAN DE41 6005 0000 0001 2345 67. " * 3 for i in range(a.n)]
    metas = [{"source": f"/uploads/{i // 5:06d}_Brief.pdf", "file_name": "Brief.pdf", "page": i % 5, "document_id": i // 5} for i in range(a.n)]
    result = {"n": a.n, "dim": a.dim, "kind": a.kind, "space": a.space}

    # exact reference (numpy)
    if a.space == "cosine":
        nrm = np.linalg.norm(data, axis=1)
        exact = [np.argsort(1 - (data @ q) / (nrm * np.linalg.norm(q)))[:10] for q in queries]
    else:
        sq = np.einsum("ij,ij->i", data, data)
        exact = [np.argsort(sq + q @ q - 2 * (data @ q))[:10] for q in queries]
    exact_ids = [{ids[i] for i in e} for e in exact]

    # --- encrypted index ---
    path = os.path.join(work, "secure", "index.db")
    store = si.SecureStore(path)
    col = si.SecureClient(store).get_or_create_collection("bench", metadata={"hnsw:space": a.space})
    t = time.time()
    for s in range(0, a.n, 1000):
        col.add(ids=ids[s:s + 1000], embeddings=data[s:s + 1000], documents=docs[s:s + 1000], metadatas=metas[s:s + 1000])
    result["secure_insert_per_s"] = round(a.n / (time.time() - t))
    store._db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    result["secure_db_mb"] = round(os.path.getsize(path) / 2 ** 20, 1)
    store.close()
    del col, store
    # load and search in a fresh process, as after a restart of the engine: honest load time and memory
    np.save(os.path.join(work, "queries.npy"), queries)
    with open(os.path.join(work, "exact.json"), "w") as f:
        json.dump([sorted(s) for s in exact_ids], f)
    env = dict(os.environ, STARKLLM_DATA_KEY=base64.b64encode(protection.key).decode())
    out = subprocess.run([sys.executable, os.path.abspath(__file__), "--child", work, "--space", a.space, "--n", str(a.n)],
                         env=env, capture_output=True, text=True, check=True).stdout.strip().splitlines()[-1]
    result.update(json.loads(out))

    # --- chromadb ---
    if not a.no_chroma:
        import chromadb
        client = chromadb.PersistentClient(path=os.path.join(work, "chroma"), settings=chromadb.config.Settings(anonymized_telemetry=False))
        cc = client.get_or_create_collection("bench", metadata={"hnsw:space": a.space})
        t = time.time()
        for s in range(0, a.n, 1000):
            cc.add(ids=ids[s:s + 1000], embeddings=data[s:s + 1000].tolist(), documents=docs[s:s + 1000], metadatas=metas[s:s + 1000])
        result["chroma_insert_per_s"] = round(a.n / (time.time() - t))
        lat, hits = [], 0
        for q, want in zip(queries, exact_ids):
            t = time.time()
            got = cc.query(query_embeddings=[q.tolist()], n_results=10)
            lat.append(time.time() - t)
            hits += len(want & set(got["ids"][0]))
        result.update(chroma_p50_ms=pct(lat, 50), chroma_p95_ms=pct(lat, 95), chroma_recall10=round(hits / (10 * a.queries), 4))
        del client, cc
        size = sum(os.path.getsize(os.path.join(b, f)) for b, _d, fs in os.walk(os.path.join(work, "chroma")) for f in fs)
        result["chroma_db_mb"] = round(size / 2 ** 20, 1)
    shutil.rmtree(work, ignore_errors=True)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
