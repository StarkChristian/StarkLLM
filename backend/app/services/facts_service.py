"""Facts of a letter: what kind of document it is, who sent it, when, its reference numbers, amounts, bank accounts
and dates (docs/document-inbox-design.md, B3).

Found by fixed rules for German and English letters, never by the language model, so every value is text that stands
on a page of the document; each fact carries that page and the line it was read from, and the UI links to it. The
facts feed the inbox (suggested title, case) and can be handed to the model, which then does not have to find them.
"""
import hashlib
import re
from typing import Dict, List, Optional

from app.services.dates_service import AMOUNT, DATE_PATTERNS, _amount_text, _is_fee, _parse, find_dates, letter_date
from app.services.document_checks import findings, ibans

# Kinds of documents, most specific first: a "Mahnung" from an "Inkassobüro" is debt collection, a
# "Kündigungsbestätigung" is a confirmation and not a contract, a "Beitragsrechnung" of an insurer is an invoice.
# Each kind: words in the heading (first lines) count first, then anywhere in the letter.
TYPES = [
    ("debt_collection", r"inkasso\w*|forderungsmanagement|debt collect\w*|collection agency"),
    ("reminder", r"mahnung|zahlungserinnerung|letzte erinnerung|pfändungsankündigung|payment reminder|final notice|overdue notice"),
    ("fine", r"bußgeldbescheid|bussgeldbescheid|verwarnungsgeld|anhörung im bußgeldverfahren|penalty notice|parking fine"),
    ("tax_notice", r"steuerbescheid|bescheid für \d{4} über|einkommensteuer\w*bescheid|tax assessment"),
    ("payslip", r"gehaltsabrechnung|entgeltabrechnung|lohnabrechnung|verdienstabrechnung|payslip|pay slip|salary statement"),
    ("termination", r"kündigungsbestätigung|bestätigung (ihrer|der) kündigung|kündigung|cancellation confirm\w*|notice of termination"),
    ("statement", r"nebenkostenabrechnung|betriebskostenabrechnung|jahresabrechnung|kontoauszug|abrechnung|account statement|statement of account"),
    ("invoice", r"\w*(?<!be)rechnung|invoice|bill\b"),
    ("job_offer", r"offer of employment|job offer|offer letter|pleased to offer you|arbeitsangebot|stellenangebot"),
    ("contract", r"\w*mietvertrag|\w*arbeitsvertrag|vertrag\b|employment contract|tenancy agreement|agreement|terms and conditions"),
    ("invitation", r"einladung|vorladung|invitation|appointment\b"),
    ("medical", r"arztbrief|befundbericht|befund|diagnose|entlassungsbericht|medical report|diagnosis"),
    ("price_change", r"beitragsanpassung|preisanpassung|preisänderung|zusatzbeitrag|entgeltänderung|"
                     r"änderung (der|unserer|ihrer) (entgelte|preise|beiträge|bedingungen|konditionen)|"
                     r"(beitrag|preis|entgelt)\w* ändert sich|neue bankverbindung|price change|change (of|in) (fees|prices)"),
    ("payment_notice", r"ankündigung der lastschrift|lastschriftankündigung|vorabankündigung|payment notice|direct debit notice"),
    ("notice", r"bescheid\b|verwaltungsakt|official notice"),
    ("insurance", r"versicherung\w*|versicherungsschein|police\b|insurance|policy"),
    ("prize", r"gewinnbenachrichtigung|gewinner|gewonnen|you have won|prize"),
]
_TYPE_RES = [(k, re.compile(r"\b(" + p + r")", re.IGNORECASE)) for k, p in TYPES]
# a screenshot of a text message: "Nachricht von +44 7700 900123 heute 09:14", then "PaketExpress: Ihr Paket …"
MESSAGE = re.compile(r"^\s*(nachricht von|sms von|imessage von|message from|text message from)\b\s*(?P<from>.*)$", re.IGNORECASE)
# "zwischen Dieter Brand, vertreten durch …": the other party of a contract
BETWEEN = re.compile(r"^\s*(zwischen|between)\s+(?P<name>[^,(\n]+?)(\s*,|\s*\(|\s+(vertreten|represented|und|and)\b|$)", re.IGNORECASE)

