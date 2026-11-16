"""Settings of the OCR: which languages photos and scans are read in, and language packs on request.

Everyone may look; changing the languages or downloading a pack is for the instance administrator (the OCR is shared
by all accounts of this installation, like the backup)."""
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.api.auth import get_current_user
from app.api.system import require_admin
from app.db import models
from app.services import ocr_languages
from app.services.ocr_service import ocr_service

router = APIRouter()
logger = logging.getLogger(__name__)


class LanguagesRequest(BaseModel):
    languages: list[str]


def _overview() -> dict:
    status = ocr_service.status()
    installed = set(status.get("installed", [])) if status["available"] else set()
    downloaded = set(ocr_languages.downloaded())
    return {
        "available": status["available"],
        "version": status.get("version"),
        "languages": status["languages"],          # what is read with now
        "wanted": ocr_service.wanted,              # what the user chose (a missing one is listed in "missing")
        "missing": status.get("missing", []),
        "max_languages": ocr_languages.MAX_LANGUAGES,
        "catalog": [{"code": code, "name": name, "installed": code in installed,
                     "bundled": code in ocr_languages.BUNDLED, "downloaded": code in downloaded}
                    for code, name in ocr_languages.CATALOG.items()],
    }


@router.get("/languages")
def get_languages(current_user: models.User = Depends(get_current_user)):
    return _overview()


@router.put("/languages")
def set_languages(req: LanguagesRequest, current_user: models.User = Depends(require_admin)):
    codes = ocr_languages.clean(req.languages)
    if not codes:
        raise HTTPException(status_code=400, detail="Choose at least one language.")
    if len(codes) > ocr_languages.MAX_LANGUAGES:
        raise HTTPException(status_code=400, detail=f"Choose at most {ocr_languages.MAX_LANGUAGES} languages.")
    not_installed = [c for c in codes if c not in set(ocr_service.status().get("installed", []))]
    if not_installed:
        raise HTTPException(status_code=409, detail=f"Not installed yet: {', '.join(not_installed)}. Download the language first.")
    ocr_languages.save(codes)
    ocr_service.reset()
    return _overview()


@router.post("/languages/{code}/install")
def install_language(code: str, current_user: models.User = Depends(require_admin)):
    if not ocr_languages.valid_code(code):
        raise HTTPException(status_code=404, detail="This language is not offered.")
    if not ocr_service.available:
        raise HTTPException(status_code=409, detail="Text recognition (Tesseract) is not available on this installation.")
    try:
        ocr_languages.install(code)
    except Exception as e:
        logger.warning(f"OCR: language pack {code} could not be downloaded: {e}")
        raise HTTPException(status_code=502, detail=f"The language pack could not be downloaded ({e}). Check the internet connection and try again.")
    ocr_service.reset()
    return _overview()


@router.delete("/languages/{code}")
def remove_language(code: str, current_user: models.User = Depends(require_admin)):
    try:
        ocr_languages.remove(code)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    ocr_service.reset()
    return _overview()
