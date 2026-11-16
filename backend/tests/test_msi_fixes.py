"""Defects found by the MSI test of 2.0.16 (15 Nov 2026), with the synthetic documents of tests/fixtures/msi/:
P2  an app.log counted as a new letter and its timestamp showed as an expired deadline
P5  the engine's warning instructions for suspicious documents were copied into answers about other documents
P8  models invented legal deadlines and called future deadlines overdue"""
import inspect
import uuid
from datetime import date, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api import chat
from app.api.chat import DEADLINE_RULES, _dates_block, _document_warnings, _safety_section, relative_time
from app.main import app
from app.services.dates_service import find_dates
from app.services.document_checks import findings
from app.services.facts_service import document_facts
from app.services.rag_service import rag_service
from test_document_inbox import _drop, _user

FIXTURES = Path(__file__).parent / "fixtures" / "msi"
client = TestClient(app)


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


# ---- P2: machine and note files are never letters ---------------------------------------------------------------

MACHINE_FILES = ["app.log", "suppliers.csv", "config.json", "photo_description.txt"]


@pytest.mark.parametrize("name", MACHINE_FILES)
def test_machine_fixtures_are_not_letters_and_have_no_deadlines(name):
    facts = document_facts({1: fixture(name)}, {"photo_description.txt": "Room plan.jpg"}.get(name, name))
    assert facts["letter"] is False
    assert facts["dates"] == [] and facts["sender"] is None and facts["type"] is None
    assert facts["references"] == [] and facts["amounts"] == []


@pytest.mark.parametrize("name,text", [
    ("data.tsv", "date\tvalue\n2026-11-14\t5"),
    ("feed.xml", "<feed><entry><due>2026-11-20</due></entry></feed>"),
    ("deploy.yaml", "release:\n  due: 2026-11-20\n  owner: platform"),
    ("deploy.yml", "release:\n  due: 2026-11-20"),
    ("settings.ini", "[job]\ndue = 2026-11-20\nowner = ops"),
    ("notes.md", "# Meeting\nPayment is due by 20.11.2026, please remember."),
    ("tool.py", "# renew by 20.11.2026\nDEADLINE = '2026-11-20'"),
    ("run.sh", "#!/bin/sh\n# invoice due 20.11.2026\necho done"),
])
def test_file_type_decides_first(name, text):
    facts = document_facts({1: text}, name)
    assert facts["letter"] is False and facts["dates"] == [], name


def test_content_decides_when_the_file_is_called_txt():
    log = fixture("app.log")
    for name, text in [("upload.txt", log), ("upload.txt", fixture("config.json")),
                       ("export.txt", '<?xml version="1.0"?>\n<jobs><job due="2026-11-20"/></jobs>'),
                       ("one-line.txt", '{"service": "billing-api", "due": "2026-11-20"}'),
                       ("Foto.jpg", fixture("photo_description.txt"))]:
        facts = document_facts({1: text}, name)
        assert facts["letter"] is False and facts["dates"] == [], (name, text[:30])


def test_a_real_letter_saved_as_txt_is_still_a_letter():
    for name in ("Steuerbescheid.txt", "Rechnung.txt"):
        text = fixture("tax_letter_de.txt" if "Steuer" in name else "invoice_en_gbp.txt")
        facts = document_facts({1: text}, name)
        assert facts["letter"] is True, name
        assert facts["sender"] is not None and facts["dates"], name
    tax = document_facts({1: fixture("tax_letter_de.txt")}, "Steuerbescheid.txt")
    assert tax["sender"]["value"] == "Finanzamt Rheinstadt"
    assert "2026-12-15" in [d["value"] for d in tax["dates"]]


def test_spreadsheets_and_plain_notes_stay_excluded():
    assert not document_facts({1: "Sheet: Inventory\nItem | Count | Price\nSolar inverter SI-9 | 4 | 1290,00 EUR"},
                              "Inventory.xlsx")["letter"]
    assert not document_facts({1: "Shift handover note. The night shift supervisor is Karim Nouri."}, "Note.txt")["letter"]


def test_a_bare_timestamp_is_not_a_deadline_unless_a_deadline_word_is_next_to_it():
    # only the log line with "expires" keeps its date at this level; for a .log file the file type decides first
    assert [d.text for d in find_dates(fixture("app.log"))] == [
        "2026-11-14 08:03:17 WARN certificate expires soon, renew by the next release"]
    assert find_dates("\n".join(l for l in fixture("app.log").splitlines() if "expires" not in l)) == []
    assert find_dates("[2026-11-14T08:00:01Z] ERROR job failed\n2026-11-14 INFO retrying") == []
    kept = find_dates("2026-11-14 08:00:09 WARN the licence expires 2026-11-20")
    assert [(d.date, d.kind) for d in kept] == [("2026-11-14", "deadline"), ("2026-11-20", "deadline")]
    # a date at the start of a letter line, without a time or a log level, is still read
    assert [d.date for d in find_dates("2026-12-15 Zahlung fällig", date(2026, 11, 3))] == ["2026-12-15"]
    # a letter that quotes a log line keeps its own deadline
    letter = "Bitte zahlen Sie bis zum 15.12.2026.\n2026-11-14 08:00:01 INFO started"
    assert [d.date for d in find_dates(letter)] == ["2026-12-15"]


