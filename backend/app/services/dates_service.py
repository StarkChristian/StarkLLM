"""Dates in letters: deadlines and payments, found by rules (German and English), never by the language model.

Every date returned is in the text, with the sentence it stands in, so the UI can show and link it. This is the
first part of "understanding" documents (docs/document-inbox-design.md, B3).
"""
import calendar
import re
from dataclasses import dataclass, asdict
from datetime import date, timedelta
from decimal import Decimal, InvalidOperation
from typing import List, Optional, Tuple

from app.services.locale_rules import (
    CONTRACT_START, CURRENCY, MONTHS, MONTH_PATTERN, NOTICE_WORDS, NUMBER_WORDS, PERIOD_BEFORE, PERIOD_UNITS, compiled,
    currency_code, month_number, rule,
)

_MONTH_NAMES = MONTH_PATTERN
_UPPER = "A-ZÀ-ÖØ-ÞİŞĞ"  # a letter that can start a sentence, in the languages above
# a day, its ending ("1er", "15th", "15.") and the month name with the little words of the language ("15 de diciembre de 2026")
_DAY = r"(?<!\d)(?P<d>\d{1,2})(?:\.|er|º|°|st|nd|rd|th)?"
_OF = r"(?:de\s+|of\s+|d['’]\s?)?"

DATE_PATTERNS = [
    # 15.12.2026, 1.1.27 (Germany, Austria, Switzerland, Turkey, Russia ...)
    re.compile(r"(?<![\d.])(?P<d>\d{1,2})\.\s?(?P<m>\d{1,2})\.\s?(?P<y>\d{4}|\d{2})(?![\d.]*\d)"),
    # 2026-12-15, 2026/12/15, 2026.12.15
    re.compile(r"(?<!\d)(?P<y>\d{4})[-/.](?P<m>\d{1,2})[-/.](?P<d>\d{1,2})(?!\d)"),
    # 15/12/2026, 12/15/2026, 15-12-2026: day first or month first, see date_order()
    re.compile(r"(?<![\d/.\-])(?P<a>\d{1,2})(?P<sep>[/\-])(?P<b>\d{1,2})(?P=sep)(?P<y>\d{4}|(?<=/)\d{2})(?![\d/])"),
    # 15. Dezember 2026, 15 December 2026, 1er décembre 2026, 15 de diciembre de 2026, 15 Aralık 2026
    re.compile(rf"{_DAY}\s+{_OF}(?P<mn>{_MONTH_NAMES})\.?\s+(?:de\s+)?(?P<y>\d{{4}})", re.IGNORECASE),
    # December 15, 2026 / Dec 15th, 2026
    re.compile(rf"(?<![\w])(?P<mn>{_MONTH_NAMES})\.?\s+(?P<d>\d{{1,2}})(?:st|nd|rd|th)?,?\s+(?P<y>\d{{4}})", re.IGNORECASE),
]
SLASH_DATE = DATE_PATTERNS[2]

DEADLINE_WORDS = compiled("deadline")
PAYMENT_WORDS = compiled("payment", r"\b(?:{})\b")
BY_DATE = compiled("by_date", r"\b(?:{})\s*$")
# Turkish puts the word behind the date: "15.12.2026 tarihine kadar"
BY_DATE_AFTER = re.compile(rf"^\s*(?:{rule('by_date_after')})(?![^\W\d_])", re.IGNORECASE)
SHORT_LINE = 60  # shorter lines without an end mark are headings, address lines or "label: value" rows
# "bitte kommen Sie am 18.11.2026 um 10:30 Uhr": an appointment needs a time of day or a word that names one
APPOINTMENT_WORDS = compiled("appointment")
# 10:30, 10.30 Uhr, 3:30 pm, 9 am, 14h30, "a las 10:30", "alle ore 9", "saat 10:30"
TIME_OF_DAY = re.compile(
    r"\b(?P<h>[01]?\d|2[0-3]):(?P<min>[0-5]\d)(?:\s?(?P<ap>am|pm|a\.m\.|p\.m\.))?(?![\d:])"
    r"|\b(?P<h1>[01]?\d|2[0-3])\.(?P<min1>[0-5]\d)\s?(?:uhr|h\b|am\b|pm\b)"
    r"|\b(?P<h2>[01]?\d|2[0-3]) uhr\b"
    r"|\b(?P<h3>1[0-2]|0?[1-9])\s?(?P<ap3>am|pm)\b"
    r"|\b(?P<h4>[01]?\d|2[0-3])\s?h\s?(?P<min4>[0-5]\d)?\b"
    r"|\b(?:a las|a la|alle ore|alle|ore|saat)\s+(?P<h5>[01]?\d|2[0-3])(?:[:.](?P<min5>[0-5]\d))?\b",
    re.IGNORECASE,
)
# the label of the date of the letter ("Datum:"), or of an earlier document ("Rechnung vom"): not something to do
LETTER_DATE = re.compile(rf"\b(?:{rule('letter_date_label')}|{rule('document_date_ref')})\s*:?\s*$", re.IGNORECASE)
# "Due date: 15.12.2026" and "Zahlungsziel" are deadlines even though they end in "date"
NOT_LETTER_DATE = re.compile(r"\b(?:due|payment|pay|expiry|expiration|deadline|cancellation|renewal|effective|delivery|"
                             r"appointment|closing|start|end|termination)\s+date\s*:?\s*$", re.IGNORECASE)


