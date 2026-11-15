"""Deadlines across the inbox (docs/document-inbox-design.md, B5): the list, the reminders and the calendar file.

Every deadline comes from the facts of a letter (facts_service: found by fixed rules in the document text, with page and
line). Nothing here reads a model's output or invents a date. The functions are pure: the API (api/dashboard.py) hands
in the inbox and the stored reminders.
"""
import hashlib
from datetime import date, timedelta
from typing import Dict, Iterable, List, Optional

DEADLINE_KINDS = ("deadline", "payment", "appointment")
SOON_DAYS = 7                      # "soon" in the list: due within a week
MAX_REMINDER_DAYS = 60             # a reminder can be set up to 60 days before
MAX_REMINDERS = 6                  # offsets per deadline
DEFAULT_ALARM_DAYS = 3             # calendar alarm when the user set no reminder for the deadline
ALARM_HOUR = 9                     # an all-day event's alarm rings at 09:00, not at midnight

LABELS = {
    "en": {"deadline": "Deadline", "payment": "Payment", "appointment": "Appointment", "date": "Date",
           "source": "Source: {file}, page {page}", "line": ", line {line}"},
    "de": {"deadline": "Frist", "payment": "Zahlung", "appointment": "Termin", "date": "Termin",
           "source": "Quelle: {file}, Seite {page}", "line": ", Zeile {line}"},
}


# ---------------------------------------------------------------- identity of a deadline

def deadline_key(scope: str, document_id: int, due: str, kind: str) -> str:
    """"ws:12:2026-12-15:deadline": the document and the date and kind in it. The same text always gives the same key,
    so a reminder survives re-indexing."""
    return f"{scope}:{document_id}:{due}:{kind}"


def parse_key(key: str) -> Optional[Dict]:
    """The parts of a key, or None when it is not one (a bad scope, a document that is not a number, no such day)."""
    parts = (key or "").split(":")
    if len(parts) != 4:
        return None
    scope, doc, due, kind = parts
    try:
        date.fromisoformat(due)
        document_id = int(doc)
    except ValueError:
        return None
    if scope not in ("ws", "kb") or kind not in DEADLINE_KINDS:
        return None
    return {"scope": scope, "document_id": document_id, "due": due, "kind": kind}


def clean_offsets(days: Iterable) -> Optional[List[int]]:
    """Reminder offsets (days before the due date), sorted from the earliest reminder to the latest, or None when
    something is not a whole number between 0 and MAX_REMINDER_DAYS or there are too many."""
    out = set()
    for d in days or []:
        if isinstance(d, bool) or not isinstance(d, int) or not 0 <= d <= MAX_REMINDER_DAYS:
            return None
        out.add(d)
    if len(out) > MAX_REMINDERS:
        return None
    return sorted(out, reverse=True)


# ---------------------------------------------------------------- the list

def _state(days: int) -> str:
    if days < 0:
        return "overdue"
    if days == 0:
        return "today"
    return "soon" if days <= SOON_DAYS else "upcoming"


NOT_LETTER_TYPES = ("log", "csv", "tsv", "json", "jsonl", "xml")  # timestamps in these are data, never deadlines


def _norm_ref(value: str) -> str:
    return "".join(ch for ch in (value or "").lower() if ch.isalnum())


def same_deadline(a: Dict, b: Dict) -> bool:
    """Two readings of one deadline: the same kind, due date and amount, from the same sender (case), and no
    reference number that contradicts the other (a copy or a photo may have lost one). Without a sender nothing is
    merged here; identical copies are merged by their document group instead."""
    return (a["kind"] == b["kind"] and a["date"] == b["date"] and (a.get("amount") or "") == (b.get("amount") or "")
            and bool(a.get("case")) and a.get("case") == b.get("case")
            and (not a["refs"] or not b["refs"] or bool(a["refs"] & b["refs"])))


def counts_as_letter(doc: Dict) -> bool:
    """Only letters have deadlines: not a note, a log file, a spreadsheet or a data file."""
    facts = doc.get("facts") or {}
    return (bool(facts.get("letter")) and (doc.get("file_type") or "").lower().lstrip(".") not in NOT_LETTER_TYPES
            and not doc.get("replaced") and not doc.get("suspicious"))


