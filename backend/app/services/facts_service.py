"""Facts of a letter: what kind of document it is, who sent it, when, its reference numbers, amounts, bank accounts
and dates (docs/document-inbox-design.md, B3).

Found by fixed rules for English, German, French, Spanish, Italian and Turkish letters (locale_rules.py), never by the language model, so every value is text that stands
on a page of the document; each fact carries that page and the line it was read from, and the UI links to it. The
facts feed the inbox (suggested title, case) and can be handed to the model, which then does not have to find them.
"""
import hashlib
import re
from typing import Dict, List, Optional

from app.services.dates_service import (
    AMOUNT, OLD_BEFORE, PLACE_DATE, amount_parts, _amount_text, _is_fee, date_order_evidence, find_dates, is_log_line,
    letter_date, letter_date_line,
)
from app.services.document_checks import bank_accounts, findings, ibans
from app.services import locale_rules

# Kinds of documents, most specific first: a "Mahnung" from an "Inkassobüro" is debt collection, a
# "Kündigungsbestätigung" is a confirmation and not a contract, a "Beitragsrechnung" of an insurer is an invoice.
# Each kind: words in the heading (first lines) count first, then anywhere in the letter. The words of every
# language are in locale_rules.TYPES.
TYPES = locale_rules.type_patterns()
_TYPE_RES = [(k, re.compile(r"\b(" + p + r")", re.IGNORECASE)) for k, p in TYPES]
# a screenshot of a text message: "Nachricht von +44 7700 900123 heute 09:14", then "PaketExpress: Ihr Paket …"
MESSAGE = re.compile(rf"^\s*({locale_rules.MESSAGE_WORDS})\b\s*(?P<from>.*)$", re.IGNORECASE)
# "zwischen Dieter Brand, vertreten durch …": the other party of a contract
BETWEEN = re.compile(rf"^\s*({locale_rules.BETWEEN_WORDS})\s+(?P<name>[^,(\n]+?)(\s*,|\s*\(|\s+({locale_rules.BETWEEN_AND})\b|$)",
                     re.IGNORECASE)

# "Kundennummer: 4400-118-27", "Rechnung Nr. 2026-4471", "Az.: 3 C 112/26", "Policy number: AB-1234"
REFERENCE_LABELS = locale_rules.REFERENCE_LABELS
_REF_VALUE = r"\s*[:#.]?\s*(?P<v>[A-Z0-9][A-Z0-9/\-.]*(?:[ ][A-Z0-9][A-Z0-9/\-.]*){0,3})"
# the label must end where a word ends: "refund 12" is not a reference
_REF_RES = [(k, re.compile(r"(?<![\wÄÖÜäöüß])(?P<label>" + p + r")(?![^\W\d_])" + _REF_VALUE, re.IGNORECASE)) for k, p in REFERENCE_LABELS]


def _line_of(text: str, start: int, end: int) -> str:
    left = text.rfind("\n", 0, start) + 1
    right = text.find("\n", end)
    return re.sub(r"\s+", " ", text[left:right if right >= 0 else len(text)]).strip()[:200]


def _first_lines(text: str, n: int = 12) -> str:
    return "\n".join([l for l in (text or "").splitlines() if l.strip()][:n])


def _fact(value, page: int, line: str, **extra) -> Dict:
    return {"value": value, "page": page, "text": line, **extra}


def _lines(pages: Dict[int, str], n: int = 14) -> List[str]:
    return [l.strip() for l in (pages[min(pages)] or "").splitlines() if l.strip()][:n]


def _type_in(line: str):
    """The type named earliest in a line ("Beitragsrechnung für das Versicherungsjahr": invoice, not insurance)."""
    hits = [(m.start(), i, kind, m) for i, (kind, rx) in enumerate(_TYPE_RES) for m in [rx.search(line)] if m]
    return min(hits, key=lambda h: (h[0], h[1])) if hits else None


def _is_title(line: str) -> bool:
    """A first line that is the document's title ("Wohnraummietvertrag"), not a sender."""
    return len(line.split()) <= 3 and bool(_type_in(line)) and not re.search(r"\b(gmbh|ag|eg|e\.v\.|ltd|inc|bank)\b", line, re.I)


