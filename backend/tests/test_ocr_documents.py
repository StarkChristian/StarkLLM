"""Phase B1: photos of letters and scanned pages are read as German and English text on this computer.

Before: photos were only described by the vision model (a multi-GB download, slow, no exact wording), scanned PDF
pages were rendered at 72 DPI and read with English data only, and folders in the knowledge base had no OCR at all.
"""
import os
import sys

import pytest
from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.services import ocr_service as O
from app.services import rag_service as rag_module
from app.services.rag_service import rag_service
from app.services.kb_service import KBService

LETTER = [
    "Finanzamt München",
    "Deggendorfer Straße 12, 80331 München",
    "",
    "Bescheid über Einkommensteuer 2025",
    "Steuernummer: 143/215/60871",
    "Datum: 03.11.2026",
    "",
    "Sehr geehrte Frau Müller,",
    "die festgesetzte Nachzahlung beträgt 1.234,56 EUR.",
    "Bitte überweisen Sie den Betrag bis zum 15.12.2026",
    "auf das Konto IBAN DE89 3704 0044 0532 0130 00.",
    "Gegen diesen Bescheid können Sie innerhalb eines Monats",
    "nach Bekanntgabe Einspruch einlegen.",
]


def _font(size):
    for path in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"):
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size=size)


def letter_image(width=1700, height=2200, size=34, background=255):
    img = Image.new("L", (width, height), background)
    draw = ImageDraw.Draw(img)
    font = _font(size)
    y = 160
    for line in LETTER:
        draw.text((140, y), line, fill=20, font=font)
        y += int(size * 1.8)
    return img