def _group_of(doc: Dict):
    """The document a copy belongs to: the first one of its duplicate group (same text as PDF, copy or photo)."""
    dup = doc.get("duplicate_of")
    return (dup["scope"], dup["id"]) if dup else (doc["scope"], doc["id"])


def build_deadlines(inbox: Dict, today: str) -> List[Dict]:
    """The deadlines, payments and appointments of the inbox letters, oldest date first. One deadline stands for a
    letter and all its copies: the PDF, a second copy and the photo of it are one entry that lists the documents it
    comes from (`sources`) and all their keys (`keys`).

    Left out: documents that are not letters (notes, log and data files), letters a newer letter replaced, letters with
    scam signs (a scam's "deadline" is nothing to do), and, for a date that has passed, deadlines whose letters were all
    marked done (that is how a paid bill leaves the overdue list)."""
    now = date.fromisoformat(today)
    out = []
    for doc in sorted(inbox.get("documents", []), key=lambda d: (d.get("added") or "", d["scope"], d["id"])):
        if not counts_as_letter(doc):
            continue
        facts = doc.get("facts") or {}
        sender = (facts.get("sender") or {}).get("value")
        kind_of_letter = (facts.get("type") or {}).get("value")
        refs = {_norm_ref(r["value"]) for r in facts.get("references", [])}
        group = _group_of(doc)
        for f in facts.get("dates", []):
            if f.get("kind") not in DEADLINE_KINDS:
                continue
            days = (date.fromisoformat(f["value"]) - now).days
            key = deadline_key(doc["scope"], doc["id"], f["value"], f["kind"])
            source = {"key": key, "scope": doc["scope"], "document_id": doc["id"], "workspace_id": doc.get("workspace_id"),
                      "filename": doc["filename"], "page": f.get("page"), "line": f.get("line")}
            reading = {"kind": f["kind"], "date": f["value"], "amount": f.get("amount"), "case": facts.get("case"),
                       "refs": refs}
            mine = next((d for d in out if d["kind"] == f["kind"] and d["date"] == f["value"]
                         and (group in d["_groups"] or same_deadline(reading, d["_reading"]))), None)
            if mine:
                if key not in mine["keys"]:
                    mine["keys"].append(key)
                    mine["sources"].append(source)
                mine["_groups"].add(group)
                mine["_new"] = mine["_new"] or doc.get("status") == "new"
                continue
            out.append({
                "key": key, "keys": [key], "sources": [source],
                "scope": doc["scope"], "document_id": doc["id"], "workspace_id": doc.get("workspace_id"),
                "filename": doc["filename"], "title": doc.get("title"), "sender": sender, "type": kind_of_letter,
                "kind": f["kind"], "date": f["value"], "time": f.get("time"), "amount": f.get("amount"),
                "text": f.get("text"), "page": f.get("page"), "line": f.get("line"),
                "days": days, "state": _state(days), "reminders": [], "reminder_active": False, "done": False,
                "_groups": {group}, "_reading": reading, "_new": doc.get("status") == "new",
            })
    kept = []
    for d in out:
        if d["days"] < 0 and not d["_new"]:
            continue
        for private in ("_groups", "_reading", "_new"):
            d.pop(private)
        kept.append(d)
    kept.sort(key=lambda d: (d["date"], d.get("time") or "", d["filename"]))
    return kept


def add_reminders(deadlines: List[Dict], rows: Iterable, today: str) -> List[Dict]:
    """Put the stored reminders (rows with scope, document_id, due_date, kind, days_before, acknowledged) on the
    deadlines they belong to. A reminder is active from (due date - days before) until the user confirms it."""
    now = date.fromisoformat(today)
    by_key: Dict[str, list] = {}
    for r in rows:
        by_key.setdefault(deadline_key(r.scope, r.document_id, r.due_date, r.kind), []).append(r)
    for d in deadlines:
        mine = [r for k in d.get("keys", [d["key"]]) for r in by_key.get(k, [])]
        d["reminders"] = sorted({r.days_before for r in mine}, reverse=True)
        d["reminder_active"] = any(
            not r.acknowledged and date.fromisoformat(r.due_date) - timedelta(days=r.days_before) <= now for r in mine)
    return deadlines


