"""Dates in letters: deadlines and payments, found by rules (German and English), never by the language model.

Every date returned is in the text, with the sentence it stands in, so the UI can show and link it. This is the
first part of "understanding" documents (docs/document-inbox-design.md, B3).
"""
import re
from dataclasses import dataclass, asdict
from datetime import date
from typing import List, Optional

MONTHS = {
    # German
    "januar": 1, "jänner": 1, "februar": 2, "märz": 3, "maerz": 3, "april": 4, "mai": 5, "juni": 6, "juli": 7,
    "august": 8, "september": 9, "oktober": 10, "november": 11, "dezember": 12,
    # English
    "january": 1, "february": 2, "march": 3, "may": 5, "june": 6, "july": 7, "october": 10, "december": 12,
}
_MONTH_NAMES = "|".join(sorted(MONTHS, key=len, reverse=True))

DATE_PATTERNS = [
    # 15.12.2026, 1.1.27
    re.compile(r"(?<![\d.])(?P<d>\d{1,2})\.\s?(?P<m>\d{1,2})\.\s?(?P<y>\d{4}|\d{2})(?![\d.]*\d)"),
    # 2026-12-15
    re.compile(r"(?<!\d)(?P<y>\d{4})-(?P<m>\d{2})-(?P<d>\d{2})(?!\d)"),
    # 15. Dezember 2026, 15 December 2026
    re.compile(rf"(?<!\d)(?P<d>\d{{1,2}})\.?\s+(?P<mn>{_MONTH_NAMES})\s+(?P<y>\d{{4}})", re.IGNORECASE),
    # December 15, 2026
    re.compile(rf"(?P<mn>{_MONTH_NAMES})\s+(?P<d>\d{{1,2}}),?\s+(?P<y>\d{{4}})", re.IGNORECASE),
]

DEADLINE_WORDS = re.compile(
    r"\b(frist|fristen|bis zum|bis spätestens|spätestens|fällig|fälligkeit|zahlungsziel|kündigungsfrist|kündig|"
    r"einspruch|widerspruch|widersprechen|ablauf|endet|gültig bis|"
    r"due|deadline|no later than|by|until|expires|expiry|cancel|objection)\b",
    re.IGNORECASE,
)
PAYMENT_WORDS = re.compile(
    r"\b(überweis\w*|zahlung\w*|zahlen|bezahlen|lastschrift|eingezogen|abgebucht|betrag|beitrag|rechnung\w*|nachzahlung|"
    r"payment|pay|paid|debit\w*|amount|invoice)\b",
    re.IGNORECASE,
)
LETTER_DATE = re.compile(r"\b(datum|date|ausgestellt am|vom)\s*:?\s*$", re.IGNORECASE)
AMOUNT = re.compile(
    r"(?:(?:€|EUR)\s?(?P<a1>\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})|\d+(?:[.,]\d{2})))"
    r"|(?:(?P<a2>\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})|\d+(?:[.,]\d{2}))\s?(?:€|EUR|Euro))",
    re.IGNORECASE,
)


@dataclass
class FoundDate:
    date: str  # ISO yyyy-mm-dd
    kind: str  # "deadline" or "payment"
    text: str  # the sentence or line it stands in
    amount: Optional[str] = None


def _parse(m) -> Optional[date]:
    try:
        d = int(m.group("d"))
        if "mn" in m.re.groupindex and m.group("mn"):
            mo = MONTHS[m.group("mn").lower()]
        else:
            mo = int(m.group("m"))
        y = int(m.group("y"))
        if y < 100:
            y += 2000
        return date(y, mo, d)
    except (ValueError, KeyError):
        return None


def _sentences(text: str) -> List[str]:
    """Lines, and sentences within long lines; a sentence may run over a line break ("… bis zum\\n15.12.2026")."""
    flat = re.sub(r"[ \t]+", " ", text)
    # split after a sentence end, but not after a day number ("3. März")
    parts = re.split(r"(?<=[^\d\s][.!?])\s+(?=[A-ZÄÖÜ])|\n{2,}", flat)
    return [p.replace("\n", " ").strip() for p in parts if p.strip()]


def find_dates(text: str) -> List[FoundDate]:
    """Deadlines and payment dates in a document's text, in the order they appear."""
    found, seen = [], set()
    sentences = _sentences(text or "")
    for index, sentence in enumerate(sentences):
        for pattern in DATE_PATTERNS:
            for m in pattern.finditer(sentence):
                when = _parse(m)
                if not when or not (2000 <= when.year <= 2100):
                    continue
                before = sentence[: m.start()]
                # "Datum: 03.11.2026" is the date of the letter, not something to do
                if LETTER_DATE.search(before[-25:]):
                    continue
                if DEADLINE_WORDS.search(sentence):
                    kind = "deadline"
                elif PAYMENT_WORDS.search(sentence):
                    kind = "payment"
                else:
                    continue
                key = (when.isoformat(), sentence)
                if key in seen:
                    continue
                seen.add(key)
                # the amount is often named just before: "Die Nachzahlung beträgt 1.234,56 EUR. Bitte zahlen Sie bis …"
                a = AMOUNT.search(sentence) or (AMOUNT.search(sentences[index - 1]) if index else None)
                amount = (a.group("a1") or a.group("a2")) + " EUR" if a else None
                found.append(FoundDate(date=when.isoformat(), kind=kind, text=sentence[:300], amount=amount))
    return found


def as_dicts(items: List[FoundDate]) -> List[dict]:
    return [asdict(i) for i in items]
