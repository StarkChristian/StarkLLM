"""Local OCR for photos and scanned pages.

Everything runs on this computer with Tesseract. Photos of letters and scanned pages are read as text in German
and English; the vision model is only asked when a picture has no readable text (a photo of a scene, a diagram).
"""
import logging
import os
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from typing import List, Optional

from PIL import Image, ImageOps, ImageSequence

from app.core.config import settings

logger = logging.getLogger(__name__)

PICTURE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"}

# A page counts as read when it has this much text at this mean word confidence (0-100).
MIN_TEXT_CHARS = 50
MIN_CONFIDENCE = 45.0
# Tesseract reads best at about 300 DPI: an A4 page is then about 2500 x 3500 pixels.
PDF_DPI = 300
MIN_LONG_SIDE = 2000
MAX_LONG_SIDE = 4200
VISION_LONG_SIDE = 1600
# Tilt of a hand-held photo that is straightened before reading (degrees).
MAX_SKEW = 10
MIN_SKEW = 0.3
# Tesseract's orientation guess is only used when it is at least this sure.
MIN_ORIENTATION_CONFIDENCE = 2.0

SCANNED_PAGE_PROMPT = (
    "This is a scanned page. Transcribe all text on it exactly, keeping names, dates, amounts and reference "
    "numbers. Then describe anything that is not text, such as stamps, signatures, tables or pictures."
)


@dataclass
class OcrResult:
    text: str
    confidence: float  # mean word confidence, 0-100
    rotated: int = 0  # degrees the picture was turned before reading

    @property
    def readable(self) -> bool:
        return len(self.text.strip()) >= MIN_TEXT_CHARS and self.confidence >= MIN_CONFIDENCE


@dataclass
class PageText:
    text: str
    method: str  # "ocr" or "vision"
    page: int = 0  # 0-based page within the file
    confidence: Optional[float] = None


def _tesseract():
    import pytesseract

    # The engine without Docker brings its own Tesseract; the desktop app passes its path.
    cmd = os.getenv("STARKLLM_TESSERACT")
    if cmd:
        pytesseract.pytesseract.tesseract_cmd = cmd
    return pytesseract


