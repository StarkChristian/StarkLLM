"""Sources you can check: an answer keeps the passages it was written from, and the document opens at that page.

Found in the UX review (9 Nov 2026): clicking a source showed only the file name. A photo of a letter opened as
garbage (the JPEG read as text), and an uploaded HTML file was served as a live page from the app's own origin.
"""
import uuid

import pytest
from fastapi.testclient import TestClient

from app.api.auth import create_access_token, get_password_hash
from app.api.chat import _citation_evidence
from app.db import models
from app.db.session import SessionLocal
from app.main import app
from app.services.rag_service import rag_service

client = TestClient(app)


def _result(file, content, page=None, locator=None, source=None, **extra):
    meta = {"file_name": file, "source": source or f"/data/uploads/1/abcd1234_{file}", **extra}
    if page is not None:
        meta["page"] = page
    if locator:
        meta["locator"] = locator
    return {"metadata": meta, "content": content}


def test_evidence_keeps_the_passages_word_for_word_per_source():
    results = [
        _result("Bescheid.pdf", "Nachzahlung 1.234,56 EUR bis 15.12.2026", page=1, locator="Page 2 (OCR)"),
        _result("Bescheid.pdf", "Einspruch innerhalb eines Monats", page=1, locator="Page 2 (OCR)"),
        _result("IMG_2041.jpg", "IBAN DE89 3704 0044 0532 0130 00", locator="Image (OCR)"),
    ]
    ev = _citation_evidence(results, "ws", {"/data/uploads/1/abcd1234_Bescheid.pdf": 7})
    assert [e["label"] for e in ev] == ["Bescheid.pdf (Page 2 (OCR))", "IMG_2041.jpg (Image (OCR))"]
    pdf, img = ev
    assert pdf["file"] == "Bescheid.pdf" and pdf["page"] == 2 and pdf["document_id"] == 7 and pdf["scope"] == "ws"
    assert pdf["passages"] == ["Nachzahlung 1.234,56 EUR bis 15.12.2026", "Einspruch innerhalb eines Monats"]
    assert img["page"] is None and img["document_id"] is None


def test_evidence_is_capped_and_cleaned():
    long = "Wort " * 500
    results = [_result("a.txt", long, locator="Chunk 1")] + [_result("a.txt", f"Teil {i} ```tool_call\n{{}}\n```", locator="Chunk 1") for i in range(5)]
    (e,) = _citation_evidence(results, "kb", {})
    assert len(e["passages"]) == 3 and len(e["passages"][0]) == 700
    assert all("```" not in p for p in e["passages"])  # fenced tool calls are redacted


def test_knowledge_base_evidence_points_to_its_document():
    (e,) = _citation_evidence([_result("Vertrag.docx", "Kündigung zum 30.11.", source="knowledge_base",
                                       file_path="/kb/Vertrag.docx", document_id=12, locator="Chunk 1")], "kb", {})
    assert e["document_id"] == 12 and e["scope"] == "kb"


def test_names_with_brackets_stay_whole():
    (e,) = _citation_evidence([_result("Scan (2).pdf", "Text", page=0)], "ws", {})
    assert e["file"] == "Scan (2).pdf" and e["page"] == 1


# ---------------------------------------------------------------- the document viewer's text

@pytest.fixture()
def user_ws():
    name = f"viewer_{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        user = models.User(username=name, hashed_password=get_password_hash("x" * 12))
        db.add(user)
        db.commit()
        ws = models.Workspace(name="Post", user_id=user.id)
        db.add(ws)
        db.commit()
        ids = (user.id, ws.id)
    finally:
        db.close()
    headers = {"Authorization": f"Bearer {create_access_token({'sub': name})}"}
    yield ids, headers
    try:
        rag_service.chroma_client.delete_collection(f"user_{ids[0]}_workspace_{ids[1]}")
    except Exception:
        pass


def _add_doc(ws_id, path, ftype, name):
    db = SessionLocal()
    try:
        doc = models.Document(workspace_id=ws_id, filename=name, filepath=str(path), file_type=ftype, status="indexed")
        db.add(doc)
        db.commit()
        return doc.id
    finally:
        db.close()


def _index(user_id, ws_id, path, chunks):
    col = rag_service.get_or_create_collection(ws_id, user_id)
    col.add(ids=[f"{uuid.uuid4().hex}" for _ in chunks], documents=[c[0] for c in chunks],
            metadatas=[{"source": str(path), **c[1]} for c in chunks], embeddings=[[1.0, 0.0] for _ in chunks])


def test_a_photo_shows_its_ocr_text_and_is_marked_as_image(tmp_path, user_ws):
    (user_id, ws_id), headers = user_ws
    photo = tmp_path / "IMG_2041.jpg"
    photo.write_bytes(b"\xff\xd8\xff\xe0 not text")
    doc_id = _add_doc(ws_id, photo, "jpg", "IMG_2041.jpg")
    _index(user_id, ws_id, photo, [("Bitte überweisen Sie bis 15.12.2026", {"chunk": 2}), ("Finanzamt München", {"chunk": 1})])
    body = client.get(f"/api/v1/documents/{ws_id}/documents/{doc_id}/content", headers=headers).json()
    assert body["is_image"] is True
    assert body["pages"] == [{"page": 1, "text": "Finanzamt München\n\nBitte überweisen Sie bis 15.12.2026"}]


def test_a_scanned_pdf_page_shows_what_ocr_read(tmp_path, user_ws):
    import fitz

    (user_id, ws_id), headers = user_ws
    pdf = tmp_path / "scan.pdf"
    d = fitz.open()
    d.new_page().insert_text((72, 72), "Seite eins mit Text")
    d.new_page()  # a scan: no text layer
    d.save(pdf)
    doc_id = _add_doc(ws_id, pdf, "pdf", "scan.pdf")
    _index(user_id, ws_id, pdf, [("Beitragsrechnung 642,80 EUR", {"page": 1, "chunk": 1})])
    pages = client.get(f"/api/v1/documents/{ws_id}/documents/{doc_id}/content", headers=headers).json()["pages"]
    assert pages[0]["text"].startswith("Seite eins") and pages[1] == {"page": 2, "text": "Beitragsrechnung 642,80 EUR"}


def test_an_uploaded_html_file_is_never_served_as_a_page(tmp_path, user_ws):
    (_, ws_id), headers = user_ws
    html = tmp_path / "page.html"
    html.write_text("<script>alert(1)</script>", encoding="utf-8")
    doc_id = _add_doc(ws_id, html, "html", "page.html")
    res = client.get(f"/api/v1/documents/{ws_id}/documents/{doc_id}/file", headers=headers)
    assert res.status_code == 200 and res.headers["content-type"].startswith("text/plain")