def _numbers():
    # amounts: 1.234,56 (point thousands, comma decimals), 1,234.56, 1 234,56 (spaces), 1'234.56 (Swiss), 412,- , 500
    sep = "[.,'’   ]"
    return (rf"(?<![\d.,'’  ])(?:\d{{1,3}}(?:{sep}\d{{3}})+|\d+)"
            r"(?:[.,]\d{1,2}(?!\d)|[.,][-–—]{1,2}(?!\w))?(?!\d|[.,]\d)")


NUMBER = _numbers()
_AMOUNT_PATTERN = re.compile(rf"(?:(?P<c1>{CURRENCY})\s?(?P<n1>{NUMBER}))|(?:(?P<n2>{NUMBER})\s?(?P<c2>{CURRENCY}))",
                             re.IGNORECASE)

# "Electricity October 2026 GBP 129.40", "Water Q3 2026 CHF 64.70", "Abschlag November 2026 EUR 58,10": the year of the
# period stands right before the currency code, and the pattern above alone reads "2026 GBP" and loses the 129.40.
# The rule: a plain year (1900-2099, four digits, no separator, no cents) directly before a currency is not the amount
# when the currency itself starts an amount ("GBP 129.40") and either
#   * that amount has cents ("129.40", "58,10"): a price is written with cents, a year never is, or
#   * the year follows a month, a quarter or the word for year ("October 2026", "Q3 2026", "Jahr 2026"),
# and the currency then belongs to the number after it. In every other case the year stays the amount, so a real
# amount of 2026 still counts: "Total 2026 EUR" (no number follows), "Bitte zahlen Sie 1950 EUR 14 Tage nach Erhalt"
# (no cents, and nothing before 1950 makes it a year).
_PLAIN_YEAR = re.compile(r"(?:19|20)\d{2}")
_CENTS = re.compile(r"[.,]\d{1,2}$")
_YEAR_CONTEXT = re.compile(
    rf"(?:\b(?:{MONTH_PATTERN}|jan|feb|mar|apr|jun|jul|aug|sep|oct|okt|nov|dec|dez)\.?"
    r"|\b[QH][1-4]|\b[1-4]\.?\s?(?:quartal|quarter|trimestre|çeyrek)|\bFY"
    r"|\b(?:year|jahr|año|ano|année|annee|anno|yıl|yil|ejercicio|exercice|geschäftsjahr|steuerjahr|tax year))"
    r"\W{0,3}$", re.IGNORECASE)


def _year_before_amount(text: str, m) -> bool:
    """m is "<number> <currency>": True when the number is the year of a period and the currency starts the real
    amount (the rule above)."""
    if not m.group("n2") or not _PLAIN_YEAR.fullmatch(m.group("n2")):
        return False
    after = _AMOUNT_PATTERN.match(text, m.start("c2"))
    if not after or not after.group("n1"):
        return False
    return bool(_CENTS.search(after.group("n1")) or _YEAR_CONTEXT.search(text[max(0, m.start() - 40):m.start()]))


class _AmountPattern:
    """The amount pattern plus the year rule above, which a regular expression alone cannot say: finditer and search
    skip a year before a currency and find the amount that starts at the currency instead. Everything else is the
    compiled pattern's."""

    def __init__(self, pattern):
        self._pattern = pattern

    def finditer(self, text: str, pos: int = 0, endpos: Optional[int] = None):
        end = len(text) if endpos is None else min(endpos, len(text))
        while pos <= end:
            m = self._pattern.search(text, pos, end)
            if not m:
                return
            if _year_before_amount(text[:end], m):
                pos = m.start("c2")  # the next match starts at the currency
                continue
            yield m
            pos = max(m.end(), m.start() + 1)

    def search(self, text: str, pos: int = 0, endpos: Optional[int] = None):
        return next(self.finditer(text, pos, endpos), None)

    def __getattr__(self, name):
        return getattr(self._pattern, name)


AMOUNT = _AmountPattern(_AMOUNT_PATTERN)
# "eine Mahngebühr von 10,00 EUR. Bitte überweisen Sie den offenen Betrag bis …": the fee is not what is due
FEE_BEFORE = re.compile(rf"(?:{rule('fee')})(?:\s+(?:de|d['’]|di|del|por)\s+\w+)?\W{{0,3}}(?:von|in höhe von|of|de|d['’]|di|por|:)?\s*$",
                        re.IGNORECASE)
