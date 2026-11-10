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
BY_DATE = re.compile(r"\b(bis zum|bis spätestens|spätestens (am|bis)?|bis|fällig am|by|until|no later than|before)\s*$",
                     re.IGNORECASE)
SHORT_LINE = 60  # shorter lines without an end mark are headings, address lines or "label: value" rows
# "bitte kommen Sie am 18.11.2026 um 10:30 Uhr": an appointment needs a time of day or a word that names one
APPOINTMENT_WORDS = re.compile(
    r"\b(termin\w*|einladung|eingeladen|kommen sie|erscheinen|vorsprache|vorstellungsgespräch|sprechstunde|"
    r"appointment|interview|meeting|please come|attend)\b",
    re.IGNORECASE,
)
TIME_OF_DAY = re.compile(r"\b(?P<h>[01]?\d|2[0-3])[:.](?P<min>[0-5]\d)\s?(uhr|h\b|am\b|pm\b)|\bum (?P<h2>[01]?\d|2[0-3]) uhr",
                         re.IGNORECASE)
LETTER_DATE = re.compile(r"\b(datum|date|ausgestellt am|vom)\s*:?\s*$", re.IGNORECASE)
AMOUNT = re.compile(
    r"(?:(?:€|EUR)\s?(?P<a1>(?<![\d.,])\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})|\d+(?:[.,]\d{2})))"
    r"|(?:(?P<a2>(?<![\d.,])\d{1,3}(?:[.\s]\d{3})*(?:,\d{2})|\d+(?:[.,]\d{2}))\s?(?:€|EUR|Euro))",
    re.IGNORECASE,
)


