"""What the user has to pay or do, over all letters of a workspace, for the chat.

Six-language test of 2.3.0 (19 Nov 2026, N50/N51): "What do I have to pay by the end of the year?" over five one-page
letters got four retrieved passages. In Spanish and French the scam letter took a slot and a real bill (local tax
142 EUR, service charges 96,50 EUR) was missing from the answer; in Italian a deadline twelve days ahead was called
"already expired". Such a question is about every letter, so the engine lists every letter's deadlines and amounts
itself (read by rules: facts_service, dates_service), each with its status counted here ("in 12 days",
"overdue by 3 days"), and scam letters as "probable scam, do not pay". The passages follow as usual.
"""
import re
from datetime import date, timedelta
from typing import Dict, Iterable, List, Optional

# Questions about what to pay, what is due, deadlines and appointments, over all letters, in the six app languages.
# Same style as summaries.WHOLE_DOCUMENT: phrases, not single everyday words ("pay" alone is also "PayPal").
PAYMENT_QUESTION = re.compile(
    # English
    r"\bwhat (do|must|should|shall|will) i (still )?(have to |need to )?pay\b|\b(have|need) to pay\b|"
    r"\bhow much (do|must|will|should) i (still )?(have to |need to )?pay\b|\bwhat('s| is| are)? (still )?(due|owed|outstanding|open)\b|"
    r"\bdue dates?\b|\bdeadlines\b|\b(upcoming|next|open|outstanding|pending|unpaid) (payments?|bills?|invoices?|deadlines?|appointments?)\b|"
    r"\bbills? to pay\b|\b(my|any) appointments\b|\bpayments? (due|coming up)\b|"
    # German
    r"\bwas muss ich .{0,60}?(be|nach|ein)?zahlen\b|\bwas (ist|wird) (noch |bald )?(fällig|offen|zu zahlen)\b|"
    r"\b(zu )?(be)?zahlen (muss|habe) ich\b|\bwelche (fristen|termine|zahlungen|rechnungen|beträge|kosten)\b|"
    r"\b(anstehende|offene|fällige|nächsten?) (fristen|termine|zahlungen|rechnungen|beträge|posten)\b|"
    r"\bwie ?viel muss ich .{0,60}?(be|nach)?zahlen\b|\bfristen\b|\bzahlungsfristen\b|"
    # Spanish
    r"\bqu[ée] (tengo|debo|hay) que pagar\b|\bqu[ée] debo pagar\b|\b(tengo|debo) que pagar\b|\bcu[áa]nto (tengo que|debo) pagar\b|"
    r"\b(pagos|facturas|recibos) (pendientes|próximos)\b|\bpr[óo]ximos (pagos|plazos|vencimientos)\b|\bplazos\b|\bvencimientos\b|"
    r"\bfechas? l[íi]mite\b|\bqu[ée] (me )?vence\b|\bmis citas\b|"
    # French
    r"\bque (dois|devrais|vais)[- ]je payer\b|\bqu.est[- ]ce que je dois payer\b|\bdois[- ]je payer\b|\bje dois payer\b|"
    r"\bcombien (dois|vais)[- ]je payer\b|\b(factures?|paiements?|sommes?) (à payer|à venir|en attente|impayées?)\b|"
    r"\b[ée]ch[ée]ances\b|\bdates? limites?\b|\bmes rendez-vous\b|\bqu.est[- ]ce qui (est dû|arrive à échéance)\b|"
    # Italian
    r"\b(cosa|che cosa|che) devo (ancora )?pagare\b|\bdevo pagare\b|\bquanto devo pagare\b|\bda pagare\b|\bscadenze\b|"
    r"\b(pagamenti|bollette|fatture) (in scadenza|da pagare|in sospeso|prossim[ie])\b|\bcosa scade\b|\bi miei appuntamenti\b|"
    # Turkish
    r"\bne (ödemem|ödemeliyim|ödeyeceğim|ödemeliyiz)\b|\bödemem gereken\b|\bödenecek\b|\bödemeler(im)?\b|\bson ödeme\b|"
    r"\bne kadar (ödemem|ödeyeceğim|ödemeliyim)\b|\bvadesi (gelen|dolan|yaklaşan)\b|\bson tarihler\b|\brandevularım\b",
    re.IGNORECASE,
)