# "687,12 EUR (bisher 598,40 EUR)", "6,90 EUR statt bisher 4,90 EUR": the old amount is not what is due
OLD_BEFORE = re.compile(rf"\b(?:{rule('old_amount')})\W{{0,3}}(?:bisher\W{{0,2}})?$", re.IGNORECASE)
# "£3.00/m³" (as the OCR reads it also "/m3", "/m?"), "0,32 €/kWh", "0,32 EUR pro kWh", "12,00 € par mois": a price per
# unit, not an amount to pay. After the amount: a slash and a letter, or a word like "per" and a unit.
RATE_AFTER = re.compile(rf"[ \t]?/[ \t]?[^\W\d_]\S*|[ \t]*(?:{rule('rate_per')})[ \t]+(?:{rule('rate_unit')})(?!\w)",
                        re.IGNORECASE)
# in front of it: "Preis pro kWh: 0,32 €", "Rate per m³ £3.00", "kWh başına 0,32 TL"
RATE_BEFORE = re.compile(rf"(?<!\w)(?:{rule('rate_per')})[ \t]+(?:{rule('rate_unit')})[ \t]*(?:\([^)\n]{{0,20}}\))?[ \t]*[:=]?[ \t]*$|"
                         rf"(?<!\w)(?:{rule('rate_unit')})[ \t]+başına[ \t]*:?[ \t]*$", re.IGNORECASE)
# the label of the sum to pay right in front of it: "Total due £63.40", "Gesamtbetrag: 84,20 EUR", "Montant à payer : 112,30
# EUR", "the total due of 63.40 GBP", "Total (incl. VAT): £63.40"; not "Subtotal £63.40" or "Ara toplam"
TOTAL_BEFORE = re.compile(rf"(?<![\w\-])(?<!ara )(?:{rule('total')})(?!\w)[ \t]*(?:\([^)\n]{{0,30}}\))?[ \t]*"
                          r"(?:of|von|de|di|du|:|=)?[ \t]*:?[ \t]*$", re.IGNORECASE)
# a sentence about paying or a due day ("Due by: 12 December 2026"); see find_dates
PAY_DUE = compiled("pay_due")
# "ab dem 01.02.2027 beträgt Ihr Beitrag …": the day something changes, not something to do or pay
FROM_DATE = compiled("from_date", r"\b(?:{})\s*$")
FROM_DATE_AFTER = re.compile(rf"^\s*(?:{rule('from_date_after')})(?![^\W\d_])", re.IGNORECASE)
# "bis zum 15.12." without a year, after a word that makes it a deadline; the letter's year is meant
NO_YEAR = re.compile(r"(?<![\d.])(?P<d>\d{1,2})\.(?P<m>\d{1,2})\.(?!\s?\d)")
# "bis zum 15. Dezember", "avant le 15 décembre", "hasta el 15 de diciembre"
NO_YEAR_NAMED = re.compile(rf"{_DAY}\s+{_OF}(?P<mn>{_MONTH_NAMES})(?![\w])(?!\.?\s*(?:de\s+)?\d{{4}})", re.IGNORECASE)
# "Zeitraum 01.01.2025 bis 31.12.2025", "du 01/01/2026 au 31/12/2026": the end of a period, not a deadline
PERIOD_END = re.compile(rf"\d{{2,4}}\s*(?:{rule('period_join')})\s*$", re.IGNORECASE)
# the line "Rheinstadt, 03.11.2026", "Paris, le 3 novembre 2026", "Madrid, 3 de noviembre de 2026"
PLACE_DATE = re.compile(rf"^\s*[{_UPPER}][\w .\-]{{1,40}},\s*(?:den\s+|le\s+|el\s+|il\s+|the\s+)?(?P<rest>\d.{{5,30}})$", re.MULTILINE)


# Notice periods: "give notice at least 30 days before 31 March 2027" -> the last day to give notice is 1 March 2027.
_COUNT = r"(?P<n>\d{1,3}|" + "|".join(sorted(NUMBER_WORDS, key=len, reverse=True)) + r")"
_UNIT = r"(?P<unit>" + "|".join(PERIOD_UNITS.values()) + r")\b"
NOTICE_SENTENCE = re.compile(r"\b(?:" + "|".join(NOTICE_WORDS.values()) + r")", re.IGNORECASE)
NOTICE_BEFORE = re.compile(_COUNT + r"[\s-]*" + _UNIT + r"(?:['’]s?)?\s+(?:(?:written\s+)?notice\s+)?(?:" + "|".join(PERIOD_BEFORE.values())
                           + r")\b(?P<tail>[^\d]{0,50})$", re.IGNORECASE)