def doc_type(pages: Dict[int, str]) -> Optional[Dict]:
    """The kind of document. Line 1 is normally the sender ("Kurpfalz Direkt Versicherung AG" says nothing about the
    letter), so the subject is looked for below it, the earliest line first ("Beitragsrechnung für das
    Versicherungsjahr 2027" before a later "Kündigung: …"). Then the first line, then the whole letter."""
    if not pages:
        return None
    first_page = min(pages)
    lines = _lines(pages)
    if not lines:
        return None
    if MESSAGE.match(lines[0]):
        return _fact("message", first_page, lines[0], word=MESSAGE.match(lines[0]).group(1))
    top = _type_in(lines[0])
    if top and (top[2] == "debt_collection" or _is_title(lines[0])):  # "Inkassobüro …", "Wohnraummietvertrag"
        return _fact(top[2], first_page, lines[0], word=top[3].group(1))
    for line in lines[1:]:
        hit = _type_in(line)
        if hit:
            return _fact(hit[2], first_page, line[:200], word=hit[3].group(1))
    if top:
        return _fact(top[2], first_page, lines[0], word=top[3].group(1))
    for page in sorted(pages):
        for kind, rx in _TYPE_RES:
            m = rx.search(pages[page])
            if m:
                return _fact(kind, page, _line_of(pages[page], m.start(), m.end()), word=m.group(1))
    return None


def sender(pages: Dict[int, str]) -> Optional[Dict]:
    """Who the letter is from. In a business letter the sender's name is on top (letterhead). A contract starts with
    its title and names the other party after "zwischen"; a screenshot of a text message names the sender in front
    of the text ("PaketExpress: …") or only a phone number. Lines that are only a time, date or number are skipped."""
    if not pages:
        return None
    first_page = min(pages)
    lines = [re.sub(r"\s+", " ", l) for l in _lines(pages, 20)]
    lines = [l for l in lines if len(l) >= 3 and re.search(r"[^\W\d_]{2,}|\+\d", l)
             and not re.fullmatch(r"[\d\s:.,/\-]+(uhr|am|pm)?", l, re.IGNORECASE)]
    if not lines:
        return None
    msg = MESSAGE.match(lines[0])
    if msg:
        named = re.match(r"^([\w .&-]{2,30}):\s", lines[1]) if len(lines) > 1 else None
        if named:
            return _fact(named.group(1).strip(), first_page, lines[1][:200])
        number = re.search(r"\+?[\d][\d ()/-]{5,}\d", msg.group("from"))
        return _fact((number.group(0) if number else msg.group("from"))[:80].strip(), first_page, lines[0][:200])
    if _is_title(lines[0]):
        for line in lines[1:4]:
            m = BETWEEN.match(line)
            if m:
                return _fact(m.group("name").strip()[:80], first_page, line[:200])
        return None
    if _not_a_name(lines[0]):
        return None
    name = re.split(r"\s+[-–|·]\s+", lines[0])[0].strip()  # "Finanzamt Rheinstadt - Vollstreckungsstelle"
    return _fact(name[:80], first_page, lines[0][:200])


# First lines of files that are not letters (seen on a real PC, 12 Nov 2026): "# Project card" (Markdown),
# "<catalog><product id=…" (XML), "Sheet: Inventory" (a spreadsheet as text), "2026-11-07 02:00:01 INFO backup
# started" (a log), "Columns: supplier,city,…" (a CSV file), '"service": "billing-api",' (JSON), "The image shows a
# photograph of …" (the description of a photo), or a sentence.
_NOT_A_NAME = re.compile(r"^\s*([#<{\[|>*=\"']|(sheet|tabelle|feuille|hoja|foglio|sayfa)\s*:|(columns|spalten|colonnes|columnas|colonne|sütunlar)\s*:|"
                         r"\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|"
                         r"(the|this|a|an) (image|photo|picture|screenshot)\b|(das|dieses|ein) (bild|foto)\b|auf dem (bild|foto)\b|"
                         r"(l['’]image|cette image|la photo|une photo|la imagen|esta imagen|una foto|una imagen|l['’]immagine|"
                         r"questa immagine|una foto|bu (resim|görsel|fotoğraf))\b)",
                         re.IGNORECASE)


def _not_a_name(line: str) -> bool:
    """A first line that cannot be a sender: markup, a log line, a photo description or a whole sentence."""
    words = line.split()
    return bool(_NOT_A_NAME.match(line)) or len(words) > 8 or (len(words) >= 5 and line.rstrip().endswith("."))


def written_on(pages: Dict[int, str]) -> Optional[Dict]:
    """The date the letter was written: "Datum: 03.11.2026", "Date: 11/03/2026" or "Rheinstadt, 03.11.2026"."""
    for page in sorted(pages):
        found = letter_date_line(pages[page] or "")
        if found:
            return _fact(found[0], page, found[1][:200])
    return None