def phone_photo(img):
    """Roughly what a phone camera gives: smaller, a little blurred, grey paper, colour, tilted by the hand."""
    photo = img.resize((img.width * 2 // 3, img.height * 2 // 3)).filter(ImageFilter.GaussianBlur(0.8))
    photo = photo.point(lambda v: int(70 + v * 0.65))  # grey paper, weak contrast
    return photo.rotate(1.5, expand=True, fillcolor=110).convert("RGB")


def _status():
    return O.OcrService().status()


# Skipped where Tesseract is not installed (a developer PC); CI sets STARKLLM_REQUIRE_OCR so these always run there.
needs_german_ocr = pytest.mark.skipif(
    not (_status()["available"] and "deu" in _status()["languages"]) and not os.getenv("STARKLLM_REQUIRE_OCR"),
    reason="Tesseract with German language data is not installed",
)


@pytest.fixture()
def no_vision(monkeypatch):
    """OCR must not fall back to the (multi-GB) vision model for a readable letter."""
    def refuse(*a, **k):
        raise AssertionError("the vision model was asked although the page has readable text")
    monkeypatch.setattr("app.services.vision_service.vision_service.generate_image_description", refuse)


@pytest.fixture()
def plain_chunks(monkeypatch):
    """Chunking without the embedding model (Ollama is not running in tests)."""
    monkeypatch.setattr(rag_service, "_semantic_chunk_text", lambda text: [p for p in text.split("\n\n") if p.strip()])


def _text(pages):
    return "\n".join(p.text for p in pages)


# ---------------------------------------------------------------- with Tesseract and German language data

@needs_german_ocr
def test_a_photo_of_a_german_letter_is_read_with_umlauts_amounts_and_dates(tmp_path, no_vision):
    path = tmp_path / "brief.jpg"
    phone_photo(letter_image()).save(path, quality=85)
    pages = O.OcrService().text_of_picture(str(path))
    assert len(pages) == 1 and pages[0].method == "ocr"
    text = _text(pages)
    for expected in ("Einkommensteuer", "Straße", "beträgt", "1.234,56", "15.12.2026", "143/215/60871", "Einspruch"):
        assert expected in text, (expected, text)
    assert pages[0].confidence >= 70


@needs_german_ocr
def test_a_photo_taken_sideways_is_turned_upright_before_reading(tmp_path, no_vision):
    path = tmp_path / "quer.png"
    letter_image().rotate(90, expand=True).save(path)
    svc = O.OcrService()
    result = svc.read_image(Image.open(path))
    assert result.rotated in (90, 270)
    assert "Einkommensteuer" in result.text and "15.12.2026" in result.text


def test_the_tilt_of_a_hand_held_photo_is_measured():
    page = letter_image()
    assert O.OcrService.skew_angle(page) == 0.0
    assert O.OcrService.skew_angle(page.rotate(6, expand=True, fillcolor=255)) == pytest.approx(-6, abs=0.3)
    assert O.OcrService.skew_angle(page.rotate(-2.5, expand=True, fillcolor=255)) == pytest.approx(2.5, abs=0.3)
    assert O.OcrService.skew_angle(Image.new("L", (800, 1000), 255)) == 0.0  # blank paper


@needs_german_ocr
def test_a_tilted_photo_loses_no_words(tmp_path, no_vision):
    result = O.OcrService().read_image(letter_image().rotate(5, expand=True, fillcolor=255))
    for expected in ("beträgt", "1.234,56", "DE89 3704 0044 0532 0130 00"):
        assert expected in result.text


@needs_german_ocr
def test_a_scanned_pdf_page_is_read_and_cited_by_page(tmp_path, no_vision, plain_chunks):
    import fitz

    scan = tmp_path / "scan.png"
    letter_image().save(scan)
    pdf = tmp_path / "bescheid.pdf"
    doc = fitz.open()
    doc.new_page()  # page 1 has no text at all: it must not stop page 2
    page = doc.new_page(width=595, height=842)
    page.insert_image(page.rect, filename=str(scan))
    doc.save(pdf)
    assert fitz.open(pdf)[1].get_text().strip() == ""  # no text layer: a real scan

    chunks, metas, ids = rag_service._process_file_to_chunks(str(pdf))
    assert "1.234,56" in " ".join(chunks)
    assert all(m["locator"] == "Page 2 (OCR)" and m["page"] == 1 and m["type"] == "ocr" for m in metas)
    assert len(ids) == len(set(ids))


@needs_german_ocr
def test_a_multi_page_fax_tiff_keeps_its_page_numbers(tmp_path, no_vision, plain_chunks):
    first = letter_image()
    second = Image.new("L", first.size, 255)
    ImageDraw.Draw(second).text((140, 200), "Anlage: Berechnung der Einkünfte für 2025 und Zinsen nach § 233a AO", fill=0, font=_font(34))
    path = tmp_path / "fax.tif"
    first.save(path, save_all=True, append_images=[second], compression="tiff_lzw")

    chunks, metas, _ = rag_service._process_file_to_chunks(str(path))
    by_page = {}
    for c, m in zip(chunks, metas):
        by_page.setdefault(m["locator"], []).append(c)
    assert "15.12.2026" in " ".join(by_page["Page 1 (OCR)"])
    assert "Einkünfte" in " ".join(by_page["Page 2 (OCR)"])


@needs_german_ocr
def test_a_knowledge_base_photo_is_read_by_ocr(tmp_path, no_vision, plain_chunks):
    path = tmp_path / "brief.webp"
    phone_photo(letter_image()).save(path)
    pages = O.ocr_service.text_of_picture(str(path))
    chunks, metas, ids = [], [], []
    count = KBService._add_picture_text(chunks, metas, ids, pages[0], {"source": "knowledge_base", "document_id": 7},
                                        "kb_doc_7_x", "Image", 0)
    assert count == len(chunks) > 0 and "Einkommensteuer" in " ".join(chunks)
    assert metas[0]["locator"] == "Image (OCR)" and metas[0]["document_id"] == 7 and "page" not in metas[0]


# ---------------------------------------------------------------- without Tesseract

def test_without_tesseract_a_picture_goes_to_the_vision_model(tmp_path, monkeypatch):
    svc = O.OcrService()
    monkeypatch.setattr(svc, "status", lambda: {"available": False, "languages": [], "missing": ["deu", "eng"]})
    seen = []

    def describe(path, prompt=None):
        with Image.open(path) as img:
            seen.append(img.size)
        return "A tram stop at night"

    monkeypatch.setattr("app.services.vision_service.vision_service.generate_image_description", describe)
    path = tmp_path / "foto.jpg"
    Image.new("RGB", (4000, 3000), (30, 60, 90)).save(path)
    pages = svc.text_of_picture(str(path))
    assert [(p.method, p.text) for p in pages] == [("vision", "A tram stop at night")]
    assert max(seen[0]) <= O.VISION_LONG_SIDE  # the vision model gets a small copy, not the 12 MP original


def test_a_picture_without_text_goes_to_the_vision_model(tmp_path, monkeypatch):
    svc = O.OcrService()
    monkeypatch.setattr(svc, "status", lambda: {"available": True, "languages": ["eng"], "orientation": False})
    monkeypatch.setattr(svc, "_read", lambda img: O.OcrResult(text="~ ., -", confidence=12.0))
    monkeypatch.setattr("app.services.vision_service.vision_service.generate_image_description",
                        lambda path, prompt=None: "A bar chart of monthly costs")
    path = tmp_path / "chart.png"
    Image.new("RGB", (800, 600), "white").save(path)
    assert [p.method for p in svc.text_of_picture(str(path))] == ["vision"]


def test_missing_language_data_is_reported_and_skipped(monkeypatch):
    class FakeTess:
        @staticmethod
        def get_tesseract_version():
            return "5.5.0"

        @staticmethod
        def get_languages(config=""):
            return ["eng", "osd"]

    monkeypatch.setattr(O, "_tesseract", lambda: FakeTess)
    status = O.OcrService("deu+eng").status()
    assert status["available"] and status["languages"] == ["eng"] and status["missing"] == ["deu"]


def test_lines_and_paragraphs_are_rebuilt_from_tesseract_words(monkeypatch):
    class FakeTess:
        class Output:
            DICT = "dict"

        @staticmethod
        def image_to_data(img, lang, config, output_type):
            return {
                "text": ["Bescheid", "2025", "", "Frist:", "15.12.2026", "Anlage"],
                "conf": [95, 90, -1, 88, 93, 80],
                "block_num": [1, 1, 1, 1, 1, 2],
                "par_num": [1, 1, 1, 1, 1, 1],
                "line_num": [1, 1, 1, 2, 2, 1],
            }

    monkeypatch.setattr(O, "_tesseract", lambda: FakeTess)
    svc = O.OcrService()
    monkeypatch.setattr(svc, "status", lambda: {"available": True, "languages": ["deu", "eng"]})
    result = svc._read(Image.new("L", (10, 10)))
    assert result.text == "Bescheid 2025\nFrist: 15.12.2026\n\nAnlage"
    assert result.confidence == pytest.approx(89.2)


def test_pictures_are_prepared_for_tesseract():
    svc = O.OcrService()
    small = svc.prepare(Image.new("RGBA", (600, 800), (0, 0, 0, 0)))
    assert small.mode == "L" and max(small.size) == O.MIN_LONG_SIDE
    assert small.getpixel((5, 5)) == 255  # a transparent background becomes white paper, not black
    huge = svc.prepare(Image.new("RGB", (8000, 6000), "white"))
    assert max(huge.size) == O.MAX_LONG_SIDE


def test_photos_and_tiff_scans_can_be_uploaded_and_watched():
    from app.services.kb_service import SUPPORTED_EXTENSIONS

    assert {".webp", ".tif", ".tiff"} <= SUPPORTED_EXTENSIONS
    src = open(os.path.join(os.path.dirname(__file__), "..", "app", "api", "documents.py"), encoding="utf-8").read()
    assert "'webp', 'tif', 'tiff'" in src


def test_health_reports_whether_ocr_works():
    from fastapi.testclient import TestClient
    from app.main import app

    body = TestClient(app).get("/health").json()
    assert set(body["ocr"]) == {"available", "languages"}
