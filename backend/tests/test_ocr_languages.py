"""OCR languages chosen by the user, and language packs downloaded on request, without touching the bundled English
and German data."""
import os
import shutil

import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app.api.auth import get_current_user
from app.api.system import require_admin
from app.main import app
from app.services import ocr_languages as L
from app.services.ocr_service import OcrService, ocr_service

from test_ocr_documents import LETTER, letter_image, _font

client = TestClient(app)
needs_tesseract = pytest.mark.skipif(not ocr_service.status()["available"] and not os.getenv("STARKLLM_REQUIRE_OCR"),
                                     reason="Tesseract is not installed here")


@pytest.fixture()
def folder(tmp_path, monkeypatch):
    monkeypatch.setenv("OCR_DATA_DIR", str(tmp_path / "data" / "tessdata"))
    ocr_service.reset()
    yield tmp_path / "data" / "tessdata"
    ocr_service.reset()


def _pack(size=200_000):
    return b"\0" * size


def test_the_default_is_english_and_german(folder):
    assert L.configured() == ["eng", "deu"]


def test_only_known_codes_are_taken_and_a_path_is_never_one(folder):
    assert L.clean(["FRA", "fra", "../../etc/passwd", "xx", "", "chi_sim", "eng/../deu"]) == ["fra", "chi_sim"]
    assert not L.valid_code("../x") and not L.valid_code("fra.traineddata") and not L.valid_code("zzz")


def test_the_choice_is_kept_and_limited(folder):
    assert L.save(["tur", "eng"]) == ["tur", "eng"]
    assert L.configured() == ["tur", "eng"]
    assert len(L.save(["eng", "deu", "fra", "spa", "ita", "tur"])) == L.MAX_LANGUAGES
    with pytest.raises(ValueError):
        L.save(["nonsense"])


def test_a_pack_is_downloaded_only_when_asked_and_checked(folder):
    asked = []
    assert L.install("fra", lambda url: (asked.append(url), _pack())[1]) == "fra"
    assert asked == ["https://github.com/tesseract-ocr/tessdata_fast/raw/main/fra.traineddata"]
    assert L.downloaded() == ["fra"] and (folder / "fra.traineddata").exists()
    with pytest.raises(RuntimeError):
        L.install("spa", lambda url: b"<html>not found</html>")  # an error page is not a language file
    with pytest.raises(ValueError):
        L.install("../evil", lambda url: _pack())
    assert not (folder / "spa.traineddata").exists() and L.downloaded() == ["fra"]


def test_a_removed_pack_leaves_the_choice_valid(folder):
    L.install("tur", lambda url: _pack())
    L.save(["tur", "eng"])
    L.remove("tur")
    assert L.downloaded() == [] and L.configured() == ["eng"]
    with pytest.raises(ValueError):
        L.remove("eng")  # bundled data is not the user's to remove


@needs_tesseract
def test_a_downloaded_pack_does_not_break_the_bundled_languages(folder):
    base = L.bundled_dir(ocr_service_cmd())
    assert base and os.path.exists(os.path.join(base, "eng.traineddata"))
    before = os.path.getsize(os.path.join(base, "eng.traineddata"))
    # stand in for a French pack with the English data (a real one is a download of a few MB)
    with open(os.path.join(base, "eng.traineddata"), "rb") as f:
        L.install("fra", lambda url: f.read())
    ocr = OcrService("eng+deu+fra")
    status = ocr.status()
    assert {"eng", "deu", "fra"} <= set(status["languages"]) and status["orientation"]
    text = ocr.read_image(letter_image()).text
    assert "Einkommensteuer" in text and "1.234,56" in text  # German still read
    assert os.path.getsize(os.path.join(base, "eng.traineddata")) == before  # the bundled file is untouched
    L.remove("fra")
    ocr.reset()
    assert OcrService("eng+deu").status()["languages"] == ["eng", "deu"]


def ocr_service_cmd():
    from app.services.ocr_service import _tesseract
    return _tesseract().pytesseract.tesseract_cmd


# ---- the API

@pytest.fixture()
def admin():
    app.dependency_overrides[require_admin] = lambda: object()
    app.dependency_overrides[get_current_user] = lambda: object()
    yield
    app.dependency_overrides.clear()


def test_the_languages_can_be_listed_chosen_and_downloaded(admin, folder, monkeypatch):
    listing = client.get("/api/v1/ocr/languages").json()
    codes = {c["code"]: c for c in listing["catalog"]}
    assert listing["wanted"] == ["eng", "deu"] and codes["fra"]["installed"] is False and codes["eng"]["bundled"] is True
    # a language that is not installed cannot be chosen before it is downloaded
    r = client.put("/api/v1/ocr/languages", json={"languages": ["eng", "tur"]})
    assert r.status_code == 409 and "Download" in r.json()["detail"]
    assert client.put("/api/v1/ocr/languages", json={"languages": []}).status_code == 400
    assert client.post("/api/v1/ocr/languages/../install").status_code in (404, 405)
    assert client.post("/api/v1/ocr/languages/klingon/install").status_code == 404
    if ocr_service.available:
        monkeypatch.setattr(L, "fetch", lambda url: _pack())
        assert client.post("/api/v1/ocr/languages/tur/install").status_code == 200
        r = client.put("/api/v1/ocr/languages", json={"languages": ["eng", "tur"]})
        assert r.status_code == 200 and r.json()["wanted"] == ["eng", "tur"]
        assert client.delete("/api/v1/ocr/languages/tur").json()["wanted"] == ["eng"]
        assert client.delete("/api/v1/ocr/languages/eng").status_code == 400


def test_changing_the_languages_needs_the_administrator(folder):
    assert client.put("/api/v1/ocr/languages", json={"languages": ["eng"]}).status_code in (401, 403)
    assert client.post("/api/v1/ocr/languages/fra/install").status_code in (401, 403)


def test_english_is_read_last_so_umlauts_survive():
    """With "eng+deu" Tesseract read "Bescheid über" as "Bescheid Uber" (English is the main language then)."""
    from app.services.ocr_service import tesseract_lang
    assert tesseract_lang(["eng", "deu"]) == "deu+eng"
    assert tesseract_lang(["eng", "fra", "deu"]) == "fra+deu+eng"
    assert tesseract_lang(["deu", "tur"]) == "deu+tur"
    assert tesseract_lang(["eng"]) == "eng"
    assert tesseract_lang([]) == ""

