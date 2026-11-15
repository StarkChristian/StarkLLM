"""Builds the documents of the injection set whose hiding place is the file format itself (a PDF with white text, a Word
file with a hidden run, a web page with display:none ...). They are built when the tests run, so the repository holds
no binary files and everybody can read how each one hides its text.

build(spec, directory) -> path of the file (or the HTML text for the web page cases).
"""
import os


def _pdf(path, visible, hidden, how):
    import pymupdf as fitz  # PyMuPDF
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((72, 72), visible, fontsize=11)
    if how == "white":
        page.insert_text((72, 140), hidden, fontsize=11, color=(1, 1, 1))
    elif how == "tiny":
        page.insert_text((72, 140), hidden, fontsize=1)
    elif how == "offpage":
        page.insert_text((-2000, 140), hidden, fontsize=11)
    elif how == "metadata":
        doc.set_metadata({"title": hidden, "subject": hidden, "keywords": hidden})
    doc.save(path)
    doc.close()
    return path


def _docx(path, visible, hidden, how):
    import docx
    from docx.shared import Pt, RGBColor
    d = docx.Document()
    p = d.add_paragraph(visible + " ")
    if how in ("vanish", "white", "tiny"):
        run = p.add_run(hidden)
        if how == "vanish":
            run.font.hidden = True
        elif how == "white":
            run.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        else:
            run.font.size = Pt(1)
    elif how == "properties":
        d.core_properties.comments = hidden
        d.core_properties.title = hidden
        d.core_properties.keywords = hidden
    d.save(path)
    return path


def _html(visible, hidden, how):
    inner = {
        "display_none": f'<p style="display:none">{hidden}</p>',
        "white": f'<p style="color:#ffffff">{hidden}</p>',
        "font0": f'<span style="font-size:0">{hidden}</span>',
        "comment": f"<!-- {hidden} -->",
        "hidden_attr": f"<div hidden><p>{hidden}</p></div>",
    }[how]
    return f"<html><head><title>Invoice</title></head><body><p>{visible}</p>{inner}</body></html>"


KINDS = {
    "pdf_white": lambda d, v, h: _pdf(os.path.join(d, "case.pdf"), v, h, "white"),
    "pdf_tiny": lambda d, v, h: _pdf(os.path.join(d, "case.pdf"), v, h, "tiny"),
    "pdf_offpage": lambda d, v, h: _pdf(os.path.join(d, "case.pdf"), v, h, "offpage"),
    "pdf_metadata": lambda d, v, h: _pdf(os.path.join(d, "case.pdf"), v, h, "metadata"),
    "docx_vanish": lambda d, v, h: _docx(os.path.join(d, "case.docx"), v, h, "vanish"),
    "docx_white": lambda d, v, h: _docx(os.path.join(d, "case.docx"), v, h, "white"),
    "docx_tiny": lambda d, v, h: _docx(os.path.join(d, "case.docx"), v, h, "tiny"),
    "docx_properties": lambda d, v, h: _docx(os.path.join(d, "case.docx"), v, h, "properties"),
    "html_display_none": lambda d, v, h: _html(v, h, "display_none"),
    "html_white": lambda d, v, h: _html(v, h, "white"),
    "html_font0": lambda d, v, h: _html(v, h, "font0"),
    "html_comment": lambda d, v, h: _html(v, h, "comment"),
    "html_hidden_attr": lambda d, v, h: _html(v, h, "hidden_attr"),
}


def build(spec, directory):
    return KINDS[spec["type"]](directory, spec["visible"], spec["hidden"])