# "Kundennummer: 4400-118-27", "Rechnung Nr. 2026-4471", "Az.: 3 C 112/26", "Policy number: AB-1234"
REFERENCE_LABELS = [
    ("customer_number", r"kunden[- ]?(nummer|nr\.?)|kd\.?[- ]?nr\.?|customer (number|no\.?|id)"),
    ("invoice_number", r"rechnungs[- ]?(nummer|nr\.?)|rechnung nr\.?|invoice (number|no\.?)"),
    ("contract_number", r"vertrags[- ]?(nummer|nr\.?)|vertrag nr\.?|contract (number|no\.?)"),
    ("policy_number", r"versicherungs[- ]?(schein[- ]?)?(nummer|nr\.?)|policen?[- ]?(nummer|nr\.?)|policy (number|no\.?)"),
    ("tax_number", r"steuer[- ]?(nummer|nr\.?)|steuer-id|steuerliche identifikationsnummer|tax (id|number)"),
    ("file_number", r"aktenzeichen|az\.|geschäftszeichen|unser zeichen|kassenzeichen|file (number|no\.?)|our ref(erence)?\.?"),
    ("member_number", r"mitglieds[- ]?(nummer|nr\.?)|versichertennummer|member(ship)? (number|no\.?)"),
    ("employee_number", r"personal[- ]?(nummer|nr\.?)|employee (number|no\.?|id)"),
    ("mandate_reference", r"mandatsreferenz|mandate reference"),
    ("reference", r"referenz(nummer)?|reference( number)?|vorgangs[- ]?(nummer|nr\.?)|bestell[- ]?(nummer|nr\.?)|order (number|no\.?)"),
]
_REF_VALUE = r"\s*[:#.]?\s*(?P<v>[A-Z0-9][A-Z0-9/\-.]*(?:[ ][A-Z0-9][A-Z0-9/\-.]*){0,3})"
_REF_RES = [(k, re.compile(r"(?<![\wÄÖÜäöüß])(?P<label>" + p + r")" + _REF_VALUE, re.IGNORECASE)) for k, p in REFERENCE_LABELS]

# "Rheinstadt, 03.11.2026", "Rheinstadt, den 3. November 2026": the date of the letter next to the place
PLACE_DATE = re.compile(r"^\s*[A-ZÄÖÜ][\wÄÖÜäöüß .\-]{1,40},\s*(den\s+)?(?P<rest>\d.{5,25})$", re.MULTILINE)


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
    lines = [l for l in lines if len(l) >= 3 and re.search(r"[A-Za-zÄÖÜäöüß]{2,}|\+\d", l)
             and not re.fullmatch(r"[\d\s:.,/\-]+(uhr|am|pm)?", l, re.IGNORECASE)]
    if not lines:
        return None
    msg = MESSAGE.match(lines[0])
    if msg:
        named = re.match(r"^([\wÄÖÜäöüß .&-]{2,30}):\s", lines[1]) if len(lines) > 1 else None
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
_NOT_A_NAME = re.compile(r"^\s*([#<{\[|>*=\"']|sheet\s*:|tabelle\s*:|columns\s*:|spalten\s*:|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|"
                         r"(the|this|a|an) (image|photo|picture|screenshot)\b|(das|dieses|ein) (bild|foto)\b|auf dem (bild|foto)\b)",
                         re.IGNORECASE)


def _not_a_name(line: str) -> bool:
    """A first line that cannot be a sender: markup, a log line, a photo description or a whole sentence."""
    words = line.split()
    return bool(_NOT_A_NAME.match(line)) or len(words) > 8 or (len(words) >= 5 and line.rstrip().endswith("."))


def written_on(pages: Dict[int, str]) -> Optional[Dict]:
    """The date the letter was written: "Datum: 03.11.2026" or "Rheinstadt, 03.11.2026"."""
    for page in sorted(pages):
        text = pages[page] or ""
        iso = letter_date(text)
        if iso:
            m = re.search(r"^\s*(datum|date)\s*:?.*$", text, re.IGNORECASE | re.MULTILINE)
            return _fact(iso, page, (m.group(0).strip() if m else iso)[:200])
        for m in PLACE_DATE.finditer(text):
            for p in DATE_PATTERNS:
                d = p.search(m.group("rest"))
                if d and _parse(d):
                    return _fact(_parse(d).isoformat(), page, m.group(0).strip()[:200])
    return None


