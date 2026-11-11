"""Writes the scenario documents (documents.py) as real files: text PDFs, a scanned PDF without a text layer, and a
tilted phone photo with shadow and noise, so OCR and the whole upload path are tested, not only the text.

    python -m scenarios.make_documents <folder>      (from backend/, needs Pillow and PyMuPDF)
"""
import io
import random
import sys
from pathlib import Path

import fitz  # PyMuPDF
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from scenarios.documents import DOCUMENTS

FONTS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "C:\\Windows\\Fonts\\arial.ttf",
]


def _font(size):
    for f in FONTS:
        if Path(f).exists():
            return ImageFont.truetype(f, size)
    return ImageFont.load_default(size=size)


def pdf_font() -> dict:
    """A TrueType font with the euro sign when there is one; PyMuPDF's built-in Helvetica writes "?" for "€"."""
    for f in FONTS:
        if Path(f).exists():
            return {"fontname": "dejavu", "fontfile": f}
    return {"fontname": "helv"}


def write_pdf(text: str, path: Path):
    doc = fitz.open()
    lines = text.splitlines()
    start = 0
    while start < len(lines):
        page = doc.new_page(width=595, height=842)  # A4
        # as many lines as fit; insert_textbox writes nothing and returns < 0 when the text does not fit
        for end in range(len(lines), start, -1):
            if page.insert_textbox(fitz.Rect(56, 56, 540, 800), "\n".join(lines[start:end]),
                                   fontsize=9.5, **pdf_font()) >= 0:
                break
        start = end
    doc.save(path)


def render_page(text: str, width=1240, size=26, margin=90) -> Image.Image:
    """A white A4-ish page with the text, like a printed letter."""
    font = _font(size)
    lines = text.splitlines()
    height = max(int(width * 1.414), margin * 2 + len(lines) * int(size * 1.45))
    page = Image.new("L", (width, height), 255)
    draw = ImageDraw.Draw(page)
    y = margin
    for line in lines:
        draw.text((margin, y), line, fill=20, font=font)
        y += int(size * 1.45)
    return page


def write_scan(text: str, path: Path, seed=7):
    """An office scan: grey, slightly tilted, speckled, no text layer."""
    rnd = random.Random(seed)
    page = render_page(text).rotate(0.8, resample=Image.BICUBIC, expand=False, fillcolor=255)
    px = page.load()
    for _ in range(9000):
        x, y = rnd.randrange(page.width), rnd.randrange(page.height)
        px[x, y] = rnd.choice((90, 160, 200))
    page = page.filter(ImageFilter.GaussianBlur(0.6))
    buf = io.BytesIO()
    page.save(buf, "PNG")
    doc = fitz.open()
    pdf_page = doc.new_page(width=595, height=842)
    pdf_page.insert_image(pdf_page.rect, stream=buf.getvalue())
    doc.save(path)


def write_photo(text: str, path: Path, seed=11):
    """A phone photo of a letter on a table: tilted, shadow from one side, soft focus, JPEG."""
    rnd = random.Random(seed)
    sheet = render_page(text, width=1100, size=30).convert("RGB")
    table = Image.new("RGB", (1500, 1900), (118, 92, 70))
    sheet = sheet.rotate(-3.5, resample=Image.BICUBIC, expand=True, fillcolor=(118, 92, 70))
    table.paste(sheet, (150, 120))
    # shadow: darker towards the right edge
    shade = Image.new("L", table.size, 0)
    d = ImageDraw.Draw(shade)
    for x in range(table.width):
        d.line([(x, 0), (x, table.height)], fill=int(70 * x / table.width))
    table = Image.composite(Image.new("RGB", table.size, (0, 0, 0)), table, shade)
    px = table.load()
    for _ in range(20000):
        x, y = rnd.randrange(table.width), rnd.randrange(table.height)
        r, g, b = px[x, y]
        n = rnd.randint(-25, 25)
        px[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
    table.filter(ImageFilter.GaussianBlur(0.8)).save(path, "JPEG", quality=80)


def write_screenshot(text: str, path: Path):
    """A phone screenshot of a text message: plain, sharp, narrow."""
    page = render_page(text, width=900, size=28, margin=50).convert("RGB")
    page = page.crop((0, 0, page.width, 60 + 50 * len(text.splitlines())))
    page.save(path, "PNG")


def main(folder: str):
    out = Path(folder)
    out.mkdir(parents=True, exist_ok=True)
    for d in DOCUMENTS:
        target = out / d["file"]
        {"pdf": write_pdf, "scan": write_scan, "photo": write_photo, "screenshot": write_screenshot}[d["kind"]](d["text"], target)
        print(f"{d['kind']:5}  {target.name}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "scenario-documents")