# "ein Monat vor Ablauf, also bis 30.11.2026": the letter already names the last day, nothing is counted back
EXPLICIT_DAY = re.compile(r"\b(?:bis|sp[äa]testens|also|d\.\s?h\.|by|until|i\.e\.|namely|jusqu\w*|hasta|es decir|entro|cio[èe]|yani)\b|c.est-[àa]-dire",
                          re.IGNORECASE)
# Turkish puts it behind the date: "31 Mart 2027 tarihinden en az 30 gün önce"
NOTICE_AFTER = re.compile(r"^\s*(?:tarihinden\s+|tarihine\s+)?(?:en az\s+)?" + _COUNT + r"\s*" + _UNIT + r"\s+önce", re.IGNORECASE)
CONTRACT_START_BEFORE = re.compile(r"(?:" + CONTRACT_START + r")[^\d]{0,25}$", re.IGNORECASE)
CONTRACT_START_SENTENCE = re.compile(CONTRACT_START, re.IGNORECASE)


def _count(word: str) -> Optional[int]:
    return int(word) if word.isdigit() else NUMBER_WORDS.get(word.lower())


def _unit(word: str) -> Optional[str]:
    return next((k for k, rx in PERIOD_UNITS.items() if re.fullmatch(rx, word, re.IGNORECASE)), None)


def minus_period(day: date, count: int, unit: str) -> date:
    """day minus count days, weeks or months (31 March minus one month is 28 February, the last day that exists)."""
    if unit == "days":
        return day - timedelta(days=count)
    if unit == "weeks":
        return day - timedelta(weeks=count)
    year, month = divmod(day.year * 12 + day.month - 1 - count, 12)
    return date(year, month + 1, min(day.day, calendar.monthrange(year, month + 1)[1]))


def notice_deadline(sentence: str, start: int, end: int, when: date) -> Optional[dict]:
    """When the sentence is about giving notice of a contract and says that this has to happen N days, weeks or months
    before the date at sentence[start:end], {"date", "base", "count", "unit"}: the last day to give notice, counted back
    from the date, which is the end of the contract and is not the deadline itself."""
    if not NOTICE_SENTENCE.search(sentence):
        return None
    hit = NOTICE_BEFORE.search(sentence[max(0, start - 110):start]) or NOTICE_AFTER.search(sentence[end:end + 70])
    if hit and "tail" in hit.groupdict() and EXPLICIT_DAY.search(hit.group("tail")):
        return None
    count, unit = (_count(hit.group("n")), _unit(hit.group("unit"))) if hit else (None, None)
    if not count or not unit:
        return None
    return {"date": minus_period(when, count, unit).isoformat(), "base": when.isoformat(), "count": count, "unit": unit}


def parse_number(text: str) -> Optional[str]:
    """The value of an amount as written ("1.234,56", "1,234.56", "1 234,56", "1'234.50", "412,-") as "1234.56"."""
    s = re.sub(r"[.,][-–—]+$", ",00", (text or "").strip())  # 412,- and CHF 148.-
    s = re.sub(r"[\s  '’]", "", s)
    if "," in s and "." in s:
        decimal = "," if s.rfind(",") > s.rfind(".") else "."
        s = s.replace("," if decimal == "." else ".", "").replace(decimal, ".")
    elif "," in s or "." in s:
        sep = "," if "," in s else "."
        parts = s.split(sep)
        if len(parts) > 2 or (len(parts[-1]) == 3 and parts[0] not in ("0", "00")):
            s = "".join(parts)  # 1.234 / 1,234,567: thousands
        else:
            s = ".".join(parts)
    try:
        return f"{Decimal(s):.2f}"
    except InvalidOperation:
        return None


def amount_parts(a) -> Tuple[str, Optional[str], str]:
    """(the number as written, its value "1234.56", the ISO currency code) of an AMOUNT match."""
    written = (a.group("n1") or a.group("n2") or "").replace(" ", " ").replace(" ", " ").strip()
    return written, parse_number(written), currency_code(a.group("c1") or a.group("c2"))


# "2026-11-14 08:00:01 INFO started", "[2026-11-14T08:00:01Z] ERROR ...", "2026-11-14 WARN ...": a log line starts with a
# bare timestamp. Its date is when something happened, never a deadline, unless a deadline word stands in the line.
LOG_LINE = re.compile(
    r"^\s*[\[(]?\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?[\])]?|[\])]?\s+"
    r"(?:trace|debug|info|notice|warn|warning|error|err|fatal|critical|severe)\b)", re.IGNORECASE)
LOG_DEADLINE_WORDS = re.compile(
    r"\b(frist|fällig|fälligkeit|zahlungsziel|bis zum|bis spätestens|spätestens|gültig bis|"
    r"deadline|due|no later than|expires|expiry|valid until)\b", re.IGNORECASE)