class OcrService:
    def __init__(self, languages: Optional[str] = None):
        self.wanted = [l for l in (languages or settings.OCR_LANGUAGES).split("+") if l]
        self._status = None
        self._lock = threading.Lock()

    def status(self) -> dict:
        """Whether OCR works here and which languages it reads. Checked once."""
        with self._lock:
            if self._status is None:
                self._status = self._check()
            return dict(self._status)

    def _check(self) -> dict:
        try:
            tess = _tesseract()
            version = str(tess.get_tesseract_version())
            installed = set(tess.get_languages(config=""))
        except Exception as e:  # not installed, not runnable
            logger.warning(f"OCR: Tesseract is not available ({e}); pictures are read by the vision model only")
            return {"available": False, "version": None, "languages": [], "missing": list(self.wanted)}
        languages = [l for l in self.wanted if l in installed]
        missing = [l for l in self.wanted if l not in installed]
        if missing:
            logger.warning(f"OCR: language data missing for {', '.join(missing)}; reading with {languages or ['eng']}")
        return {"available": True, "version": version, "languages": languages or ["eng"], "missing": missing,
                "orientation": "osd" in installed}

    @property
    def available(self) -> bool:
        return self.status()["available"]

    def prepare(self, img: Image.Image) -> Image.Image:
        """Upright, grey, sized for Tesseract and with stretched contrast."""
        img = ImageOps.exif_transpose(img)
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGBA")
            background = Image.new("RGBA", img.size, (255, 255, 255, 255))
            img = Image.alpha_composite(background, img)
        img = img.convert("L")
        long_side = max(img.size)
        if long_side > MAX_LONG_SIDE:
            scale = MAX_LONG_SIDE / long_side
        elif long_side < MIN_LONG_SIDE:
            scale = min(3.0, MIN_LONG_SIDE / long_side)
        else:
            scale = 1.0
        if scale != 1.0:
            img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
        return ImageOps.autocontrast(img, cutoff=1)

    def _orientation(self, img: Image.Image) -> int:
        """Degrees to turn the picture clockwise so its text is upright (0 when unsure)."""
        if not self.status().get("orientation"):
            return 0
        try:
            tess = _tesseract()
            osd = tess.image_to_osd(img, config="--psm 0 -c min_characters_to_try=10",
                                    output_type=tess.Output.DICT)
        except Exception:  # too little text to tell
            return 0
        if float(osd.get("orientation_conf", 0)) < MIN_ORIENTATION_CONFIDENCE:
            return 0
        return int(osd.get("rotate", 0)) % 360

    def _read(self, img: Image.Image) -> OcrResult:
        tess = _tesseract()
        data = tess.image_to_data(img, lang="+".join(self.status()["languages"]), config="--psm 3",
                                  output_type=tess.Output.DICT)
        lines, confidences = {}, []
        for i, word in enumerate(data["text"]):
            word = (word or "").strip()
            if not word:
                continue
            conf = float(data["conf"][i])
            if conf >= 0:
                confidences.append(conf)
            key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
            lines.setdefault(key, []).append(word)
        parts, last_par = [], None
        for (block, par, _line), words in lines.items():
            if last_par is not None and (block, par) != last_par:
                parts.append("")
            parts.append(" ".join(words))
            last_par = (block, par)
        confidence = sum(confidences) / len(confidences) if confidences else 0.0
        return OcrResult(text="\n".join(parts).strip(), confidence=round(confidence, 1))

    def read_image(self, img: Image.Image) -> OcrResult:
        """Read one picture. Raises if Tesseract is not available."""
        if not self.available:
            raise RuntimeError("OCR is not available: Tesseract is not installed")
        prepared = self.prepare(img)
        turn = self._orientation(prepared)
        if turn:
            prepared = prepared.rotate(-turn, expand=True)  # PIL turns counter-clockwise
        tilt = self.skew_angle(prepared)
        if tilt:
            prepared = prepared.rotate(tilt, expand=True, fillcolor=255, resample=Image.BICUBIC)
        result = self._read(prepared)
        result.rotated = turn
        return result

    @staticmethod
    def skew_angle(img: Image.Image) -> float:
        """Small tilt of a hand-held photo, in degrees counter-clockwise to straighten it (0 when straight).

        Text lines give sharp steps in the row sums of dark pixels when they run level; the angle with the sharpest
        steps wins.
        """
        import numpy as np

        small = img.convert("L").copy()
        small.thumbnail((1000, 1000))
        ink = np.asarray(small) < 128
        if ink.mean() < 0.002:  # (nearly) blank
            return 0.0
        ink_img = Image.fromarray((ink * 255).astype("uint8"))

        def sharpness(angle):
            rows = np.asarray(ink_img.rotate(angle, resample=Image.NEAREST, expand=True)).sum(axis=1, dtype=np.float64)
            return float(np.sum(np.diff(rows) ** 2))

        coarse = max((a / 2 for a in range(-MAX_SKEW * 2, MAX_SKEW * 2 + 1)), key=sharpness)
        best = max((coarse + a / 10 for a in range(-5, 6)), key=sharpness)
        return round(best, 1) if abs(best) >= MIN_SKEW else 0.0

    def frames(self, path: str) -> List[Image.Image]:
        """Every page of a picture file (a TIFF from a fax or scanner can have several)."""
        with Image.open(path) as img:
            return [frame.copy() for frame in ImageSequence.Iterator(img)]

    # ---------------------------------------------------------------- used by the indexers

    def text_of_picture(self, path: str, vision_prompt: Optional[str] = None) -> List[PageText]:
        """Text of every page of a photo or scanned picture: OCR, or the vision model when OCR finds nothing."""
        pages = []
        for number, frame in enumerate(self.frames(path)):
            page = self._text_of_frame(frame, number, vision_prompt, f"{os.path.basename(path)} page {number + 1}")
            if page:
                pages.append(page)
        return pages

    def text_of_scanned_pdf_page(self, page, page_num: int, vision_prompt: str = SCANNED_PAGE_PROMPT) -> Optional[PageText]:
        """Text of a PDF page that has no text layer (a scan)."""
        pix = page.get_pixmap(dpi=PDF_DPI, alpha=False)
        mode = "L" if pix.n == 1 else "RGB"
        img = Image.frombytes(mode, (pix.width, pix.height), pix.samples)
        return self._text_of_frame(img, page_num, vision_prompt, f"page {page_num + 1}")

    def _text_of_frame(self, img: Image.Image, number: int, vision_prompt: Optional[str], label: str) -> Optional[PageText]:
        if self.available:
            try:
                result = self.read_image(img)
                if result.readable:
                    logger.info(f"OCR: read {len(result.text)} characters from {label} "
                                f"(confidence {result.confidence:.0f}, turned {result.rotated} degrees)")
                    return PageText(text=result.text, method="ocr", page=number, confidence=result.confidence)
                logger.info(f"OCR: no readable text on {label} (confidence {result.confidence:.0f}); asking the vision model")
            except Exception as e:
                logger.warning(f"OCR: reading {label} failed ({e}); asking the vision model")
        description = self._describe(img, vision_prompt)
        if description and description.strip():
            return PageText(text=description.strip(), method="vision", page=number)
        return None

    def _describe(self, img: Image.Image, prompt: Optional[str]) -> str:
        from app.services.vision_service import vision_service

        img = ImageOps.exif_transpose(img).convert("RGB")
        if max(img.size) > VISION_LONG_SIDE:
            img.thumbnail((VISION_LONG_SIDE, VISION_LONG_SIDE), Image.LANCZOS)
        fd, temp_path = tempfile.mkstemp(suffix=".png")
        os.close(fd)
        try:
            img.save(temp_path, format="PNG")
            return vision_service.generate_image_description(temp_path, prompt=prompt)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)


ocr_service = OcrService()