def test_inbox_and_start_page_ignore_the_log(tmp_path):
    ids, headers, _ = _user(tmp_path, [("Rechnung.txt", fixture("invoice_en_gbp.txt")), ("app.log", fixture("app.log")),
                                        ("suppliers.csv", fixture("suppliers.csv")), ("config.json", fixture("config.json")),
                                        ("Foto.jpg", fixture("photo_description.txt"))])
    try:
        body = client.get("/api/v1/dashboard/inbox", headers=headers).json()
        count = client.get("/api/v1/dashboard/inbox/count", headers=headers).json()
        home = client.get("/api/v1/dashboard/home", headers=headers).json()
    finally:
        _drop(ids)
    docs = {d["filename"]: d for d in body["documents"]}
    assert docs["Rechnung.txt"]["facts"]["letter"] and docs["Rechnung.txt"]["status"] == "new"
    for name in ("app.log", "suppliers.csv", "config.json", "Foto.jpg"):
        assert not docs[name]["facts"]["letter"] and docs[name]["status"] == "done" and docs[name]["next"] is None, name
    assert body["new_count"] == 1 and count == {"new_count": 1}
    assert {d["filename"] for d in home["dates"]} <= {"Rechnung.txt"}, "no deadline from a log, a table or a JSON file"


# ---- P5: the warning is a short fact for the model, never a text to copy ----------------------------------------------

def _retrieved(name, text):
    return {"content": text, "metadata": {"source": f"/data/{name}"}}


def test_no_warning_text_when_the_scam_is_in_the_workspace_but_not_a_source():
    user_id, ws_id = 900000 + uuid.uuid4().int % 99999, 7
    col = rag_service.get_or_create_collection(ws_id, user_id)
    try:
        col.add(ids=["inv", "scam"], documents=[fixture("invoice_en_gbp.txt"), fixture("scam_letter.txt")],
                metadatas=[{"source": "/data/Invoice.txt"}, {"source": "/data/Mahnung.txt"}],
                embeddings=[[1.0, 0.0], [0.0, 1.0]])
        sources = [_retrieved("Invoice.txt", fixture("invoice_en_gbp.txt"))]
        warnings = _document_warnings(sources, [], ws_id, user_id, "How much is the total of the Brightwater invoice?")
    finally:
        rag_service.chroma_client.delete_collection(f"user_{user_id}_workspace_{ws_id}")
    assert warnings == []
    assert _safety_section(warnings) == ""


def test_a_retrieved_scam_gives_one_short_fact_block_without_the_old_instructions():
    user_id, ws_id = 900000 + uuid.uuid4().int % 99999, 8
    rag_service.get_or_create_collection(ws_id, user_id)
    try:
        sources = [_retrieved("Mahnung.txt", fixture("scam_letter.txt")), _retrieved("Invoice.txt", fixture("invoice_en_gbp.txt"))]
        warnings = _document_warnings(sources, [], ws_id, user_id, "Ist die Mahnung echt?")
    finally:
        rag_service.chroma_client.delete_collection(f"user_{user_id}_workspace_{ws_id}")
    kinds = {w["kind"] for w in warnings}
    assert {"ai_instructions", "scam_signs"} <= kinds, "the red warning of the UI still has its findings"
    section = _safety_section(warnings)
    assert section.count("[Mahnung.txt]") == 1, "one fact per document, even with two findings"
    assert "Invoice.txt" not in section
    assert "do not quote" in section.lower()
    for copied in ("tell the user that this document looks manipulated", "Real letters do not", "GENUINE", "how to check it",
                   "contact the named organisation", "If other documents answer the question"):
        assert copied not in section, copied
    assert len(section) < 1200


def test_account_notes_are_not_repeated():
    found = [{"kind": "accounts", "sender": "Finanzamt", "accounts": [{"iban": "DE41", "files": ["a.txt"]}, {"iban": "LT73", "files": ["b.txt"]}]}] * 2
    section = _safety_section(found)
    assert section.count("different bank accounts") == 1


# ---- P8: deadlines come with a relative time counted by the engine ---------------------------------------------------

def test_every_deadline_has_its_relative_time_counted_by_the_engine():
    today = date(2026, 11, 15)
    dates = [{"date": "2026-12-12", "kind": "deadline", "filename": "Steuerbescheid.pdf", "text": "fällig am 12.12.2026"},
             {"date": "2026-11-12", "kind": "payment", "filename": "Rechnung.pdf", "text": "zahlen bis 12.11.2026", "amount": "96,00 EUR"},
             {"date": "2026-11-15", "kind": "deadline", "filename": "a.pdf", "text": "heute"},
             {"date": "2026-11-16", "kind": "deadline", "filename": "b.pdf", "text": "morgen"}]
    block = _dates_block(today, dates)
    assert "(Sat, in 27 days) deadline | Steuerbescheid.pdf" in block
    assert "(Thu, overdue by 3 days) payment, 96,00 EUR | Rechnung.pdf" in block
    assert "today)" in block and "tomorrow)" in block
    assert "PASSED" not in block
    assert "never count days yourself" in block and "is still ahead" in block
    assert relative_time(date(2026, 11, 14), today) == "overdue by 1 days"


def test_the_prompt_forbids_computing_or_inventing_legal_deadlines():
    for needle in ("Never calculate", "invent a legal deadline", "quote the period as written",
                   "depends on the day the letter was delivered", "unless the letter states it"):
        assert needle in DEADLINE_RULES, needle
    # both document modes of the system prompt carry the rule
    assert inspect.getsource(chat).count("{DEADLINE_RULES}") == 2
    # and today's date is given once, in the identity block
    assert inspect.getsource(chat).count("Today is {_today") == 1


def test_the_tax_letter_gives_the_period_and_no_end_date():
    text = fixture("tax_letter_de.txt")
    facts = document_facts({1: text}, "Steuerbescheid.txt")
    assert "innerhalb eines Monats nach Bekanntgabe" in text
    # the engine finds the payment date only; the objection period stays a period, the model never turns it into a date
    assert [d["value"] for d in facts["dates"]] == ["2026-12-15"]
    assert findings([{"file": "Steuerbescheid.txt", "text": text}]) == []