def is_payment_question(message: str) -> bool:
    """A question about what to pay, what is due, deadlines or appointments (en, de, es, fr, it, tr)."""
    return bool(PAYMENT_QUESTION.search(message or ""))


def relative_time(when: date, today: date) -> str:
    """How far a date is from today, computed here and never by the model: "today", "tomorrow", "in 27 days",
    "overdue by 3 days" (the same words as the inbox)."""
    days = (when - today).days
    if days == 0:
        return "today"
    if days == 1:
        return "tomorrow"
    return f"in {days} days" if days > 0 else f"overdue by {-days} days"


def status(when: date, today: date) -> str:
    """The status of a date for the model, in words it can copy: "in 12 days, still ahead", "overdue by 3 days, past"."""
    days = (when - today).days
    rel = relative_time(when, today)
    if days < 0:
        return f"{rel}, past"
    if days == 0:
        return "today, due today"
    return f"{rel}, still ahead, not overdue"


# Words of a question that never name a letter: question words, pronouns, verbs and time words of the six languages.
# What remains ("Stadtwerke", "insurance", "Finanzamt") names a letter when its sender or file name has it.
_STOP = set("""
what which when where have need must should will still much many pay paying payment payments paid bill bills due
until year years month months week weeks today tomorrow end next upcoming open outstanding owe deadline deadlines
appointment appointments letter letters there their this that these those does from with about
muss musst müssen habe haben ich bezahlen zahlen nachzahlen einzahlen zahlung zahlungen frist fristen termin termine
jahresende ende jahres monat monats woche wochen heute morgen noch bald welche welcher alles insgesamt bitte brief briefe
qué tengo debo tiene pagar pago pagos antes hasta final año años mes semana hoy mañana cuánto cuándo todo todos plazo
plazos vencimiento fecha fechas carta cartas factura facturas
dois doit devrais payer paiement paiements avant jusqu fin année années mois semaine aujourd demain combien quand tout
tous lettre lettres facture factures échéance échéances date dates limite
cosa devo deve pagare pagamento pagamenti entro fine anno anni mese settimana oggi domani quanto quando tutto tutti
scadenza scadenze lettera lettere bolletta bollette
sonuna kadar ödemem ödemeliyim gerekiyor ödeme ödemeler ödenecek yıl yılın ayın hafta bugün yarın kadar ne zaman tüm
hepsi mektup mektuplar fatura faturalar son tarih
""".split())


def _words(text: str) -> List[str]:
    return [w for w in re.findall(r"[^\W\d_]+", (text or "").lower()) if len(w) >= 4]


def named_letters(message: str, letters: Iterable[Dict]) -> List[str]:
    """The file names of the letters the question names by a word of their sender or file name ("Stadtwerke",
    "Finanzamt", "car insurance"). Question words, verbs and time words of the six languages never count, so
    "¿Qué tengo que pagar antes de fin de año?" names none."""
    asked = [w for w in _words(message) if w not in _STOP]
    if not asked:
        return []
    out = []
    for letter in letters:
        head = _words(re.sub(r"\.[a-z0-9]{2,5}$", "", letter.get("filename") or "", flags=re.I) + " "
                      + (letter.get("sender") or ""))
        if any(any(h == w or (len(w) >= 6 and h.startswith(w[:6])) or (len(h) >= 6 and w.startswith(h[:6]))
                   for h in head) for w in asked):
            out.append(letter["filename"])
    return out