def is_log_line(line: str) -> bool:
    """A log line: a bare ISO timestamp (or date and log level) at the start, and no deadline word in the line."""
    return bool(LOG_LINE.match(line)) and not LOG_DEADLINE_WORDS.search(line)


def without_log_lines(text: str) -> str:
    """The text with its log lines emptied, so a timestamp is not read as a date to act on."""
    return "\n".join("" if is_log_line(line) else line for line in (text or "").split("\n"))


def _amount_text(a) -> str:
    written, _, code = amount_parts(a)
    return f"{written} {code}"


@dataclass
class FoundDate:
    date: str  # ISO yyyy-mm-dd
    kind: str  # "deadline", "payment", "appointment" or "change"
    text: str  # the sentence or line it stands in
    amount: Optional[str] = None
    time: Optional[str] = None  # hh:mm, for appointments
    line: Optional[int] = None  # number of the line on the page (empty lines not counted) the date is written on
    # "03/04/2026" without anything in the letter that says which comes first: the date above is only the default
    # reading, both are given and the user chooses (see ambiguous_readings). literal is the date as written.
    ambiguous: bool = False
    readings: Optional[dict] = None  # {"dmy": "2026-04-03", "mdy": "2026-03-04"}
    literal: Optional[str] = None
    # "at least 30 days before 31 March 2027": date is the last day to give notice (1 March 2027), counted back from
    # notice["base"], the end of the contract; the sentence with its page and line says so
    notice: Optional[dict] = None


def _parse(m, order: str = "dmy") -> Optional[date]:
    """The date of a DATE_PATTERNS match. order ("dmy" or "mdy") only matters for 03/04/2026; a reading that is
    possible in one order only (15/12/2026) always wins."""
    g = m.groupdict()
    try:
        y = int(g["y"])
        if y < 100:
            y += 2000
        if g.get("mn"):
            return date(y, month_number(g["mn"]), int(g["d"]))
        if g.get("a") is not None:
            a, b = int(g["a"]), int(g["b"])
            d, mo = (a, b) if order == "dmy" else (b, a)
            if mo > 12 >= d:
                d, mo = mo, d
            return date(y, mo, d)
        return date(y, int(g["m"]), int(g["d"]))
    except (ValueError, KeyError, TypeError):
        return None


def date_order_evidence(text: str) -> Optional[str]:
    """"dmy" or "mdy" when a date in the document proves how its slash dates are written (15/12/2026 can only be day
    first, 12/15/2026 only month first), else None."""
    day_first = month_first = False
    for m in SLASH_DATE.finditer(text or ""):
        a, b = int(m.group("a")), int(m.group("b"))
        if a > 12 >= b:
            day_first = True
        elif b > 12 >= a:
            month_first = True
    if day_first != month_first:
        return "dmy" if day_first else "mdy"
    return None


def ambiguous_readings(m, order_known: bool) -> Optional[dict]:
    """The two readings of a slash date like 03/04/2026 when nothing in the letter says which is meant, else None:
    {"dmy": "2026-04-03", "mdy": "2026-03-04"}. Never a guess: the caller shows both and the user chooses."""
    if order_known or m.re is not SLASH_DATE:
        return None
    a, b = int(m.group("a")), int(m.group("b"))
    if a > 12 or b > 12 or a == b:
        return None
    y = int(m.group("y"))
    y += 2000 if y < 100 else 0
    try:
        return {"dmy": date(y, b, a).isoformat(), "mdy": date(y, a, b).isoformat()}
    except ValueError:
        return None


def date_order(text: str) -> str:
    """"dmy" or "mdy": how 03/04/2026 is read by default in this document. Another date in it can tell (15/12/2026 is
    day first, 12/15/2026 month first); else a US-looking letter ($, no euro or pound) is month first, and everything
    else day first, as in most of the world. Such a guess is only a default: find_dates marks the date ambiguous."""
    evidence = date_order_evidence(text)
    if evidence:
        return evidence
    if re.search(r"\$|\bUSD\b", text or "") and not re.search(r"[€£]|\b(?:EUR|GBP|CHF)\b", text or "") \
            and re.search(r"\b(?:the|your|and)\b", text or "", re.IGNORECASE):
        return "mdy"
    return "dmy"


