"""Temporary diagnosis (not for main): does ChromaDB's hnsw index pool evict unpersisted indexes on Windows?"""
import ctypes, glob, os, platform, sys, tempfile

mode = sys.argv[1]
n = int(sys.argv[2])
if platform.system() == "Windows":
    ms, uc = ctypes.cdll.msvcrt, ctypes.cdll.ucrtbase
    print("before: msvcrt", ms._getmaxstdio(), "ucrt", uc._getmaxstdio())
    if mode != "default":
        limit = int(mode)
        print("setmaxstdio msvcrt ->", ms._setmaxstdio(limit), "ucrt ->", uc._setmaxstdio(limit))
    print("after: msvcrt", ms._getmaxstdio(), "ucrt", uc._getmaxstdio())
import chromadb
client = chromadb.PersistentClient(path=tempfile.mkdtemp(), settings=chromadb.config.Settings(anonymized_telemetry=False))
print("hnsw_cache_size", client._server.hnsw_cache_size)
for i in range(n):
    client.create_collection(f"c{i}").add(ids=["a"], documents=["x"], embeddings=[[float(i), 1.0, 0.0]])
bad = []
for i in range(n):
    try:
        client.get_collection(f"c{i}").get(include=["embeddings"])
    except Exception as e:
        bad.append((i, str(e)[:120]))
print(f"mode={mode} collections={n} failed_reads={len(bad)}", bad[:3])
