"""The document home: newest documents and the deadlines and payment dates in them, found by rules in the text."""
import uuid
from datetime import date, timedelta

from fastapi.testclient import TestClient

from app.api.auth import create_access_token, get_password_hash
from app.db import models
from app.db.session import SessionLocal
from app.main import app
from app.services.dates_service import find_dates, letter_date, replaced_letters
from app.services.rag_service import rag_service

client = TestClient(app)

TAX = """Finanzamt München
Bescheid über Einkommensteuer 2025
Datum: 03.11.2026

die festgesetzte Nachzahlung beträgt 1.234,56 EUR. Bitte überweisen Sie den Betrag bis zum 15.12.2026
auf das Konto IBAN DE89 3704 0044 0532 0130 00."""

INSURANCE = """Allianz Versicherungs-AG
Datum: 28.10.2026

der Jahresbeitrag 2027 beträgt 642,80 EUR.
Der Betrag wird am 01.01.2027 per Lastschrift eingezogen.

Kündigungsfrist: ein Monat vor Ablauf, also bis 30.11.2026."""


def test_a_tax_notice_has_its_payment_deadline_with_the_amount_but_not_the_letter_date():
    found = find_dates(TAX)
    assert [(f.date, f.kind, f.amount) for f in found] == [("2026-12-15", "deadline", "1.234,56 EUR")]
    assert "bis zum 15.12.2026" in found[0].text  # the sentence runs over the line break


def test_an_insurance_bill_has_the_debit_date_and_the_cancellation_deadline():
    found = {f.date: f for f in find_dates(INSURANCE)}
    assert set(found) == {"2027-01-01", "2026-11-30"}
    assert found["2027-01-01"].kind == "payment"
    assert found["2026-11-30"].kind == "deadline" and "Kündigungsfrist" in found["2026-11-30"].text


def test_written_months_and_english_letters():
    assert [f.date for f in find_dates("Die Frist endet am 3. März 2027.")] == ["2027-03-03"]
    assert [(f.date, f.amount) for f in find_dates("Payment of €89.00 is due by December 1, 2026.")] == [("2026-12-01", "89.00 EUR")]
    assert [f.date for f in find_dates("Please pay the invoice by 2026-12-20.")] == ["2026-12-20"]


def test_dates_without_anything_to_do_are_left_out():
    assert find_dates("Sie wohnen seit dem 01.04.2019 in München. Datum: 02.11.2026") == []
    assert find_dates("Fällig am 31.02.2026") == []  # no such day
    assert find_dates("Telefon 089 12.34.5678") == []


# ---------------------------------------------------------------- the endpoint

def _user_with_documents(tmp_path, letters=None):
    name = f"home_{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        user = models.User(username=name, hashed_password=get_password_hash("x" * 12))
        db.add(user)
        db.commit()
        ws = models.Workspace(name="Post", user_id=user.id)
        db.add(ws)
        db.commit()
        soon = (date.today() + timedelta(days=10)).strftime("%d.%m.%Y")
        long_ago = (date.today() - timedelta(days=60)).strftime("%d.%m.%Y")
        docs = []
        for fname, text in letters or [("Rechnung.pdf", f"Bitte zahlen Sie 49,90 EUR bis zum {soon}."),
                                       ("Alt.pdf", f"Die Frist endete am {long_ago}.")]:
            path = tmp_path / fname
            path.write_bytes(b"%PDF")
            doc = models.Document(workspace_id=ws.id, filename=fname, filepath=str(path), file_type="pdf", status="indexed")
            db.add(doc)
            db.commit()
            docs.append((doc.id, str(path), text))
        ids = (user.id, ws.id)
    finally:
        db.close()
    col = rag_service.get_or_create_collection(ids[1], ids[0])
    for doc_id, path, text in docs:
        col.add(ids=[uuid.uuid4().hex], documents=[text], metadatas=[{"source": path, "page": 1, "chunk": 1}],
                embeddings=[[1.0, 0.0]])
    return ids, name


def test_home_lists_new_documents_and_upcoming_dates_with_their_page(tmp_path):
    (user_id, ws_id), name = _user_with_documents(tmp_path)
    try:
        body = client.get("/api/v1/dashboard/home", headers={"Authorization": f"Bearer {create_access_token({'sub': name})}"}).json()
    finally:
        rag_service.chroma_client.delete_collection(f"user_{user_id}_workspace_{ws_id}")
    assert [d["filename"] for d in body["recent"]] == ["Alt.pdf", "Rechnung.pdf"]
    assert len(body["dates"]) == 1  # the deadline two months ago is not shown
    d = body["dates"][0]
    assert d["filename"] == "Rechnung.pdf" and d["page"] == 2 and d["amount"] == "49,90 EUR"
    assert d["passed"] is False and d["kind"] == "deadline" and d["workspace_id"] == ws_id