@dataclass
class FoundDate:
    date: str  # ISO yyyy-mm-dd
    kind: str  # "deadline", "payment" or "appointment"
    text: str  # the sentence or line it stands in
    amount: Optional[str] = None
    time: Optional[str] = None  # hh:mm, for appointments


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
    """Lines, and sentences within long lines; a sentence may run over a line break ("… bis zum\\n15.12.2026").
    Short lines without an end mark (letterhead, address, "Nachzahlung: 268,40 EUR") stand alone: in a PDF every
    line ends with a plain line break, and joining them made the whole letterhead one "sentence"."""
    flat = re.sub(r"[ \t]+", " ", text)
    lines = flat.split("\n")
    # narrow columns (a phone photo, a scan) have short prose lines: "short" is measured against this text's lines
    prose = sorted(len(l.strip()) for l in lines if len(l.strip()) > 20)
    short = min(SHORT_LINE, int(prose[len(prose) // 2] * 0.6)) if prose else SHORT_LINE
    joined = ""
    for i, line in enumerate(lines):
        joined += line
        if i == len(lines) - 1:
            break
        stripped = line.strip()
        label_value = re.match(r"^[\wÄÖÜäöüß .()/-]{2,45}:\s+\S", stripped) and not stripped.endswith((".", ","))
        short_line = (label_value or 0 < len(stripped) < short) and not re.search(r"[,;:\-–(]$|\b(bis|zum|zur|am|vom|den|der|die|das|und|oder|von|für|by|on|the|to|of|and)$", stripped, re.I)
        joined += "\n\n" if short_line else "\n"
    # also after a full date or number at a line end ("… bis zum 20.11.2026.\nDanach …"), but not inside "15. Dezember"
    parts = re.split(r"(?<=[^\d\s][.!?])\s+(?=[A-ZÄÖÜ])|(?<=\d{4}[.!?])\s+(?=[A-ZÄÖÜ])|(?<=\d[.!?])[ \t]*\n\s*(?=[A-ZÄÖÜ])|\n{2,}",
                     joined)
    return [p.replace("\n", " ").strip() for p in parts if p.strip()]


def _nearest_amount(sentence: str, at: int):
    """The amount closest before the date in the sentence ("Nachzahlung von 412,00 EUR ist fällig am 15.12.2026"),
    else the closest after it."""
    hits = list(AMOUNT.finditer(sentence))
    before = [a for a in hits if a.end() <= at]
    if before:
        return before[-1]
    return hits[0] if hits else None


def _window(sentence: str, start: int, end: int, size: int = 240) -> str:
    """The sentence, or the part of a long one around the date."""
    if len(sentence) <= size:
        return sentence
    left = max(0, start - size // 2)
    cut = sentence.rfind(" ", 0, left + 1)
    left = cut + 1 if cut > 0 else left
    text = sentence[left:left + size]
    text = text[: text.rfind(" ")] if len(sentence) > left + size and " " in text else text
    return ("… " if left else "") + text + (" …" if len(sentence) > left + size else "")


def find_dates(text: str) -> List[FoundDate]:
    """Deadlines and payment dates in a document's text, in the order they appear."""
    found, seen = [], set()
    sentences = _sentences(text or "")
    for index, sentence in enumerate(sentences):
        matches = [m for pattern in DATE_PATTERNS for m in pattern.finditer(sentence)]
        # "Ihre Kündigung zum 31.12.2026 muss uns bis zum 30.11.2026 vorliegen": with several dates, the one right after
        # "bis zum" / "by" is the deadline, the others only describe it
        marked = [m for m in matches if BY_DATE.search(sentence[max(0, m.start() - 22):m.start()])]
        if marked and len(matches) > 1:
            matches = marked
        for m in sorted(matches, key=lambda m: m.start()):
            if True:
                when = _parse(m)
                if not when or not (2000 <= when.year <= 2100):
                    continue
                before = sentence[: m.start()]
                # "Datum: 03.11.2026" is the date of the letter, not something to do
                if LETTER_DATE.search(before[-25:]):
                    continue
                clock = TIME_OF_DAY.search(sentence[m.end():m.end() + 40])
                time_of_day = None
                if clock:
                    time_of_day = f"{int(clock.group('h') or clock.group('h2')):02d}:{clock.group('min') or '00'}"
                if APPOINTMENT_WORDS.search(sentence) and (clock or not DEADLINE_WORDS.search(sentence)):
                    kind = "appointment"
                elif DEADLINE_WORDS.search(sentence):
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
                a = _nearest_amount(sentence, m.start())
                for back in (1, 2):  # "beträgt 687,12 EUR. Grund ist … Der Betrag wird am 01.01.2027 eingezogen."
                    if a or index < back:
                        break
                    a = AMOUNT.search(sentences[index - back])
                amount = (a.group("a1") or a.group("a2")) + " EUR" if a else None
                found.append(FoundDate(date=when.isoformat(), kind=kind, text=_window(sentence, m.start(), m.end()),
                                       amount=amount if kind != "appointment" else None,
                                       time=time_of_day if kind == "appointment" else None))
    return found


# "Diese korrigierte Abrechnung ersetzt die Abrechnung vom 20.10.2026", "replaces our letter of 20 October 2026"
REPLACES = re.compile(r"\b(ersetzt|ersetzen|replaces|supersedes)\b[^.]{0,80}?\b(vom|of|dated)\s+", re.IGNORECASE)
LETTER_DATE_LINE = re.compile(r"^\s*(datum|date)\s*:?\s*(?P<rest>.+)$", re.IGNORECASE | re.MULTILINE)


def _first_date(text: str) -> Optional[date]:
    hits = [(m.start(), _parse(m)) for p in DATE_PATTERNS for m in p.finditer(text)]
    hits = [h for h in hits if h[1]]
    return min(hits)[1] if hits else None


def letter_date(text: str) -> Optional[str]:
    """The date the letter was written ("Datum: 05.11.2026"), ISO, or None."""
    for m in LETTER_DATE_LINE.finditer(text or ""):
        d = _first_date(m.group("rest"))
        if d:
            return d.isoformat()
    return None


def replaced_letters(text: str) -> List[str]:
    """Dates of earlier letters this one says it replaces, ISO."""
    out = []
    for m in REPLACES.finditer(text or ""):
        d = _first_date(text[m.end():m.end() + 30])
        if d and d.isoformat() not in out:
            out.append(d.isoformat())
    return out


def sender(text: str) -> str:
    """The first line of the letter, normally the sender's name; used to match a letter with its correction."""
    for line in (text or "").splitlines():
        if line.strip():
            return re.sub(r"\s+", " ", line.strip().lower())
    return ""


def as_dicts(items: List[FoundDate]) -> List[dict]:
    return [asdict(i) for i in items]