def _clock(m) -> str:
    """hh:mm of a TIME_OF_DAY match."""
    g = m.groupdict()
    hour = int(g["h"] or g["h1"] or g["h2"] or g["h3"] or g["h4"] or g["h5"] or 0)
    minute = g["min"] or g["min1"] or g["min4"] or g["min5"] or "00"
    ampm = (g["ap"] or g["ap3"] or "").lower().replace(".", "")
    if ampm == "pm" and hour < 12:
        hour += 12
    elif ampm == "am" and hour == 12:
        hour = 0
    return f"{hour:02d}:{minute}"


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
        label_value = re.match(r"^[\w .()/-]{2,45}:\s+\S", stripped) and not stripped.endswith((".", ","))
        # "Paris, le 3 novembre 2026" under the letterhead is a line of its own, however long it is
        placed = bool(PLACE_DATE.match(stripped)) and not re.search(r"[.!?]$", stripped)
        short_line = (label_value or placed or 0 < len(stripped) < short) and not re.search(
            r"[,;:\-–(]$|\b(bis|zum|zur|am|vom|den|der|die|das|und|oder|von|für|by|on|the|to|of|and|"
            r"le|la|du|de|au|avant|et|ou|pour|par|el|del|hasta|antes|y|para|por|il|di|entro|al|dal|per|ve|ile)$",
            stripped, re.I)
        joined += "\n\n" if short_line else "\n"
    # also after a full date or number at a line end ("… bis zum 20.11.2026.\nDanach …"), but not inside "15. Dezember"
    up = f"[{_UPPER}]"
    parts = re.split(rf"(?<=[^\d\s][.!?])\s+(?={up})|(?<=\d{{4}}[.!?])\s+(?={up})|(?<=\d[.!?])[ \t]*\n\s*(?={up})|\n{{2,}}",
                     joined)
    return [p.replace("\n", " ").strip() for p in parts if p.strip()]


def _amount_candidates(sentence: str, at: int):
    """Amounts before the date (closest first), then after it."""
    hits = list(AMOUNT.finditer(sentence))
    before = [a for a in hits if a.end() <= at]
    return list(reversed(before)) + [a for a in hits if a.end() > at]


def _is_fee(text: str, a) -> bool:
    before = text[max(0, a.start() - 30):a.start()]
    return bool(FEE_BEFORE.search(before) or OLD_BEFORE.search(before))


def _before_on_line(text: str, a) -> str:
    """The text in front of amount a on its line, after any amount before it on that line (and that amount's "/m³" or
    "per kWh"): in "Water used  15 m³  £3.00/m³  £45.00" the 45.00 has nothing in front of it."""
    start = text.rfind("\n", 0, a.start()) + 1
    for prev in AMOUNT.finditer(text, start, a.start()):
        if prev.end() <= a.start():
            per = RATE_AFTER.match(text, prev.end())
            start = max(prev.end(), per.end() if per else 0)
    return text[start:a.start()] if start <= a.start() else ""


def is_rate(text: str, a) -> bool:
    """Amount a is a price per unit ("£3.00/m³", "0,32 €/kWh", "Preis pro kWh: 0,32 €"), no amount to pay."""
    return bool(RATE_AFTER.match(text, a.end()) or RATE_BEFORE.search(_before_on_line(text, a)))


def is_total(text: str, a) -> bool:
    """Amount a stands under the label of the sum to pay ("Total due", "Gesamtbetrag", "Montant à payer")."""
    return bool(TOTAL_BEFORE.search(_before_on_line(text, a)))


def letter_total(text: str):
    """The one sum to pay the text names under a total label (an AMOUNT match), or None when there is none or the
    labelled sums differ."""
    totals = [a for a in AMOUNT.finditer(text or "") if is_total(text, a) and not is_rate(text, a) and not _is_fee(text, a)]
    values = {amount_parts(a)[1:] for a in totals}
    return totals[0] if len(values) == 1 else None


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


def _line_number(text: str, literal: str, sentence: str) -> Optional[int]:
    """Which line of the page (1-based, empty lines not counted) a date is written on. When the same date text is on
    several lines, the line that is part of the date's sentence wins."""
    squash = lambda value: re.sub(r"\s+", " ", value).strip()
    wanted, flat = squash(literal), squash(sentence)
    hits = [(number, squash(line)) for number, line in enumerate((l for l in text.split("\n") if l.strip()), 1)
            if wanted in squash(line)]
    if not hits:
        return None
    return next((number for number, line in hits if line in flat), hits[0][0])