def test_an_invitation_is_an_appointment_with_its_time():
    found = find_dates("bitte kommen Sie am Mittwoch, 18.11.2026, um 10:30 Uhr in die Agentur für Arbeit, Raum 2.14.")
    assert [(f.date, f.kind, f.time) for f in found] == [("2026-11-18", "appointment", "10:30")]


def test_with_two_dates_the_one_after_bis_zum_is_the_deadline():
    found = find_dates("Ihre Kündigung zum 31.12.2026 muss uns bis zum 30.11.2026 vorliegen.")
    assert [(f.date, f.kind) for f in found] == [("2026-11-30", "deadline")]


def test_the_amount_is_the_one_owed_not_the_fee_in_the_next_sentence():
    found = find_dates("für Oktober 2026 über 96,00 EUR\nhaben wir noch keine Zahlung erhalten.\nBitte überweisen Sie den "
                       "Betrag\nbis zum 20.11.2026.\nDanach berechnen wir eine\nMahngebühr von 2,50 EUR.")
    assert [(f.date, f.amount) for f in found] == [("2026-11-20", "96,00 EUR")]
    found = find_dates("Ihr Beitrag beträgt für das Jahr 2027 687,12 EUR (bisher 598,40 EUR). Grund ist die neue "
                       "Typklasse. Der Betrag wird am 01.01.2027 per Lastschrift eingezogen.")
    assert [(f.date, f.amount) for f in found] == [("2027-01-01", "687,12 EUR")]


def test_a_corrected_letter_names_the_letter_it_replaces():
    text = "Hausverwaltung Kurpfalz GmbH\nDatum: 05.11.2026\nDiese korrigierte Abrechnung ersetzt die Abrechnung vom 20.10.2026 vollständig."
    assert letter_date(text) == "2026-11-05"
    assert replaced_letters(text) == ["2026-10-20"]


def test_home_leaves_out_the_dates_of_a_replaced_letter(tmp_path):
    soon = (date.today() + timedelta(days=20)).strftime("%d.%m.%Y")
    old = (date.today() - timedelta(days=21)).strftime("%d.%m.%Y")
    new = (date.today() - timedelta(days=5)).strftime("%d.%m.%Y")
    letters = [
        ("Abrechnung.pdf", f"Hausverwaltung Kurpfalz GmbH\nDatum: {old}\nNachzahlung: 318,40 EUR. Bitte zahlen Sie bis zum {soon}."),
        ("Korrektur.pdf", f"Hausverwaltung Kurpfalz GmbH\nDatum: {new}\nDiese Abrechnung ersetzt die Abrechnung vom {old}.\n"
                          f"Nachzahlung: 268,40 EUR. Bitte zahlen Sie bis zum {soon}."),
    ]
    (user_id, ws_id), name = _user_with_documents(tmp_path, letters)
    try:
        body = client.get("/api/v1/dashboard/home", headers={"Authorization": f"Bearer {create_access_token({'sub': name})}"}).json()
    finally:
        rag_service.chroma_client.delete_collection(f"user_{user_id}_workspace_{ws_id}")
    assert [(d["filename"], d["amount"]) for d in body["dates"]] == [("Korrektur.pdf", "268,40 EUR")]
    assert [d["filename"] for d in body["recent"] if d.get("replaced")] == ["Abrechnung.pdf"]


def test_pdf_text_with_plain_line_breaks_gives_the_right_amount_and_sentence():
    # text as it comes out of a PDF: every line ends with a plain line break, the letterhead has no end marks
    pdf = ("Finanzamt Rheinstadt\nPostfach 10 20 30, 68001 Rheinstadt\nLena Hoffmann\nDatum: 03.11.2026\n"
           "Festgesetzte Einkommensteuer: 6.842,00 EUR\nBereits gezahlt (Lohnsteuer): 6.430,00 EUR\n"
           "Verbleibende Nachzahlung: 412,00 EUR\nDie Nachzahlung von 412,00 EUR ist fällig am 15.12.2026. Bitte überweisen Sie den Betrag unter Angabe der\n"
           "Steuernummer auf das Konto der Finanzkasse Rheinstadt.")
    found = find_dates(pdf)
    assert [(f.date, f.amount) for f in found] == [("2026-12-15", "412,00 EUR")]
    assert found[0].text == "Die Nachzahlung von 412,00 EUR ist fällig am 15.12.2026."
