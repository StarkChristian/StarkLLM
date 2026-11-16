"""Temporary diagnosis: where does readable text stay after the move to the encrypted index (Windows)?"""
import logging
import os
import sqlite3

from tests.test_secure_index_migration import env, fill_chroma  # noqa: F401  (fixture)
from app.services import protection_migration as mig

NEEDLES = (b"Steuerbescheid", b"/uploads/", b"file_name")


def where(folder):
    hits = []
    for base, _d, files in os.walk(folder):
        for f in files:
            p = os.path.join(base, f)
            data = open(p, "rb").read()
            found = [n.decode() for n in NEEDLES if n in data]
            hits.append(f"{os.path.relpath(p, folder)} {len(data)}B {found}")
    return hits


def test_scrub_diag(env, caplog):
    caplog.set_level(logging.WARNING)
    fill_chroma(env)
    report = mig.run_vectors(env.targets, True)
    chroma = env.tmp / "chroma"
    print("\nDIAG cleaned:", report["counts"].get("cleaned"))
    for line in where(chroma):
        print("DIAG file:", line)
    for r in caplog.records:
        print("DIAG log:", r.levelname, r.getMessage()[:200])
    con = sqlite3.connect(str(chroma / "chroma.sqlite3"))
    print("DIAG journal:", con.execute("pragma journal_mode").fetchone(), "freelist:", con.execute("pragma freelist_count").fetchone())
    for t in ("embeddings_queue", "embedding_metadata", "embeddings", "collections", "segments", "max_seq_id"):
        try:
            print("DIAG rows", t, con.execute(f"select count(*) from {t}").fetchone()[0])
        except Exception as e:
            print("DIAG rows", t, e)
    con.close()
    import gc
    print("DIAG file: (open sqlite3 connections in gc)", sum(1 for o in gc.get_objects() if isinstance(o, sqlite3.Connection)))
    assert not any("[]" not in h for h in where(chroma))
