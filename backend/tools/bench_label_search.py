"""Measures how long searching names and titles takes with protection off and on (docs/encryption-design.md, section 2).

    python tools/bench_label_search.py            (from the backend folder; no Ollama, no network)

Compared, for 1,000 / 10,000 / 50,000 rows of chat titles:
  plain SQL     ILIKE on a plain column (what protection off does)
  cold          protected titles, first search after unlocking: every title is read and decrypted
  warm          the same search again (decrypted titles are kept in memory until the engine is locked)
  blind index   prototype only, NOT used by StarkLLM: keyed hashes of every 3-letter piece of every title in a second
                table, found by SQL; shows what the rejected alternative would cost (build time, size, query time)
"""
import hashlib
import hmac
import os
import random
import sqlite3
import statistics
import sys
import tempfile
import time

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from sqlalchemy import Column, Integer, create_engine, text  # noqa: E402
from sqlalchemy.orm import declarative_base, sessionmaker  # noqa: E402

from app.core import crypto  # noqa: E402
from app.core.protection import ProtectedText, protection  # noqa: E402
from app.services import label_search  # noqa: E402

WORDS = ("Kündigung Mietvertrag Steuerbescheid Rechnung Mahnung Versicherung Arztbrief Rente Strom Wasser Auto Schule Bank "
         "Darlehen Garantie Reise Vertrag Antrag Bescheid Widerspruch Nachzahlung Kita Handy Internet Zahnarzt Gehalt "
         "Notar Erbe Grundsteuer Kindergeld Wohngeld Miete Nebenkosten Heizung Zeugnis Studium Bewerbung Urlaub").split()
NEEDLE = "steuerbescheid"


def titles(n):
    rnd = random.Random(7)
    return [" ".join(rnd.choice(WORDS) for _ in range(rnd.randint(3, 7))) + f" {i}" for i in range(n)]


def timed(fn, repeat=5):
    runs = []
    for _ in range(repeat):
        t0 = time.perf_counter()
        result = fn()
        runs.append((time.perf_counter() - t0) * 1000)
    return statistics.median(runs), result


def trigrams(text_):
    t = label_search.fold(text_)
    return {t[i:i + 3] for i in range(len(t) - 2)} if len(t) >= 3 else {t}


def main():
    Base = declarative_base()

    class PlainChat(Base):
        __tablename__ = "plain_chats"
        id = Column(Integer, primary_key=True)
        title = Column(ProtectedText("plain.title"))

    protection.set_directory(tempfile.mkdtemp())
    print(f"{'rows':>7} | {'plain SQL':>10} | {'cold':>9} | {'warm':>9} | {'whole rows':>10} | {'blind index query':>18} | {'index build':>12} | {'index size':>11} | matches")
    for n in (1_000, 10_000, 50_000):
        data = titles(n)
        tmp = tempfile.mkdtemp()
        engine = create_engine(f"sqlite:///{tmp}/b.db")
        Base.metadata.create_all(engine)
        Session = sessionmaker(bind=engine)

        # plain
        protection.clear_key()
        protection.save_state(enabled=False)
        with Session() as s:
            s.add_all([PlainChat(id=i, title=t) for i, t in enumerate(data)])
            s.commit()
        plain_ms, plain_hits = timed(lambda: Session().execute(
            text("select id from plain_chats where title like :p"), {"p": f"%{NEEDLE}%"}).fetchall())

        # protected
        protection.set_key(crypto.new_key())
        protection.mark_enabled(True)
        with Session() as s:
            s.query(PlainChat).delete()
            s.add_all([PlainChat(id=i, title=t) for i, t in enumerate(data)])
            s.commit()

        def search():
            with Session() as s:   # only id and title are read, as in the engine (api/search.py)
                return label_search.matching_ids(s.query(PlainChat.id, PlainChat.title).order_by(PlainChat.id), NEEDLE)

        def search_entities():     # the first version: whole rows as objects (kept to show why it was changed)
            with Session() as s:
                return label_search.filter_rows(s.query(PlainChat).order_by(PlainChat.id), lambda c: c.title, NEEDLE)

        protection._label_cache.clear()
        t0 = time.perf_counter()
        hits = search()
        cold_ms = (time.perf_counter() - t0) * 1000
        warm_ms, _ = timed(search)
        assert len(hits) == len(plain_hits)
        protection._label_cache.clear()
        t0 = time.perf_counter()
        search_entities()
        entity_ms = (time.perf_counter() - t0) * 1000

        # blind index prototype
        sub = crypto.derive_key(protection.key, "blind-index")
        con = sqlite3.connect(os.path.join(tmp, "idx.db"))
        con.execute("create table idx (h blob, row_id integer)")
        con.execute("create index idx_h on idx (h)")
        t0 = time.perf_counter()
        rows = [(hmac.new(sub, g.encode(), hashlib.sha256).digest()[:8], i) for i, t in enumerate(data) for g in trigrams(t)]
        con.executemany("insert into idx values (?, ?)", rows)
        con.commit()
        build_ms = (time.perf_counter() - t0) * 1000
        size_mb = os.path.getsize(os.path.join(tmp, "idx.db")) / 1e6

        def blind():
            sets = [{r[0] for r in con.execute("select row_id from idx where h = ?",
                                               (hmac.new(sub, g.encode(), hashlib.sha256).digest()[:8],))}
                    for g in trigrams(NEEDLE)]
            return set.intersection(*sets)
        blind_ms, candidates = timed(blind)
        print(f"{n:>7} | {plain_ms:>8.2f}ms | {cold_ms:>7.1f}ms | {warm_ms:>7.1f}ms | {entity_ms:>8.1f}ms | {blind_ms:>16.2f}ms | {build_ms:>10.0f}ms | {size_mb:>8.1f} MB | {len(hits)} (blind candidates {len(candidates)})")


if __name__ == "__main__":
    main()
