"""The yearly package for the tax advisor (StarkLLM 2.8, option 11): the year's financial letters, renamed and sorted
into category folders, an overview as CSV and XLSX and a summary, as a ZIP. Scams and duplicates stay out, the user's
changes from the review count, file names are safe on every system, and an optional password encrypts the ZIP with
AES-256. Nothing is sent anywhere."""
import csv
import io
import uuid
import zipfile
from datetime import date

import pytest
from docx import Document as DocxDocument
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from app.api.auth import create_access_token, get_password_hash
from app.db import models
from app.db.session import SessionLocal
from app.main import app
from app.services import tax_pack, zip_aes
from app.services.facts_service import document_facts
from app.services.rag_service import rag_service

client = TestClient(app)
TODAY = date.today().isoformat()

LETTERS = {
    "tax.pdf": ("2025-03-11", "Finanzamt Rheinstadt\nDatum: 10.03.2025\nSteuernummer: 38/123/45678\nBescheid für 2024 über "
                "Einkommensteuer\nDie Nachzahlung von 412,00 EUR ist fällig am 10.04.2025. IBAN DE41 6005 0000 0001 2345 67."),
    "bill.pdf": ("2025-05-16", "Stadtwerke Rheinstadt\nDatum: 15.05.2025\nRechnung Nr. 2025-118\nStrom 01-04/2025\n"
                 "Gesamtbetrag 96,50 EUR\nBitte zahlen Sie bis zum 30.05.2025."),
    "ins.pdf": ("2025-01-03", "Kurpfalz Direkt Versicherung AG\nDatum: 02.01.2025\nBeitragsrechnung für das Versicherungsjahr "
                "2025\nDer Beitrag von 240,00 EUR wird am 15.01.2025 abgebucht."),
    "pay.pdf": ("2025-02-01", "Muster GmbH\nPersonalabteilung\nDatum: 31.01.2025\nGehaltsabrechnung Januar 2025\n"
                "Brutto 3.500,00 EUR\nAuszahlungsbetrag 2.310,45 EUR"),
    "doc.pdf": ("2025-06-21", "Zahnarztpraxis Dr. Weiß\nDatum: 20.06.2025\nRechnung Nr. 77\nGesamtbetrag 180,00 EUR\n"
                "Zahlbar bis 20.07.2025."),
    "scam.pdf": ("2025-11-09", "Finanzamt Rheinstadt - Vollstreckungsstelle\nDatum: 08.11.2025\nLETZTE MAHNUNG\nZahlen Sie "
                 "412,00 EUR innerhalb von 48 Stunden auf IBAN LT73 3250 0123 4567 8901 bis zum 12.11.2025, sonst "
                 "Haftbefehl.\nZahlung nur per Bitcoin oder Gutscheinkarte."),
    "invite.pdf": ("2025-07-02", "Stadtbibliothek Rheinstadt\nDatum: 01.07.2025\nEinladung zur Lesung am 12.07.2025"),
    "old.pdf": ("2024-05-16", "Stadtwerke Rheinstadt\nDatum: 15.05.2024\nRechnung Nr. 2024-118\nGesamtbetrag 90,00 EUR"),
    "acme.pdf": ("2025-08-02", "ACME <Bad>/:*? Ltd\nDate: 2025-08-01\nInvoice INV-9\nTotal due: $120.00 by 2025-08-31"),
    "receipt.jpg": ("2025-02-04", "Bäckerei Krume\nQuittung\nDatum: 03.02.2025\nSumme 12,40 EUR"),
    "notes.md": ("2025-03-01", "# Steuer 2025\nRechnung Stadtwerke 96,50 EUR bezahlt am 20.05.2025"),
}
# the photo of the tax notice, added a week later: the same text
LETTERS["tax_photo.jpg"] = ("2025-03-18", LETTERS["tax.pdf"][1])


def _items(names, workspace_id=1, scope="ws"):
    items, pages = [], []
    for i, name in enumerate(names, start=1):
        added, text = LETTERS[name]
        items.append({"scope": scope, "id": i, "workspace_id": workspace_id if scope == "ws" else None,
                      "workspace": "Post", "filename": name, "file_type": name.rsplit(".", 1)[1],
                      "added": f"{added}T10:00:00"})
        pages.append({1: text})
    return items, pages