def references(pages: Dict[int, str]) -> List[Dict]:
    """Customer, invoice, contract, policy, tax and file numbers. A value needs a digit; IBANs are listed apart."""
    out, seen = [], set()
    for page in sorted(pages):
        text = pages[page] or ""
        banks = {a["key"] for a in bank_accounts(text)}  # "Account number: 123456789" next to a routing number is a bank account
        for kind, rx in _REF_RES:
            for m in rx.finditer(text):
                value = m.group("v").strip(" .,;:)(-/")
                # "Kundennummer 4400-118-27 Datum" -> stop at a word without digits
                parts = value.split(" ")
                while len(parts) > 1 and not re.search(r"\d", parts[-1]):
                    parts.pop()
                value = " ".join(parts)
                if not re.search(r"\d", value) or len(value) < 3 or ibans(value) or re.sub(r"\D", "", value) in banks:
                    continue
                key = re.sub(r"\W", "", value).upper()  # the same number under two labels is listed once, the more specific label first
                if key in seen:
                    continue
                seen.add(key)
                out.append(_fact(value, page, _line_of(text, m.start(), m.end()), kind=kind, label=m.group("label")))
    return out


def amounts(pages: Dict[int, str], limit: int = 12) -> List[Dict]:
    """Amounts of money with their line. value is as the document writes it plus the currency code ("1.234,56 EUR",
    "$1,234.56" -> "1,234.56 USD"); number is the same value as "1234.56". role "fee" for fees and "old" for an amount
    that was replaced ("statt bisher 4,90 EUR"), so they are not taken for what is due."""
    out, seen = [], set()
    for page in sorted(pages):
        text = pages[page] or ""
        for m in AMOUNT.finditer(text):
            value = _amount_text(m)
            line = _line_of(text, m.start(), m.end())
            if (value, line) in seen:
                continue
            seen.add((value, line))
            before = text[max(0, m.start() - 30):m.start()]
            role = "old" if OLD_BEFORE.search(before) else ("fee" if _is_fee(text, m) else None)
            _, number, currency = amount_parts(m)
            out.append(_fact(value, page, line, role=role, number=number, currency=currency))
            if len(out) >= limit:
                return out
    return out


def accounts(pages: Dict[int, str]) -> List[Dict]:
    """Bank accounts: IBAN, and where the letter names them US routing and account numbers, UK sort codes and
    account numbers, Australian BSB, and BIC/SWIFT. kind says which."""
    out, seen = [], set()
    for page in sorted(pages):
        text = pages[page] or ""
        for acc in bank_accounts(text):
            if (acc["kind"], acc["key"]) in seen:
                continue
            seen.add((acc["kind"], acc["key"]))
            out.append(_fact(acc["value"], page, _line_of(text, acc["start"], acc["end"]), kind=acc["kind"]))
    return out


def dates(pages: Dict[int, str]) -> List[Dict]:
    out = []
    full = "\n".join(pages[p] for p in sorted(pages))
    written = letter_date(full)
    from datetime import date
    reference = date.fromisoformat(written) if written else None
    hint = date_order_evidence(full)  # a date on another page can show how slash dates are written
    for page in sorted(pages):
        for f in find_dates(pages[page] or "", reference, hint):
            out.append(_fact(f.date, page, f.text, kind=f.kind, amount=f.amount, time=f.time,
                             **({"ambiguous": True, "readings": f.readings, "literal": f.literal} if f.ambiguous else {}),
                             **({"notice": f.notice} if f.notice else {})))
    return out


def _norm(value: str) -> str:
    """Letters and digits only, without accents, so a photo and a PDF of the same letter match."""
    return re.sub(r"[^0-9a-z]", "", locale_rules.strip_accents(value or ""))


_STOP = {"für", "fuer", "der", "die", "das", "des", "und", "von", "vom", "the", "of", "and", "for", "&", "-",
         "le", "la", "les", "du", "de", "des", "et", "el", "los", "las", "del", "y", "il", "lo", "gli", "di", "della", "e", "ve"}


def case_key(facts: Dict) -> Optional[str]:
    """What groups letters into one case: the sender, so every letter of "Finanzamt Rheinstadt" is together.
    The two first words are used ("Finanzamt Rheinstadt - Vollstreckungsstelle" and "Finanzamt Rheinstadt" match)."""
    s = facts.get("sender")
    if not s:
        return None
    words = [w for w in re.findall(r"[\w+]+", s["value"].lower()) if w not in _STOP]
    return " ".join(words[:2]) or None