def find_dates(text: str, reference: Optional[date] = None, order_hint: Optional[str] = None) -> List[FoundDate]:
    """Deadlines, payments, appointments and changes in a document's text, in the order they appear. reference is the
    day the letter was written (its "Datum:", else today); a date without a year ("bis zum 15.12.") is the next such
    day from then."""
    found, seen = [], set()
    text = without_log_lines(text or "")  # a timestamp in a log is no date to act on
    sentences = _sentences(text)
    # order_hint: what the whole document says about slash dates, when text is only one page of it
    order = order_hint or date_order(text)
    order_known = order_hint is not None or date_order_evidence(text) is not None
    if reference is None:
        written = letter_date(text or "")
        reference = date.fromisoformat(written) if written else date.today()
    total = False  # the letter's total, looked up once when needed
    for index, sentence in enumerate(sentences):
        matches = [(m, _parse(m, order)) for pattern in DATE_PATTERNS for m in pattern.finditer(sentence)]
        for m in [*NO_YEAR.finditer(sentence), *NO_YEAR_NAMED.finditer(sentence)]:
            lead = sentence[max(0, m.start() - 22):m.start()]
            # "bis zum 15.12.", or "am 15.12." in a sentence about a payment ("Die Abbuchung … erfolgt am 15.12.")
            if BY_DATE.search(lead) or BY_DATE_AFTER.search(sentence[m.end():m.end() + 30]) or (
                    re.search(r"\b(am|on|le|el|il)\s*$", lead, re.IGNORECASE) and PAYMENT_WORDS.search(sentence)):
                month = int(m.group("m")) if "m" in m.re.groupindex else month_number(m.group("mn"))
                when = _without_year(int(m.group("d")), month, reference) if month else None
                if when:
                    matches.append((m, when))
        # "Ihre Kündigung zum 31.12.2026 muss uns bis zum 30.11.2026 vorliegen": with several dates, the one right after
        # "bis zum" / "by" is the deadline, the others only describe it
        marked = [x for x in matches if BY_DATE.search(sentence[max(0, x[0].start() - 22):x[0].start()])
                  or BY_DATE_AFTER.search(sentence[x[0].end():x[0].end() + 30])]
        if marked and len(matches) > 1:
            matches = marked
        for m, when in sorted(matches, key=lambda x: x[0].start()):
            if not when or not (2000 <= when.year <= 2100):
                continue
            before = sentence[: m.start()]
            # "Datum: 03.11.2026" is the date of the letter, not something to do
            if LETTER_DATE.search(before[-34:]) and not NOT_LETTER_DATE.search(before[-34:]):
                continue
            clock = TIME_OF_DAY.search(sentence[m.end():m.end() + 40])
            time_of_day = _clock(clock) if clock else None
            # "Zeitraum 01.01.2025 bis 31.12.2025": the end of a period, not a deadline
            if PERIOD_END.search(before[-30:]):
                continue
            by = BY_DATE.search(before[-22:]) or BY_DATE_AFTER.search(sentence[m.end():m.end() + 30])
            # the start of a contract is not something to do: "The contract starts on 1 April 2026"
            if CONTRACT_START_BEFORE.search(before[-70:]) or (
                    CONTRACT_START_SENTENCE.search(sentence) and not by and not DEADLINE_WORDS.search(sentence)):
                continue
            notice = notice_deadline(sentence, m.start(), m.end(), when)
            if notice:
                when = date.fromisoformat(notice["date"])
            if notice:
                kind = "deadline"
            elif APPOINTMENT_WORDS.search(sentence) and (clock or not DEADLINE_WORDS.search(sentence)):
                kind = "appointment"
            elif by or DEADLINE_WORDS.search(sentence):
                kind = "deadline"
            elif FROM_DATE.search(before[-24:]) or FROM_DATE_AFTER.search(sentence[m.end():m.end() + 30]):
                kind = "change"
            elif PAYMENT_WORDS.search(sentence):
                kind = "payment"
            else:
                continue
            key = (when.isoformat(), kind)
            if key in seen:
                continue
            seen.add(key)
            # the amount is often named just before: "Die Nachzahlung beträgt 1.234,56 EUR. Bitte zahlen Sie bis …";
            # a fee ("Mahngebühr von 10,00 EUR") only when no other amount is there
            candidates = [(sentence, a) for a in _amount_candidates(sentence, m.start())]
            for back in (1, 2):  # "beträgt 687,12 EUR. Grund ist … Der Betrag wird am 01.01.2027 eingezogen."
                if index >= back:
                    prev = sentences[index - back]
                    candidates += [(prev, a) for a in reversed(list(AMOUNT.finditer(prev)))]
            if not candidates and index + 1 < len(sentences) and len(sentences[index + 1]) < SHORT_LINE:
                candidates = [(sentences[index + 1], a) for a in AMOUNT.finditer(sentences[index + 1])]
            chosen = _choose_amount(candidates)
            # "Due by: 12 December 2026" on a line of its own, far from the amounts: a sentence about paying with no
            # amount of its own is about the letter's total ("Total due £63.40"), when the letter names one
            if chosen is None and kind in ("deadline", "payment") and not notice and PAY_DUE.search(sentence):
                if total is False:
                    total = letter_total(text)
                chosen = total
            amount = _amount_text(chosen) if chosen else None
            if kind == "appointment" or notice:
                amount = None
            elif kind == "change":
                # "ab dem 01.02.2027 beträgt der Beitrag 6,90 EUR": the new amount follows the date
                after = [a for a in AMOUNT.finditer(sentence) if a.start() > m.end() and not is_rate(sentence, a)]
                amount = _amount_text(after[0]) if after else None
            found.append(FoundDate(date=when.isoformat(), kind=kind, text=_window(sentence, m.start(), m.end()),
                                   amount=amount, time=time_of_day if kind == "appointment" else None,
                                   line=_line_number(text or "", m.group(0), sentence)))
            if notice:
                found[-1].notice = notice
            readings = ambiguous_readings(m, order_known)
            if readings and notice:  # both readings of the contract end, each counted back
                readings = {k: minus_period(date.fromisoformat(v), notice["count"], notice["unit"]).isoformat()
                            for k, v in readings.items()}
            if readings:
                found[-1].ambiguous, found[-1].readings, found[-1].literal = True, readings, m.group(0)
    return found