def _rows(names=None, year=2025, lang="de", done=None, **kw):
    names = names or list(LETTERS)
    items, pages = _items(names)
    rows, years = tax_pack.build_rows(items, pages, [False] * len(items), document_facts, year, kw.pop("workspaces", [1]),
                                      kw.pop("include_kb", False), lang, TODAY, done)
    return {r["filename"]: r for r in rows}, years


# ---------------------------------------------------------------- the list

def test_only_letters_of_the_chosen_year_are_listed():
    rows, years = _rows()
    assert "old.pdf" not in rows and years == [2025, 2024]
    assert "notes.md" not in rows  # a note is no letter
    assert all(r["date"].startswith("2025") for r in rows.values())
    rows_2024, _ = _rows(year=2024)
    assert list(rows_2024) == ["old.pdf"]


def test_only_chosen_workspaces_count():
    rows, years = _rows(workspaces=[2])
    assert rows == {} and years == []


def test_scams_and_duplicates_are_left_out():
    rows, _ = _rows()
    assert rows["scam.pdf"]["included"] is False and rows["scam.pdf"]["excluded_reason"] == "scam"
    assert rows["tax_photo.jpg"]["included"] is False and rows["tax_photo.jpg"]["excluded_reason"] == "duplicate"
    assert rows["tax_photo.jpg"]["duplicate_of"] == rows["tax.pdf"]["key"] and rows["tax.pdf"]["included"]
    assert rows["invite.pdf"]["included"] is False and rows["invite.pdf"]["excluded_reason"] == "not_financial"
    assert rows["scam.pdf"]["new_name"] is None


def test_same_sender_date_kind_and_amount_is_a_duplicate_with_other_text():
    """The photo of a letter can be read slightly differently (OCR): the same sender, date, kind and amount count as
    the same letter."""
    LETTERS["bill_photo.jpg"] = ("2025-05-20", LETTERS["bill.pdf"][1].replace("Strom 01-04/2025", "Str0m 01-04/2O25"))
    try:
        rows, _ = _rows(["bill.pdf", "bill_photo.jpg"])
    finally:
        del LETTERS["bill_photo.jpg"]
    assert rows["bill.pdf"]["included"] and rows["bill_photo.jpg"]["excluded_reason"] == "duplicate"


def test_categories_come_from_the_rules_with_their_reason():
    rows, _ = _rows()
    expected = {"tax.pdf": "tax", "bill.pdf": "housing", "ins.pdf": "insurance", "pay.pdf": "work", "doc.pdf": "health",
                "acme.pdf": "other", "receipt.jpg": "other"}
    assert {k: rows[k]["category"] for k in expected} == expected
    assert rows["tax.pdf"]["category_reason"] == {"word": "finanzamt", "page": 1, "where": "sender"}
    assert all(rows[k]["category_source"] == "rules" for k in expected)


def test_amounts_kinds_due_dates_and_receipts():
    rows, _ = _rows()
    assert (rows["pay.pdf"]["number"], rows["pay.pdf"]["currency"]) == ("2310.45", "EUR")  # the paid-out amount, not gross
    assert rows["tax.pdf"]["due"] == "2025-04-10" and rows["tax.pdf"]["page"] == 1
    assert rows["receipt.jpg"]["kind"] == "receipt" and rows["receipt.jpg"]["included"]
    assert rows["acme.pdf"]["currency"] == "USD"


def test_status_paid_done_open():
    done = {("ws", 2): {"deadline"}, ("ws", 3): {"payment"}}   # bill (invoice) and insurance
    rows, _ = _rows(done=done)
    assert rows["bill.pdf"]["status"] == "paid"   # a bill's deadline marked done is a payment
    assert rows["ins.pdf"]["status"] == "paid"
    assert rows["doc.pdf"]["status"] == ""        # passed, not marked
    # the done mark on the first letter counts for its copy
    done_copy = {("ws", 1): {"deadline"}}
    rows, _ = _rows(["tax.pdf", "tax_photo.jpg"], done=done_copy)
    assert rows["tax_photo.jpg"]["status"] == "done"


