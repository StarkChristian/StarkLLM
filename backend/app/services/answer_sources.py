"""Which of the retrieved documents an answer used, for the sources line under it.

Every retrieved passage used to be listed as a source (MSI night test of 2.3.0, N36: the answer about the energy bill
listed the bill and two pages of an unrelated contract; a German question listed a scan and a tax letter before the
contract the answer came from). Users read that line as "the answer came from these files". The answer is compared
with the passages after it is written: a document counts as used when the answer names its file, or shares its
numbers and distinctive words. An answer that says it found nothing, or a code or chat answer, uses none.
Rules only, no model call, so it costs nothing and is the same every time.
"""
import re
from typing import Dict, List

NUMBER = re.compile(r"\d(?:[\d.,\u00a0\u202f' ]*\d)?")
WORD = re.compile(r"[^\W\d_]{5,}", re.UNICODE)
REFUSAL = re.compile(
    r"(could not|couldn'?t|can ?not|cannot|did not|didn'?t) find|not (mentioned|found|contained|included) in|"
    r"no (information|mention|details?) (about|on|of)|none of (the|these|them|which)|"
    r"(konnte|habe) .{0,40}nicht (finden|gefunden)|nicht in den (dokumenten|unterlagen)|keine (angaben?|informationen?) (zu|über)|"
    r"je n'ai pas trouvé|no (he|pude) encontrado|non (ho|sono riuscit\w) trova|bulamadım",
    re.IGNORECASE)
# words of the answer's own phrasing that say nothing about where it came from
COMMON = {
    "about", "above", "according", "after", "again", "against", "amount", "answer", "based", "because", "before",
    "below", "between", "could", "document", "documents", "during", "every", "found", "following", "their", "there",
    "these", "those", "under", "until", "where", "which", "while", "would", "should", "within", "without", "other",
    "page", "pages", "passage", "passages", "please", "total", "information", "mentioned", "states", "stated",
    "aufgrund", "bitte", "dabei", "damit", "danach", "dokument", "dokumente", "dokumenten", "durch", "einem", "einen",
    "einer", "eines", "gemäß", "laut", "nicht", "oder", "seite", "seiten", "sowie", "steht", "unter", "wurde", "wurden",
    "werden", "zwischen", "diese", "dieser", "dieses", "ihrer", "ihrem", "ihren", "keine", "können", "müssen",
}


def _numbers(text: str) -> set:
    out = set()
    for m in NUMBER.findall(text or ""):
        digits = re.sub(r"\D", "", m)
        if len(digits) >= 2:
            out.add(digits.lstrip("0") or "0")
    return out


def _words(text: str) -> set:
    return {w.lower() for w in WORD.findall(text or "")} - COMMON


def used_labels(answer: str, evidence: List[Dict]) -> List[str]:
    """The UI labels ("ui", else "label") of the evidence entries {"file", "passages", "ui"/"label"} the answer used,
    in their order."""
    answer = answer or ""
    if not answer.strip() or not evidence:
        return []
    lower = answer.lower()
    nums, words = _numbers(answer), _words(answer)
    scored = []
    for e in evidence:
        text = "\n".join(e.get("passages") or [])
        file = (e.get("file") or "").lower()
        named = bool(file) and (file in lower or file.rsplit(".", 1)[0] in lower)
        score = 3 * len(nums & _numbers(text)) + len(words & _words(text))
        scored.append((e.get("ui") or e.get("label"), named, score))
    if REFUSAL.search(answer):
        # "I could not find …": only a file the answer itself names as where it looked counts, and not as a source
        return []
    best = max(score for _, _, score in scored)
    out = []
    for label, named, score in scored:
        if (named or (score >= 4 and score * 2 >= best)) and label not in out:
            out.append(label)
    return out