def references(pages: Dict[int, str]) -> List[Dict]:
    """Customer, invoice, contract, policy, tax and file numbers. A value needs a digit; IBANs are listed apart."""
    out, seen = [], set()
    for page in sorted(pages):
        text = pages[page] or ""
        for kind, rx in _REF_RES:
            for m in rx.finditer(text):
                value = m.group("v").strip(" .-/")
                # "Kundennummer 4400-118-27 Datum" -> stop at a word without digits
                parts = value.split(" ")
                while len(parts) > 1 and not re.search(r"\d", parts[-1]):
                    parts.pop()
                value = " ".join(parts)
                if not re.search(r"\d", value) or len(value) < 3 or ibans(value):
                    continue
                key = (kind, value.replace(" ", ""))
                if key in seen:
                    continue
                seen.add(key)
                out.append(_fact(value, page, _line_of(text, m.start(), m.end()), kind=kind, label=m.group("label")))
    return out


def amounts(pages: Dict[int, str], limit: int = 12) -> List[Dict]:
    """Amounts of money with their line. role "fee" for fees and "old" for an amount that was replaced
    ("statt bisher 4,90 EUR"), so they are not taken for what is due."""
    out, seen = [], set()
    for page in sorted(pages):
        text = pages[page] or ""
        for m in AMOUNT.finditer(text):
            value = _amount_text(m)
            line = _line_of(text, m.start(), m.end())
            if (value, line) in seen:
                continue
            seen.add((value, line))
            before = text[max(0, m.start() - 30):m.start()].lower()
            role = "old" if re.search(r"(bisher|statt|vorher|previously|instead of)\W{0,3}$", before) else (
                "fee" if _is_fee(text, m) else None)
            out.append(_fact(value, page, line, role=role))
            if len(out) >= limit:
                return out
    return out


def accounts(pages: Dict[int, str]) -> List[Dict]:
    out, seen = [], set()
    for page in sorted(pages):
        text = pages[page] or ""
        for iban in ibans(text):
            if iban in seen:
                continue
            seen.add(iban)
            spaced = " ".join(iban[i:i + 4] for i in range(0, len(iban), 4))
            at = text.find(iban[:4])
            out.append(_fact(spaced, page, _line_of(text, at, at + 4) if at >= 0 else spaced))
    return out


def dates(pages: Dict[int, str]) -> List[Dict]:
    out = []
    full = "\n".join(pages[p] for p in sorted(pages))
    written = letter_date(full)
    from datetime import date
    reference = date.fromisoformat(written) if written else None
    for page in sorted(pages):
        for f in find_dates(pages[page] or "", reference):
            out.append(_fact(f.date, page, f.text, kind=f.kind, amount=f.amount, time=f.time))
    return out


def _norm(value: str) -> str:
    return re.sub(r"[^0-9a-zäöüß]", "", (value or "").lower())


_STOP = {"für", "fuer", "der", "die", "das", "des", "und", "von", "vom", "the", "of", "and", "for", "&", "-"}


def case_key(facts: Dict) -> Optional[str]:
    """What groups letters into one case: the sender, so every letter of "Finanzamt Rheinstadt" is together.
    The two first words are used ("Finanzamt Rheinstadt - Vollstreckungsstelle" and "Finanzamt Rheinstadt" match)."""
    s = facts.get("sender")
    if not s:
        return None
    words = [w for w in re.findall(r"[\wÄÖÜäöüß+]+", s["value"].lower()) if w not in _STOP]
    return " ".join(words[:2]) or None


def document_facts(pages: Dict[int, str]) -> Dict:
    """All facts of one document; pages is {page number (1-based): text}."""
    pages = {p: t for p, t in (pages or {}).items() if (t or "").strip()}
    full = "\n".join(pages[p] for p in sorted(pages))
    facts = {
        "type": doc_type(pages),
        "sender": sender(pages),
        "date": written_on(pages),
        "references": references(pages),
        "amounts": amounts(pages),
        "accounts": accounts(pages),
        "dates": dates(pages),
        "warnings": sorted({f["kind"] for f in findings([{"file": "-", "text": full}])
                            if f["kind"] in ("scam_signs", "ai_instructions")}),
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


def document_facts_cached(pages: Dict[int, str]) -> Dict:
    key = hashlib.sha1(repr(sorted((pages or {}).items())).encode("utf-8", "ignore")).hexdigest()
    if key not in _CACHE:
        if len(_CACHE) > 5000:
            _CACHE.clear()
        _CACHE[key] = document_facts(pages)
    return _CACHE[key]