def add_done(deadlines: List[Dict], rows: Iterable) -> List[Dict]:
    """Mark the deadlines the user finished (rows with scope, document_id, due_date, kind). A done deadline has no
    active reminder."""
    finished = {deadline_key(r.scope, r.document_id, r.due_date, r.kind) for r in rows}
    for d in deadlines:
        d["done"] = any(k in finished for k in d.get("keys", [d["key"]]))
        if d["done"]:
            d["reminder_active"] = False
    return deadlines


# ---------------------------------------------------------------- the calendar file (RFC 5545)

def ics_text(value: str) -> str:
    """Escape a TEXT value: backslash, semicolon, comma and line breaks (RFC 5545, 3.3.11)."""
    return (value or "").replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\r\n", "\n") \
        .replace("\r", "\n").replace("\n", "\\n")


def ics_fold(line: str) -> str:
    """Content lines are at most 75 octets; a longer one continues on a line that starts with a space. A character is
    never split in the middle."""
    out, current = [], ""
    for ch in line:
        if len((current + ch).encode()) > 73:
            out.append(current)
            current = " "
        current += ch
    out.append(current)
    return "\r\n".join(out)


def _trigger(days_before: int, timed: bool) -> str:
    """When the alarm rings, relative to the start of the event. An all-day event starts at midnight; its alarm rings at
    ALARM_HOUR, `days_before` days earlier (0: the morning of the day)."""
    if timed:
        return f"-P{days_before}D" if days_before else "-PT1H"
    if days_before == 0:
        return f"PT{ALARM_HOUR}H"
    left = days_before - 1
    return f"-P{left}DT{24 - ALARM_HOUR}H" if left else f"-PT{24 - ALARM_HOUR}H"


def deadlines_calendar(deadlines: List[Dict], stamp: str, lang: str = "en") -> str:
    """The deadlines as an iCalendar file. Deadlines and payments are all-day events; an appointment with a time is a
    one-hour event at that time. Each event has an alarm for every reminder the user set for it, or one
    DEFAULT_ALARM_DAYS days before. The event's UID comes from the deadline's key, so importing the file again updates
    the events instead of doubling them. Made on this PC; nothing is sent anywhere."""
    words = LABELS.get(lang, LABELS["en"])
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//StarkLLM//Deadlines//EN", "CALSCALE:GREGORIAN",
             "METHOD:PUBLISH", "X-WR-CALNAME:StarkLLM"]
    for d in deadlines:
        day = date.fromisoformat(d["date"])
        timed = d["kind"] == "appointment" and bool(d.get("time"))
        who = d.get("title") or d.get("sender") or d["filename"]
        title = f"{words.get(d['kind'], words['date'])}: {who}" + (f" ({d['amount']})" if d.get("amount") else "")
        source = words["source"].format(file=d["filename"], page=d.get("page") or 1) \
            + (words["line"].format(line=d["line"]) if d.get("line") else "")
        uid = hashlib.sha256(d["key"].encode()).hexdigest()[:24] + "@starkllm.local"
        lines += ["BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{stamp}"]
        if timed:
            hh, mm = d["time"].split(":")
            lines += [f"DTSTART:{day:%Y%m%d}T{hh}{mm}00", "DURATION:PT1H"]
        else:
            lines += [f"DTSTART;VALUE=DATE:{day:%Y%m%d}", f"DTEND;VALUE=DATE:{day + timedelta(days=1):%Y%m%d}",
                      "TRANSP:TRANSPARENT"]
        lines += [ics_fold(f"SUMMARY:{ics_text(title)}"),
                  ics_fold(f"DESCRIPTION:{ics_text((d.get('text') or '') + chr(10) + source)}")]
        for n in (d.get("reminders") or [DEFAULT_ALARM_DAYS]):
            lines += ["BEGIN:VALARM", "ACTION:DISPLAY", f"TRIGGER:{_trigger(n, timed)}",
                      ics_fold(f"DESCRIPTION:{ics_text(title)}"), "END:VALARM"]
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"
