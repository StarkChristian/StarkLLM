"""2.7, option 5: the "Document health" view (services/document_health.py and its endpoint)."""
import zipfile

import pymupdf as fitz
import pytest

from app.services import document_health as dh
from app.services import untrusted


def meta(page=None, **kw):
    m = {"source": "/data/uploads/x.pdf", "chunk": 1, **kw}
    if page is not None:
        m["page"] = page - 1  # stored 0-based
    return m


LONG = "Der Mietvertrag beginnt am 1. Januar 2027. Die Kaltmiete beträgt 950 EUR im Monat. " * 3


def test_a_good_pdf_has_no_warnings():
    passages = [(LONG, meta(1)), (LONG, meta(2))]
    h = dh.health(status="indexed", error_message=None, file_type="pdf", passages=passages,
                  file_info={"pages": 2, "encrypted": False, "table_pages": [], "tables_checked": 2})
    assert h["warnings"] == []
    assert h["pages"] == 2 and h["chunks"] == 2 and h["pages_with_text"] == 2
    assert h["text_preview"].startswith("Der Mietvertrag") and h["ocr"]["used"] is False


def test_empty_pages_and_little_text_are_named():
    h = dh.health(status="indexed", error_message=None, file_type="pdf", passages=[("Seite eins.", meta(1))],
                  file_info={"pages": 4})
    kinds = {w["kind"]: w for w in h["warnings"]}
    assert kinds["empty_pages"]["pages"] == [2, 3, 4] and kinds["empty_pages"]["count"] == 3
    assert kinds["little_text"]["chars"] == len("Seite eins.")


def test_ocr_pages_languages_and_confidence():
    passages = [(LONG, meta(1)), (LONG, meta(2, type="ocr", ocr_confidence=81.0, ocr_languages="deu+eng")),
                (LONG, meta(3, type="ocr", ocr_confidence=91.0, ocr_languages="tur+eng")),
                ("A photo of a stamp.", meta(4, type="vision_fallback"))]
    h = dh.health(status="indexed", error_message=None, file_type="pdf", passages=passages, file_info={"pages": 4})
    assert h["ocr"] == {"used": True, "pages": [2, 3], "languages": ["deu", "eng", "tur"], "languages_recorded": True,
                        "confidence": 86}
    assert h["vision_pages"] == [4]


def test_ocr_of_documents_indexed_before_the_languages_were_recorded():
    h = dh.health(status="indexed", error_message=None, file_type="png",
                  passages=[(LONG, {"source": "/x.png", "type": "ocr", "ocr_confidence": 70.0})])
    assert h["ocr"]["used"] and h["ocr"]["languages"] == [] and h["ocr"]["languages_recorded"] is False


def test_parse_error_and_encrypted_file():
    h = dh.health(status="failed", error_message="No text content could be extracted from 'x.pdf'", file_type="pdf",
                  passages=[], file_info={"pages": 3, "encrypted": True})
    kinds = [w["kind"] for w in h["warnings"]]
    assert kinds[:2] == ["parse_error", "encrypted"]
    assert "No text content" in h["warnings"][0]["detail"]
    assert h["chunks"] == 0 and h["text_preview"] == ""


def test_hidden_text_marker_is_reported_but_not_shown():
    text = LONG + "\n" + untrusted.hidden_marker(2)
    h = dh.health(status="indexed", error_message=None, file_type="txt", passages=[(text, {"chunk": 1})])
    assert {"kind": "hidden_text", "count": 2} in h["warnings"]
    assert "hidden text part" not in h["text_preview"]


def test_preview_is_in_page_order_and_cut():
    passages = [("B" * 1500, meta(2)), ("A" * 1500, meta(1))]
    h = dh.health(status="indexed", error_message=None, file_type="pdf", passages=passages, file_info={"pages": 2})
    assert h["text_preview"].startswith("A") and len(h["text_preview"]) == dh.PREVIEW_CHARS and h["preview_truncated"]


# ---- the file itself -----------------------------------------------------------------------------------------------
def test_inspect_pdf_finds_password_pages_and_tables(tmp_path):
    plain = tmp_path / "plain.pdf"
    doc = fitz.open()
    p = doc.new_page()
    p.insert_text((72, 72), "Rechnung")
    # a ruled 3x3 table
    for i in range(4):
        p.draw_line((72, 120 + 30 * i), (372, 120 + 30 * i))
        p.draw_line((72 + 100 * i, 120), (72 + 100 * i, 210))
    for r in range(3):
        for c in range(3):
            p.insert_text((80 + 100 * c, 140 + 30 * r), f"Z{r}S{c}")
    doc.new_page()
    doc.save(plain)
    info = dh.inspect_pdf(str(plain))
    assert info["pages"] == 2 and not info["encrypted"] and info["table_pages"] == [1]

    locked = tmp_path / "locked.pdf"
    doc.save(locked, encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="geheim", owner_pw="geheim2")
    info = dh.inspect_pdf(str(locked))
    assert info["encrypted"] is True


def _docx(path, body_xml):
    import docx
    d = docx.Document()
    d.add_paragraph("Hallo")
    d.save(path)
    with zipfile.ZipFile(path) as z:
        items = {n: z.read(n) for n in z.namelist()}
    xml = items["word/document.xml"].decode()
    xml = xml.replace("<w:body>", "<w:body>" + body_xml, 1)
    items["word/document.xml"] = xml.encode()
    with zipfile.ZipFile(path, "w") as z:
        for n, b in items.items():
            z.writestr(n, b)


def test_inspect_docx_finds_tracked_changes_and_tables(tmp_path):
    path = tmp_path / "brief.docx"
    _docx(path, '<w:p><w:ins w:id="1" w:author="A" w:date="2026-11-01T00:00:00Z"><w:r><w:t>neu</w:t></w:r></w:ins>'
                '<w:del w:id="2" w:author="A" w:date="2026-11-01T00:00:00Z"><w:r><w:delText>alt</w:delText></w:r></w:del></w:p>'
                '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>')
    info = dh.inspect_docx(str(path))
    assert info == {"encrypted": False, "tracked_changes": 2, "tables": 1, "error": ""}
    h = dh.health(status="indexed", error_message=None, file_type="docx", passages=[(LONG, {"chunk": 1})], file_info=info)
    kinds = {w["kind"]: w for w in h["warnings"]}
    assert kinds["tracked_changes"]["count"] == 2 and kinds["tables_flattened"]["count"] == 1


def test_a_password_protected_word_file_is_recognised(tmp_path):
    path = tmp_path / "geheim.docx"
    path.write_bytes(dh.OLE_MAGIC + b"\0" * 600)
    assert dh.inspect_docx(str(path))["encrypted"] is True
    assert dh.inspect_file(str(path), "docx")["encrypted"] is True


def test_other_types_and_missing_files_are_not_inspected(tmp_path):
    assert dh.inspect_file(str(tmp_path / "nope.pdf"), "pdf") == {}
    (tmp_path / "a.txt").write_text("x")
    assert dh.inspect_file(str(tmp_path / "a.txt"), "txt") == {}


def test_the_endpoint_is_registered():
    from app.api.documents import router
    assert any(getattr(r, "path", "") == "/{workspace_id}/documents/{document_id}/health" for r in router.routes)