def test_status_open_for_a_date_ahead():
    facts = {"type": {"value": "invoice"}, "dates": [{"kind": "payment", "value": "2999-01-01"}]}
    assert tax_pack.status_of(facts, set(), TODAY) == "open"
    assert tax_pack.status_of(facts, {"appointment"}, TODAY) == "paid"
    assert tax_pack.status_of({"type": {"value": "tax_notice"}, "dates": []}, {"deadline"}, TODAY) == "done"


# ---------------------------------------------------------------- file names

def test_files_are_renamed_into_category_folders():
    rows, _ = _rows()
    assert rows["tax.pdf"]["path"] == "Steuer/2025-03-10_Finanzamt-Rheinstadt_Steuerbescheid_412.00EUR.pdf"
    assert rows["bill.pdf"]["path"] == "Wohnen/2025-05-15_Stadtwerke-Rheinstadt_Rechnung_96.50EUR.pdf"
    assert rows["doc.pdf"]["path"] == "Gesundheit/2025-06-20_Zahnarztpraxis-Dr.-Weiss_Rechnung_180.00EUR.pdf"
    assert rows["receipt.jpg"]["path"] == "Sonstiges/2025-02-03_Baeckerei-Krume_Quittung_12.40EUR.jpg"
    en, _ = _rows(lang="en")
    assert en["acme.pdf"]["path"] == "Other/2025-08-01_ACME-Bad-Ltd_Invoice_120.00USD.pdf"
    assert en["pay.pdf"]["path"].startswith("Work/2025-01-31_Muster-GmbH_Payslip_2310.45EUR")


@pytest.mark.parametrize("raw, safe", [
    ("../../etc/passwd", "etc-passwd"),
    ("C:\\Windows\\System32", "C-Windows-System32"),
    ("CON", "CON-"),
    ("nul", "nul-"),
    ("  Société Générale  ", "Societe-Generale"),
    ("İş Bankası A.Ş.", "Is-Bankasi-A.S"),
    ("Müller & Söhne GmbH", "Mueller-Soehne-GmbH"),
    ("a" * 80, "a" * 40),
    ("name\u0000with\u001fcontrol", "name-with-control"),
    ("...", ""),
])
def test_safe_file_name_parts(raw, safe):
    assert tax_pack.safe_part(raw) == safe


def test_names_are_unique_without_case_and_amount_is_optional():
    rows = [{"key": f"ws-{i}", "included": True, "category": "other", "date": "2025-01-01", "sender": s, "kind": "invoice",
             "number": None, "currency": None, "ext": "PDF", "excluded_reason": None} for i, s in enumerate(["ABC", "abc", "Abc"])]
    tax_pack.name_rows(rows, "en")
    assert [r["new_name"] for r in rows] == ["2025-01-01_ABC_Invoice.pdf", "2025-01-01_abc_Invoice_2.pdf",
                                             "2025-01-01_Abc_Invoice_3.pdf"]
    nobody = [{"key": "ws-9", "included": True, "category": "tax", "date": "2025-02-02", "sender": None, "kind": None,
               "number": "5", "currency": "EUR", "ext": "", "excluded_reason": None}]
    tax_pack.name_rows(nobody, "fr")
    assert nobody[0]["path"] == "Impots/2025-02-02_Document_Document_5.00EUR"


def test_category_folders_follow_the_language():
    for lang, folder in {"en": "Tax", "de": "Steuer", "es": "Impuestos", "fr": "Impots", "it": "Tasse", "tr": "Vergi"}.items():
        rows, _ = _rows(["tax.pdf"], lang=lang)
        assert rows["tax.pdf"]["path"].startswith(f"{folder}/"), lang
        assert rows["tax.pdf"]["category_name"] == tax_pack.CATEGORY_NAMES[lang]["tax"]
    for lang in tax_pack.LANGS:
        assert set(tax_pack.CATEGORY_NAMES[lang]) == set(tax_pack.CATEGORIES)
        assert set(tax_pack.KIND_NAMES[lang]) == set(tax_pack.KIND_NAMES["en"])
        assert set(tax_pack.TEXTS[lang]) == set(tax_pack.TEXTS["en"]) and len(tax_pack.TEXTS[lang]["columns"]) == 11


# ---------------------------------------------------------------- the user's changes