# Files that are data, notes or program code, never letters, whatever dates they contain (MSI test, 15 Nov 2026:
# an app.log counted as a new letter and its timestamp showed as an expired deadline).
NOT_LETTER_EXTENSIONS = frozenset({
    ".log", ".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".env", ".properties", ".md", ".markdown", ".rst", ".sql", ".py", ".js", ".mjs", ".ts", ".jsx", ".tsx", ".java",
    ".c", ".h", ".cpp", ".hpp", ".cs", ".go", ".rs", ".rb", ".php", ".sh", ".bat", ".ps1", ".css", ".scss", ".kt",
    ".swift", ".lua", ".r",
})
_STRUCTURE_START = re.compile(r"^\s*(\{|\[\s*[\[{\"]|<\?xml|<!doctype|<[A-Za-z][\w:.-]*[\s/>])", re.IGNORECASE)


# "The image shows a photograph of a meeting room sign ...": what the vision model wrote about a photo
_PHOTO_DESCRIPTION = re.compile(r"^\s*(the|this|a|an) (image|photo|picture|screenshot)\s+(shows|depicts|contains|is)\b|"
                                r"^\s*(das|dieses|ein) (bild|foto)\s+(zeigt|enthält|ist)\b", re.IGNORECASE)


def machine_file_name(filename: Optional[str]) -> bool:
    """True for a file type that is data, a note format or program code: .log, .csv, .json, .xml, .yaml, .md, …"""
    name = (filename or "").strip().lower()
    return "." in name and "." + name.rsplit(".", 1)[1] in NOT_LETTER_EXTENSIONS


def machine_text(full: str) -> bool:
    """True when the text is a log (half of its lines start with a bare timestamp or a log level), JSON/XML structure
    or the description of a photo, whatever the file is called. A letter has none of these."""
    lines = [l for l in (full or "").splitlines() if l.strip()]
    if not lines:
        return False
    if _PHOTO_DESCRIPTION.match(lines[0]):
        return True
    if _STRUCTURE_START.match(lines[0]) and (len(lines) > 1 or lines[0].rstrip().endswith(("}", "]", ">"))):
        return True
    return len(lines) >= 2 and sum(1 for l in lines if is_log_line(l)) * 2 >= len(lines)


def is_machine_document(pages: Dict[int, str], filename: Optional[str] = None) -> bool:
    """A log, table, JSON, XML, YAML, Markdown note, photo description or program code: never a letter, and its dates are not deadlines."""
    return machine_file_name(filename) or machine_text("\n".join((pages or {})[p] or "" for p in sorted(pages or {})))


def document_facts(pages: Dict[int, str], filename: Optional[str] = None) -> Dict:
    """All facts of one document; pages is {page number (1-based): text}. The file name is used to recognise files
    that are never letters (a log, a table, JSON, Markdown, program code)."""
    pages = {p: t for p, t in (pages or {}).items() if (t or "").strip()}
    full = "\n".join(pages[p] for p in sorted(pages))
    machine = machine_file_name(filename) or machine_text(full)
    facts = {
        "type": None if machine else doc_type(pages),
        "sender": None if machine else sender(pages),
        "date": None if machine else written_on(pages),
        "references": [] if machine else references(pages),
        "amounts": [] if machine else amounts(pages),
        "accounts": [] if machine else accounts(pages),
        "dates": [] if machine else dates(pages),
        "warnings": sorted({f["kind"] for f in findings([{"file": "-", "text": full}])
                            if f["kind"] in ("scam_signs", "ai_instructions", "hidden_text")}),
        # the same letter as a photo and as a PDF has the same text after OCR noise is removed
        "fingerprint": hashlib.sha1(_norm(full)[:4000].encode()).hexdigest() if full else None,
    }
    # Only letters get a sender, a case and a place among the new letters of the inbox. A note, a manual, a
    # spreadsheet or a photo has none of these, and its first line is not a sender.
    facts["letter"] = bool(facts["type"] or facts["references"] or facts["date"] or facts["dates"] or facts["accounts"]
                           or facts["warnings"])
    if not facts["letter"]:
        facts["sender"] = None
    facts["case"] = case_key(facts)
    return facts


_CACHE: Dict[str, Dict] = {}


def document_facts_cached(pages: Dict[int, str], filename: Optional[str] = None) -> Dict:
    key = hashlib.sha1(repr((sorted((pages or {}).items()), filename)).encode("utf-8", "ignore")).hexdigest()
    if key not in _CACHE:
        if len(_CACHE) > 5000:
            _CACHE.clear()
        _CACHE[key] = document_facts(pages, filename)
    return _CACHE[key]
