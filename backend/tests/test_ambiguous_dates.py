"""An ambiguous slash date ("03/04/2026" with nothing in the letter that says which comes first) is shown with both
readings and is used for no reminder, calendar entry or "next date" until the user chooses."""
import uuid
from datetime import date, timedelta

from fastapi.testclient import TestClient

from app.api.dashboard import dates_calendar, document_dates, document_inbox
from app.db import models
from app.db.session import SessionLocal
from app.main import app
from test_document_inbox import _user

client = TestClient(app)

def _letter():
    # choose a due day that is ambiguous whatever today is: day 5, month = next month with number != 5, within a year
    due = date.today() + timedelta(days=45)
    due = due.replace(day=5) if due.month != 5 else due.replace(day=6)
    if due < date.today():
        due = due.replace(year=due.year + 1)
    literal = f"{due.day:02d}/{due.month:02d}/{due.year}"
    swapped = date(due.year, due.day, due.month)  # month first reading: month = day number 5/6, day = old month
    return due, swapped, literal, f"Maple Utilities Inc.\nDate: 02/01/2026\nInvoice\nYour total is $12.00.\nPlease pay by {literal}.\n"


def test_an_ambiguous_date_is_flagged_everywhere_and_excluded_from_calendar_and_next(tmp_path):
    due, swapped, literal, text = _letter()
    (user_id, ws_id), headers, docs = _user(tmp_path, [("bill.pdf", text)])
    doc_id = docs[0]
    db = SessionLocal()
    try:
        inbox = document_inbox(db, user_id)
        (doc,) = inbox["documents"]
        (d,) = [x for x in doc["facts"]["dates"] if x["kind"] == "deadline"]
        assert d["ambiguous"] is True and d["literal"] == literal and set(d["readings"]) == {"dmy", "mdy"}
        assert doc["next"] is None  # never "next" before the user chose
        _, _, dates = document_dates(db, user_id, past_days=0)
        assert [x["ambiguous"] for x in dates if x["kind"] == "deadline"] == [True]
        assert "BEGIN:VEVENT" not in dates_calendar(date.today(), dates, "20260101T000000Z")  # no calendar entry, no reminder
    finally:
        db.close()


def test_the_choice_resolves_the_date_and_can_be_taken_back(tmp_path):
    due, swapped, literal, text = _letter()
    (user_id, ws_id), headers, docs = _user(tmp_path, [("bill.pdf", text)])
    doc_id = docs[0]
    url = f"/api/v1/dashboard/inbox/ws/{doc_id}/date"
    assert client.post(url, json={"literal": literal, "reading": "xyz"}, headers=headers).status_code == 422
    assert client.post(url, json={"literal": literal, "reading": "dmy"}, headers=headers).status_code == 200
    db = SessionLocal()
    try:
        (doc,) = document_inbox(db, user_id)["documents"]
        (d,) = [x for x in doc["facts"]["dates"] if x["kind"] == "deadline"]
        assert d["value"] == due.isoformat() and d["ambiguous"] is False and d["chosen"] == "dmy"
        assert doc["next"]["value"] == due.isoformat()
        _, _, dates = document_dates(db, user_id, past_days=0)
        assert "BEGIN:VEVENT" in dates_calendar(date.today(), dates, "20260101T000000Z")
    finally:
        db.close()
    # the other reading, then taken back
    assert client.post(url, json={"literal": literal, "reading": "mdy"}, headers=headers).status_code == 200
    db = SessionLocal()
    try:
        (doc,) = document_inbox(db, user_id)["documents"]
        (d,) = [x for x in doc["facts"]["dates"] if x["kind"] == "deadline"]
        assert d["value"] == d["readings"]["mdy"] and d["chosen"] == "mdy"
    finally:
        db.close()
    assert client.post(url, json={"literal": literal}, headers=headers).status_code == 200
    db = SessionLocal()
    try:
        (doc,) = document_inbox(db, user_id)["documents"]
        (d,) = [x for x in doc["facts"]["dates"] if x["kind"] == "deadline"]
        assert d["ambiguous"] is True
    finally:
        db.close()


def test_someone_elses_document_has_no_choice(tmp_path):
    due, swapped, literal, text = _letter()
    (user_id, ws_id), _, docs = _user(tmp_path, [("bill.pdf", text)])
    _, headers, _ = _user(tmp_path, [("x.pdf", "Muster\nBrief\n")])
    r = client.post(f"/api/v1/dashboard/inbox/ws/{docs[0]}/date", json={"literal": literal, "reading": "dmy"}, headers=headers)
    assert r.status_code == 404