def test_overrides_change_category_and_inclusion():
    rows, _ = _rows()
    listed = tax_pack.apply_overrides(list(rows.values()), [
        {"key": rows["bill.pdf"]["key"], "category": "other"},
        {"key": rows["pay.pdf"]["key"], "included": False},
        {"key": rows["invite.pdf"]["key"], "included": True},
        {"key": rows["acme.pdf"]["key"], "category": "work", "source": "model"},
        {"key": "ws-999", "category": "tax"},             # not in the list: ignored
        {"key": rows["doc.pdf"]["key"], "category": "nonsense"},
    ], "de")
    got = {r["filename"]: r for r in listed}
    assert got["bill.pdf"]["path"].startswith("Sonstiges/") and got["bill.pdf"]["category_source"] == "user"
    assert got["pay.pdf"]["included"] is False and got["pay.pdf"]["excluded_reason"] == "user" and got["pay.pdf"]["path"] is None
    assert got["invite.pdf"]["included"] and got["invite.pdf"]["path"].startswith("Sonstiges/2025-07-01_Stadtbibliothek")
    assert got["acme.pdf"]["category"] == "work" and got["acme.pdf"]["category_source"] == "model"
    assert got["doc.pdf"]["category"] == "health"
    assert tax_pack.left_out_counts(listed) == {"scam": 1, "duplicate": 1, "user": 1, "missing": 0}


# ---------------------------------------------------------------- overview files

def _included(lang="de", **kw):
    rows, _ = _rows(lang=lang, **kw)
    return list(rows.values())


def test_csv_has_one_row_per_document_in_the_users_language():
    rows = _included()
    raw = tax_pack.csv_bytes(rows, "de")
    assert raw.startswith(b"\xef\xbb\xbf")
    table = list(csv.reader(io.StringIO(raw.decode("utf-8-sig")), delimiter=";"))
    assert table[0] == ["Datum", "Absender", "Art", "Kategorie", "Betrag", "Währung", "Fällig am", "Status", "Dateiname",
                        "Seite", "Originaldatei"]
    body = {r[10]: r for r in table[1:]}
    assert set(body) == {"tax.pdf", "bill.pdf", "ins.pdf", "pay.pdf", "doc.pdf", "acme.pdf", "receipt.jpg"}
    assert body["tax.pdf"] == ["10.03.2025", "Finanzamt Rheinstadt", "Steuerbescheid", "Steuer", "412,00", "EUR",
                               "10.04.2025", "nicht markiert",
                               "Steuer/2025-03-10_Finanzamt-Rheinstadt_Steuerbescheid_412.00EUR.pdf", "1", "tax.pdf"]
    en = list(csv.reader(io.StringIO(tax_pack.csv_bytes(_included("en"), "en").decode("utf-8-sig"))))
    assert en[0][0] == "Date" and {r[10]: r for r in en[1:]}["pay.pdf"][4] == "2310.45"


def test_csv_cells_never_become_formulas():
    rows = [{"key": "ws-1", "included": True, "category": "other", "date": "2025-01-01", "sender": "=HYPERLINK(\"x\")",
             "kind": "invoice", "kind_label": "Invoice", "number": "1", "currency": "EUR", "ext": "pdf",
             "excluded_reason": None, "filename": "@evil.pdf", "status": "", "page": 1, "due": None}]
    tax_pack.name_rows(rows, "en")
    line = list(csv.reader(io.StringIO(tax_pack.csv_bytes(rows, "en").decode("utf-8-sig"))))[1]
    assert line[1].startswith("'=") and line[10].startswith("'@")


