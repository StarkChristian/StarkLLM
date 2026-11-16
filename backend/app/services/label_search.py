"""Searching names and titles while they are stored protected (B6 follow-up).

Workspace names, chat titles and document file names used to be searched with SQL `LIKE`. Protected values cannot be
searched by the database, so while protection is on the rows of the *current user* are read (decrypted) and compared
here. Unlike SQL's ILIKE this also matches non-ASCII letters case-insensitively (Ä = ä).

Cost, measured (docs/encryption-design.md, section 2): the first search after unlocking decrypts every label once; the
decrypted short texts are then kept in memory (never on disk) until the engine is locked, so later searches only compare
strings. A blind index (keyed hashes of the words, searchable by SQL) was measured as well and rejected: it is faster on
huge tables only, and it leaks which rows share a word.
"""
from typing import Callable, Iterable, List, Optional, TypeVar

T = TypeVar("T")


def fold(text: Optional[str]) -> str:
    return (text or "").casefold()


def contains(label: Optional[str], needle: str) -> bool:
    """Case-insensitive 'label contains needle' (the needle is folded here)."""
    return fold(needle) in fold(label)


def filter_rows(rows: Iterable[T], label_of: Callable[[T], Optional[str]], needle: str,
                limit: Optional[int] = None) -> List[T]:
    """The rows whose label contains the needle, in the given order, at most `limit`."""
    n = fold(needle)
    out: List[T] = []
    for row in rows:
        if n in fold(label_of(row)):
            out.append(row)
            if limit is not None and len(out) >= limit:
                break
    return out


def matching_ids(rows: Iterable[tuple], needle: str, limit: Optional[int] = None) -> List[int]:
    """Ids of the (id, label) rows whose label contains the needle, in the given order, at most `limit`.
    Reading only id and label (not whole rows as objects) is several times faster on big tables."""
    n = fold(needle)
    out: List[int] = []
    for row_id, label in rows:
        if n in fold(label):
            out.append(row_id)
            if limit is not None and len(out) >= limit:
                break
    return out


def load_in_order(query, model, ids: List[int]):
    """The entities with these ids, in the order of `ids`."""
    if not ids:
        return []
    found = {row.id: row for row in query.filter(model.id.in_(ids))}
    return [found[i] for i in ids if i in found]
