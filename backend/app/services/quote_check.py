"""Quotations in an answer that are not in the documents (MSI night test of 2.3.0, N44).

A model can write a quotation that sounds like the book and present it as the document's words: "his wife, a very
fat, very good-natured woman, named Houck" was given as a quote from Moby-Dick, chapter 3, with the book's pages as
sources, but no page of the book contains it. After an answer is written, every quotation in it is looked up in the
passages the answer was given (and the summaries); one that is not there is shown to the user with a warning.
Rules only, no model call.
"""
import re
from difflib import SequenceMatcher
from typing import Iterable, List

# “…”  "…"  „…“  «…»  »…«  ‚…‘  '…' is left out: apostrophes ("Ahab's") would open false quotations
QUOTE = re.compile(r'“([^”]{12,})”|"([^"\n]{12,})"|„([^“”\n]{12,})[“”]|«([^»]{12,})»|»([^«]{12,})«|‚([^‘’\n]{12,})[‘’]')
ELLIPSIS = re.compile(r"\.\s?\.\s?\.|…|\[\s*\.\.\.\s*\]")
WORD = re.compile(r"\w+", re.UNICODE)
MIN_WORDS = 6          # shorter quotations are names, titles or labels
MIN_SEGMENT_WORDS = 4  # a piece between "..." that is checked on its own
MATCH = 0.85           # share of a piece's words that must stand in the passages in one run


def _words(text: str) -> List[str]:
    return [w.lower() for w in WORD.findall(text or "")]


def quotations(answer: str) -> List[str]:
    out = []
    for m in QUOTE.finditer(answer or ""):
        quote = next(g for g in m.groups() if g).strip()
        if len(_words(quote)) >= MIN_WORDS and quote not in out:
            out.append(quote)
    return out


def _found(piece: List[str], passages: List[List[str]], joined: List[str]) -> bool:
    text = " ".join(piece)
    if any(text in j for j in joined):
        return True
    need = MATCH * len(piece)
    for words in passages:
        m = SequenceMatcher(None, piece, words, autojunk=False).find_longest_match(0, len(piece), 0, len(words))
        if m.size >= need:
            return True
    return False


def unverified(answer: str, passages: Iterable[str]) -> List[str]:
    """The quotations of the answer whose words are not in the passages (each piece between "..." checked)."""
    quotes = quotations(answer)
    if not quotes:
        return []
    texts = [p for p in passages if p]
    words = [_words(p) for p in texts]
    joined = [" ".join(w) for w in words]
    out = []
    for quote in quotes:
        pieces = [_words(p) for p in ELLIPSIS.split(quote)]
        pieces = [p for p in pieces if len(p) >= MIN_SEGMENT_WORDS] or [_words(quote)]
        if not all(_found(p, words, joined) for p in pieces):
            out.append(quote)
    return out