def test_xlsx_has_dates_numbers_and_totals():
    rows = _included()
    wb = load_workbook(io.BytesIO(tax_pack.xlsx_bytes(rows, "de", 2025)))
    sheet = wb["Dokumente"]
    head = [c.value for c in sheet[1]]
    assert head[:4] == ["Datum", "Absender", "Art", "Kategorie"] and len(head) == 11
    data = {row[10]: row for row in sheet.iter_rows(min_row=2, values_only=True)}
    assert len(data) == 7
    tax = data["tax.pdf"]
    assert tax[0].date() == date(2025, 3, 10) and tax[4] == 412.0 and tax[5] == "EUR" and tax[6].date() == date(2025, 4, 10)
    assert tax[8] == "Steuer/2025-03-10_Finanzamt-Rheinstadt_Steuerbescheid_412.00EUR.pdf" and tax[9] == 1
    totals = list(wb["Summen"].iter_rows(min_row=3, values_only=True))
    by_cat = {r[0]: r for r in totals if r[0]}
    assert by_cat["Steuer"][1:] == (1, 412.0, "EUR")
    assert "KI-gestützt" in wb["Summen"]["A1"].value
    # the other currency of "Sonstiges" is summed apart
    other = [r for r in totals if r[0] in ("Sonstiges", None, "")]
    assert {(r[2], r[3]) for r in other} == {(12.4, "EUR"), (120.0, "USD")}


def test_summary_is_labelled_ai_assisted_with_totals():
    rows = _included()
    raw = tax_pack.summary_docx(rows, "de", 2025, "2026-11-28", tax_pack.left_out_counts(rows), False)
    doc = DocxDocument(io.BytesIO(raw))
    text = "\n".join(p.text for p in doc.paragraphs)
    cells = "\n".join(c.text for t in doc.tables for row in t.rows for c in row.cells)
    assert "KI-gestützt" in text and "Unterlagen für die Steuerberatung 2025" in text
    assert "1 mit Anzeichen für Betrug" in text and "1 Duplikate" in text
    assert "Steuer" in cells and "412,00 EUR" in cells and "2.310,45 EUR" in cells


# ---------------------------------------------------------------- the package

def test_package_zip_without_password():
    rows = _included()
    archive, info = tax_pack.build_package(rows, lambda r: f"content of {r['filename']}".encode(), "de", 2025, TODAY)
    names = zipfile.ZipFile(io.BytesIO(archive)).namelist()
    assert info == {"documents": 7, "missing": 0, "encrypted": False, "name": "Steuerunterlagen_2025.zip"}
    assert "Steuerunterlagen_2025/Steuer/2025-03-10_Finanzamt-Rheinstadt_Steuerbescheid_412.00EUR.pdf" in names
    assert {"Steuerunterlagen_2025/Uebersicht_2025.csv", "Steuerunterlagen_2025/Uebersicht_2025.xlsx",
            "Steuerunterlagen_2025/Zusammenfassung_2025.docx"} <= set(names)
    assert not any("scam" in n or "Stadtbibliothek" in n for n in names)
    assert zipfile.ZipFile(io.BytesIO(archive)).read(
        "Steuerunterlagen_2025/Gesundheit/2025-06-20_Zahnarztpraxis-Dr.-Weiss_Rechnung_180.00EUR.pdf") == b"content of doc.pdf"


def test_package_counts_a_file_that_cannot_be_read():
    rows = _included()
    archive, info = tax_pack.build_package(rows, lambda r: None if r["filename"] == "pay.pdf" else b"x", "en", 2025, TODAY)
    assert info["missing"] == 1 and info["documents"] == 6
    z = zipfile.ZipFile(io.BytesIO(archive))
    overview = z.read("Tax_documents_2025/Overview_2025.csv").decode("utf-8-sig")
    assert "pay.pdf" not in overview and "tax.pdf" in overview


def test_package_with_password_is_aes_encrypted():
    rows = _included()
    archive, info = tax_pack.build_package(rows, lambda r: b"%PDF secret " + r["filename"].encode(), "en", 2025, TODAY,
                                           password="correct horse")
    assert info["encrypted"] is True
    assert b"%PDF secret" not in archive and b"Finanzamt Rheinstadt;" not in archive
    z = zipfile.ZipFile(io.BytesIO(archive))   # the standard library sees an encrypted AES entry (method 99)
    assert all(i.flag_bits & 1 and i.compress_type == 99 for i in z.infolist())
    files = zip_aes.read(archive, "correct horse")
    assert files["Tax_documents_2025/Tax/2025-03-10_Finanzamt-Rheinstadt_Tax-notice_412.00EUR.pdf"] == b"%PDF secret tax.pdf"
    assert load_workbook(io.BytesIO(files["Tax_documents_2025/Overview_2025.xlsx"]))["Documents"].max_row == 8
    with pytest.raises(zip_aes.WrongPassword):
        zip_aes.read(archive, "wrong horse!")