def _choose_amount(candidates):
    """The amount a date is about, from (text, AMOUNT match) candidates, closest first: never a price per unit, a fee
    only when nothing else is there, and in the text of the closest amount a labelled total before the others
    ("Standing charge £18.40 … Total due £63.40, payable by …")."""
    usable = [(t, a) for t, a in candidates if not is_rate(t, a)]
    first = next(((t, a) for t, a in usable if not _is_fee(t, a)), None)
    if first is None:
        return usable[0][1] if usable else None
    total = next((a for t, a in usable if t == first[0] and not _is_fee(t, a) and is_total(t, a)), None)
    return total or first[1]


def _without_year(day: int, month: int, reference: date) -> Optional[date]:
    """15.12. in a letter written on 03.11.2026 is 15.12.2026; 10.01. is 10.01.2027."""
    for year in (reference.year, reference.year + 1):
        try:
            when = date(year, month, day)
        except ValueError:
            return None
        if when >= reference:
            return when
    return None


# "Diese korrigierte Abrechnung ersetzt die Abrechnung vom 20.10.2026", "replaces our letter of 20 October 2026",
# "remplace la facture du 20/10/2026", "sustituye a la factura del 20/10/2026", "sostituisce la fattura del 20/10/2026"
REPLACES = re.compile(rf"\b(?:{rule('replaces')})\b[^.]{{0,80}}?\b(?:{rule('replaces_of')})\s+", re.IGNORECASE)
LETTER_DATE_LINE = re.compile(rf"^\s*(?:{rule('letter_date_label')})\s*:?\s*(?P<rest>.+)$", re.IGNORECASE | re.MULTILINE)


def _first_date(text: str, order: str = "dmy") -> Optional[date]:
    hits = [(m.start(), _parse(m, order)) for p in DATE_PATTERNS for m in p.finditer(text)]
    hits = [h for h in hits if h[1]]
    return min(hits)[1] if hits else None


def letter_date_line(text: str) -> Optional[Tuple[str, str]]:
    """(the date the letter was written, ISO; the line it was read from): "Datum: 05.11.2026", "Date: 11/05/2026",
    or the place and date under the letterhead ("Rheinstadt, 03.11.2026", "Paris, le 3 novembre 2026")."""
    text = text or ""
    order = date_order(text)
    for m in LETTER_DATE_LINE.finditer(text):
        d = _first_date(m.group("rest"), order)
        if d:
            return d.isoformat(), m.group(0).strip()
    for m in PLACE_DATE.finditer(text):
        d = _first_date(m.group("rest"), order)
        if d:
            return d.isoformat(), m.group(0).strip()
    return None


def letter_date(text: str) -> Optional[str]:
    """The date the letter was written ("Datum: 05.11.2026"), ISO, or None."""
    found = letter_date_line(text)
    return found[0] if found else None


def replaced_letters(text: str) -> List[str]:
    """Dates of earlier letters this one says it replaces, ISO."""
    out = []
    order = date_order(text or "")
    for m in REPLACES.finditer(text or ""):
        d = _first_date(text[m.end():m.end() + 30], order)
        if d and d.isoformat() not in out:
            out.append(d.isoformat())
    return out


def choose_reading(item: dict, reading: Optional[str]) -> dict:
    """A date (as a dict: "date" or "value", "readings", ...) with the user's choice applied: the chosen reading becomes
    its date and it is no longer ambiguous. A date that is not ambiguous, or an unknown choice, is returned as it is."""
    if not item.get("ambiguous") or reading not in ("dmy", "mdy") or not (item.get("readings") or {}).get(reading):
        return item
    chosen = item["readings"][reading]
    out = {**item, "ambiguous": False, "chosen": reading}
    out["value" if "value" in item else "date"] = chosen
    return out


def sender(text: str) -> str:
    """The first line of the letter, normally the sender's name; used to match a letter with its correction."""
    for line in (text or "").splitlines():
        if line.strip():
            return re.sub(r"\s+", " ", line.strip().lower())
    return ""


def as_dicts(items: List[FoundDate]) -> List[dict]:
    return [asdict(i) for i in items]