def letter_rows(items: List[Dict], dates: List[Dict]) -> List[Dict]:
    """One row per letter of dashboard.document_dates: its file, sender, kind, scam flag and its dates (deadlines,
    payments, appointments), oldest first. Replaced letters, duplicates and documents that are no letters are left out."""
    by_doc = {}
    for d in dates:
        by_doc.setdefault((d.get("scope"), d.get("document_id")), []).append(d)
    rows = []
    for item in items:
        if item.get("replaced") or item.get("duplicate") or not item.get("is_letter"):
            continue
        own = by_doc.get((item.get("scope"), item.get("id")), [])
        rows.append({"filename": item["filename"], "scope": item.get("scope"), "document_id": item.get("id"),
                     "sender": item.get("sender"), "kind": item.get("letter_kind"),
                     "scam": bool(item.get("suspicious")), "asked_amount": item.get("asked_amount"),
                     "excerpt": item.get("excerpt"),
                     "page": item.get("first_page") or 1, "dates": sorted(own, key=lambda d: d.get("date") or "")})
    # letters with a date first (soonest first), then letters without one, scams last
    rows.sort(key=lambda r: (r["scam"], not r["dates"], (r["dates"][0].get("date") if r["dates"] else "") or "", r["filename"]))
    return rows


def _what(d: Dict) -> str:
    if d.get("notice"):
        return (f"last day to give notice ({d['notice']['count']} {d['notice']['unit']} before the contract end "
                f"{d['notice']['base']})")
    return d.get("kind") or "date"


def overview_block(today: date, rows: List[Dict], max_lines: int = 40) -> str:
    """The prompt block: every letter with its amounts and dates, each date with its status counted by the engine."""
    if not rows:
        return ""
    month_end = (today.replace(day=28) + timedelta(days=4)).replace(day=1) - timedelta(days=1)
    year_end = date(today.year, 12, 31)
    lines = []
    for r in rows:
        head = f"{r['filename']} | sender: {r.get('sender') or 'unknown'} | {(r.get('kind') or 'letter').replace('_', ' ')}"
        if r["scam"]:
            asked = f" It asks for {r['asked_amount']}." if r.get("asked_amount") else ""
            lines.append(f"- {head} | PROBABLE SCAM, DO NOT PAY.{asked} Never list it as a payment; name it only as a "
                         f"probable scam the user should not pay.")
            continue
        if not r["dates"]:
            lines.append(f"- {head} | no due date or amount to pay found")
            continue
        for d in r["dates"]:
            if d.get("ambiguous"):
                amount = f" | amount: {d['amount']}" if d.get("amount") else ""
                lines.append(f"- {head} | {_what(d)}{amount} | AMBIGUOUS date {d.get('literal')}: {d['readings']['dmy']} "
                             f"(day first) or {d['readings']['mdy']} (month first); the user has to check the letter, "
                             f"do not pick one")
                continue
            when = date.fromisoformat(d["date"])
            amount = f" | amount: {d['amount']}" if d.get("amount") else ""
            lines.append(f"- {head} | {_what(d)}{amount} | date: {when.isoformat()} ({when:%a}) | status: "
                         f"{status(when, today)} | letter says: \"{(d.get('text') or '')[:150]}\"")
    if len(lines) > max_lines:
        lines = lines[:max_lines] + [f"- ... and {len(lines) - max_lines} more"]
    return (
        "\n═══════════════════════════════════════\n"
        "ALL LETTERS OF THIS WORKSPACE: AMOUNTS AND DATES (read by StarkLLM's rules from every letter, not only from "
        "the passages below; letters replaced by a correction are left out)\n"
        "═══════════════════════════════════════\n"
        f"Today: {today:%A} {today.isoformat()}. End of this month: {month_end.isoformat()} "
        f"({relative_time(month_end, today)}). End of this year: {year_end.isoformat()} ({relative_time(year_end, today)}).\n"
        + "\n".join(lines)
        + "\nThis question is about all letters: answer from this list and go through every letter in it, naming its "
          "file. Use the passages below only for details. Take each status (\"in 12 days, still ahead\", \"overdue by "
          "3 days, past\") exactly as written: it was counted by StarkLLM from today's date; never compare dates or "
          "count days yourself. A date \"still ahead\" is not expired or overdue. Only list items that fit the "
          "question's time span (a date up to the end of the year fits \"by the end of the year\"). A cancellation or "
          "notice deadline is not a payment: say what the letter asks. A letter marked PROBABLE SCAM is never a "
          "payment: tell the user not to pay it.\n"
    )