def test_aes_counter_mode_matches_the_winzip_format():
    """Counter blocks are little-endian from 1 (WinZip AE): the first key-stream block is AES(key, 01 00 .. 00)."""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    key = bytes(range(32))
    first = Cipher(algorithms.AES(key), modes.ECB()).encryptor().update((1).to_bytes(16, "little"))
    second = Cipher(algorithms.AES(key), modes.ECB()).encryptor().update((2).to_bytes(16, "little"))
    assert zip_aes.ctr_xor(key, bytes(32)) == first + second
    data = bytes(range(256)) * 300   # more than one batch of counter blocks
    assert zip_aes.ctr_xor(key, zip_aes.ctr_xor(key, data)) == data
    aes, mac, check = zip_aes.derive(b"pw", b"\x00" * 16)
    assert len(aes) == 32 and len(mac) == 32 and len(check) == 2


# ---------------------------------------------------------------- the optional model helper

def test_model_only_suggests_for_letters_the_rules_put_into_other():
    rows = _included("en")
    asked = []

    def ask(messages):
        asked.append(messages[1]["content"])
        return "Work." if "ACME" in messages[1]["content"] else "banana"

    texts = {r["key"]: LETTERS[r["filename"]][1] for r in rows}
    got = tax_pack.model_suggestions(rows, texts.get, ask)
    acme = next(r for r in rows if r["filename"] == "acme.pdf")
    assert got == {acme["key"]: "work"}          # "banana" for the receipt is dropped
    assert len(asked) == 2 and all("Finanzamt" not in a for a in asked)   # rows the rules placed are never sent


def test_model_failure_keeps_the_rules():
    rows = _included("en")

    def ask(_):
        raise ConnectionError("no model")

    assert tax_pack.model_suggestions(rows, lambda k: "text", ask) == {}


# ---------------------------------------------------------------- the API

def _user(tmp_path, names):
    uname = f"tax_{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        user = models.User(username=uname, hashed_password=get_password_hash("x" * 12))
        db.add(user)
        db.commit()
        ws = models.Workspace(name="Post", user_id=user.id)
        other = models.Workspace(name="Work", user_id=user.id)
        db.add_all([ws, other])
        db.commit()
        docs = []
        for name in names:
            added, text = LETTERS[name]
            path = tmp_path / f"{uuid.uuid4().hex[:6]}_{name}"
            path.write_bytes(b"%PDF-1.4 " + name.encode())
            doc = models.Document(workspace_id=ws.id, filename=name, filepath=str(path), file_type=name.rsplit(".", 1)[1],
                                  status="indexed", created_at=__import__("datetime").datetime.fromisoformat(f"{added}T10:00:00"))
            db.add(doc)
            db.commit()
            docs.append((doc.id, str(path), text))
        ids = (user.id, ws.id, other.id)
    finally:
        db.close()
    col = rag_service.get_or_create_collection(ids[1], ids[0])
    for _, path, text in docs:
        col.add(ids=[uuid.uuid4().hex], documents=[text], metadatas=[{"source": path, "page": 0, "chunk": 1}],
                embeddings=[[1.0, 0.0]])
    return ids, {"Authorization": f"Bearer {create_access_token({'sub': uname})}"}, {n: d[0] for n, d in zip(names, docs)}


def _drop(ids):
    rag_service.chroma_client.delete_collection(f"user_{ids[0]}_workspace_{ids[1]}")


def test_api_preview_and_export(tmp_path):
    names = ["tax.pdf", "bill.pdf", "scam.pdf", "tax_photo.jpg", "old.pdf", "pay.pdf"]
    ids, headers, doc_ids = _user(tmp_path, names)
    try:
        prev = client.post("/api/v1/taxpack/preview", headers=headers,
                           json={"year": 2025, "workspaces": [ids[1]], "lang": "de"}).json()
        assert prev["years"] == [2025, 2024] and prev["package"] == "Steuerunterlagen_2025.zip"
        assert [c["name"] for c in prev["categories"]] == ["Steuer", "Versicherung", "Wohnen", "Arbeit", "Gesundheit", "Sonstiges"]
        rows = {r["filename"]: r for r in prev["rows"]}
        assert set(rows) == {"tax.pdf", "bill.pdf", "scam.pdf", "tax_photo.jpg", "pay.pdf"}
        assert rows["scam.pdf"]["excluded_reason"] == "scam" and rows["tax_photo.jpg"]["excluded_reason"] == "duplicate"

        # another user's workspace id is ignored
        assert client.post("/api/v1/taxpack/preview", headers=headers,
                           json={"year": 2025, "workspaces": [999999], "lang": "de"}).json()["rows"] == []

        res = client.post("/api/v1/taxpack/export", headers=headers, json={
            "year": 2025, "workspaces": [ids[1]], "lang": "de",
            "overrides": [{"key": f"ws-{doc_ids['bill.pdf']}", "category": "other"},
                          {"key": f"ws-{doc_ids['pay.pdf']}", "included": False}]})
        assert res.status_code == 200 and res.headers["content-type"] == "application/zip"
        assert "Steuerunterlagen_2025.zip" in res.headers["content-disposition"]
        z = zipfile.ZipFile(io.BytesIO(res.content))
        names_in = z.namelist()
        assert "Steuerunterlagen_2025/Sonstiges/2025-05-15_Stadtwerke-Rheinstadt_Rechnung_96.50EUR.pdf" in names_in
        assert z.read("Steuerunterlagen_2025/Steuer/2025-03-10_Finanzamt-Rheinstadt_Steuerbescheid_412.00EUR.pdf") == b"%PDF-1.4 tax.pdf"
        assert not any("Muster" in n or "LT73" in n for n in names_in)
        assert res.headers["x-package-documents"] == "2"

        short = client.post("/api/v1/taxpack/export", headers=headers,
                            json={"year": 2025, "workspaces": [ids[1]], "password": "short"})
        assert short.status_code == 422
        locked = client.post("/api/v1/taxpack/export", headers=headers,
                             json={"year": 2025, "workspaces": [ids[1]], "lang": "en", "password": "a long secret"})
        assert locked.status_code == 200
        assert any(n.endswith(".xlsx") for n in zip_aes.read(locked.content, "a long secret"))
        empty = client.post("/api/v1/taxpack/export", headers=headers, json={"year": 2019, "workspaces": [ids[1]]})
        assert empty.status_code == 422
    finally:
        _drop(ids)


def test_api_model_suggestion_is_kept_apart_from_the_rules(tmp_path, monkeypatch):
    from app.api import tax_pack as api
    asked = []

    def fake(messages):
        asked.append(messages[1]["content"])
        return "housing"

    monkeypatch.setattr(api, "_ask_local_model", fake)
    ids, headers, doc_ids = _user(tmp_path, ["tax.pdf", "acme.pdf"])
    try:
        body = {"year": 2025, "workspaces": [ids[1]], "lang": "en"}
        plain = client.post("/api/v1/taxpack/preview", headers=headers, json=body).json()
        assert not asked and plain["model_used"] is False
        prev = client.post("/api/v1/taxpack/preview", headers=headers, json={**body, "suggest": True}).json()
        rows = {r["filename"]: r for r in prev["rows"]}
        assert len(asked) == 1 and "ACME" in asked[0]
        assert rows["acme.pdf"]["category"] == "other" and rows["acme.pdf"]["suggested"] == "housing"
        assert "suggested" not in rows["tax.pdf"] and prev["model_used"] is True
        res = client.post("/api/v1/taxpack/export", headers=headers, json={
            **body, "overrides": [{"key": f"ws-{doc_ids['acme.pdf']}", "category": "housing", "source": "model"}]})
        z = zipfile.ZipFile(io.BytesIO(res.content))
        assert any(n.startswith("Tax_documents_2025/Housing/2025-08-01_ACME") for n in z.namelist())
        summary = DocxDocument(io.BytesIO(z.read("Tax_documents_2025/Summary_2025.docx")))
        assert "suggestions of a local AI model" in "\n".join(p.text for p in summary.paragraphs)
    finally:
        _drop(ids)


def test_api_needs_login():
    assert client.post("/api/v1/taxpack/preview", json={"year": 2025}).status_code == 401
