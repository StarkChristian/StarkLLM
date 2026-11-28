"""Chats and answers as Word documents (docs/roadmap-2026-12.md, R1). Everything happens on this PC: the chat page
sends the messages, the engine writes the .docx with python-docx and sends it back. No template, no network.

The answers are Markdown as the model writes it; the common parts become real Word formatting: headings, bold,
italic, inline code, code blocks, lists (also numbered and nested), quotes, tables and links. Anything else stays
as text, never as raw Markdown symbols where they can be avoided.
"""
import io
import re
from typing import Dict, List, Optional

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor

# **bold**, __bold__, *italic*, _italic_, `code`, [text](url)
INLINE = re.compile(
    r"(\*\*(?P<b1>.+?)\*\*|__(?P<b2>.+?)__|(?<![\w*])\*(?P<i1>[^*\n]+?)\*(?![\w*])|(?<![\w_])_(?P<i2>[^_\n]+?)_(?![\w_])"
    r"|`(?P<code>[^`\n]+)`|\[(?P<lt>[^\]\n]+)\]\((?P<lu>[^)\s]+)\))"
)
HEADING = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
BULLET = re.compile(r"^(\s*)[-*+]\s+(.*)$")
NUMBERED = re.compile(r"^(\s*)(\d+)[.)]\s+(.*)$")
QUOTE = re.compile(r"^\s*>\s?(.*)$")
TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
RULE = re.compile(r"^\s*([-*_])(\s*\1){2,}\s*$")

# characters Word cannot keep (control characters other than tab and line ends)
_BAD_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _clean(text: str) -> str:
    return _BAD_XML.sub("", str(text or ""))


def _hyperlink(paragraph, text: str, url: str):
    """A real link in Word (only http, https and mailto addresses; anything else stays text)."""
    if not re.match(r"^(https?://|mailto:)", url, re.I):
        paragraph.add_run(f"{text} ({url})")
        return
    part = paragraph.part
    r_id = part.relate_to(url, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", is_external=True)
    link = OxmlElement("w:hyperlink")
    link.set(qn("r:id"), r_id)
    run = OxmlElement("w:r")
    props = OxmlElement("w:rPr")
    color = OxmlElement("w:color")
    color.set(qn("w:val"), "1F4FBF")
    props.append(color)
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    props.append(underline)
    run.append(props)
    t = OxmlElement("w:t")
    t.text = _clean(text)
    t.set(qn("xml:space"), "preserve")
    run.append(t)
    link.append(run)
    paragraph._p.append(link)


def add_inline(paragraph, text: str, bold: bool = False):
    """Markdown of one line into runs of a paragraph."""
    text = _clean(text)
    pos = 0
    for m in INLINE.finditer(text):
        if m.start() > pos:
            r = paragraph.add_run(text[pos:m.start()])
            r.bold = bold or None
        if m.group("b1") or m.group("b2"):
            inner = m.group("b1") or m.group("b2")
            add_inline(paragraph, inner, bold=True)
        elif m.group("i1") or m.group("i2"):
            r = paragraph.add_run(m.group("i1") or m.group("i2"))
            r.italic = True
            r.bold = bold or None
        elif m.group("code"):
            r = paragraph.add_run(m.group("code"))
            r.font.name = "Consolas"
            r.font.size = Pt(9.5)
        elif m.group("lt"):
            _hyperlink(paragraph, m.group("lt"), m.group("lu"))
        pos = m.end()
    if pos < len(text):
        r = paragraph.add_run(text[pos:])
        r.bold = bold or None


def _cells(line: str) -> List[str]:
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip() for c in s.split("|")]


def add_markdown(doc, markdown: str):
    """Markdown of an answer into the document."""
    lines = _clean(markdown).replace("\r\n", "\n").split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.strip().startswith("```"):
            code = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code.append(lines[i])
                i += 1
            i += 1  # the closing fence
            p = doc.add_paragraph()
            r = p.add_run("\n".join(code))
            r.font.name = "Consolas"
            r.font.size = Pt(9)
            _shade(p, "F2F2F2")
            continue
        if not line.strip():
            i += 1
            continue
        h = HEADING.match(line)
        if h:
            level = min(len(h.group(1)) + 1, 6)  # the chat title is heading 1
            p = doc.add_heading(level=level)
            add_inline(p, h.group(2))
            i += 1
            continue
        if RULE.match(line):
            i += 1
            continue
        # a table: a row of cells, then a separator row
        if "|" in line and i + 1 < len(lines) and TABLE_SEP.match(lines[i + 1]):
            head = _cells(line)
            rows = []
            i += 2
            while i < len(lines) and "|" in lines[i] and lines[i].strip():
                rows.append(_cells(lines[i]))
                i += 1
            cols = max([len(head)] + [len(r) for r in rows])
            table = doc.add_table(rows=1 + len(rows), cols=cols)
            table.style = "Table Grid"
            for c in range(cols):
                cell = table.rows[0].cells[c]
                add_inline(cell.paragraphs[0], head[c] if c < len(head) else "", bold=True)
            for r_i, row in enumerate(rows, start=1):
                for c in range(cols):
                    add_inline(table.rows[r_i].cells[c].paragraphs[0], row[c] if c < len(row) else "")
            doc.add_paragraph()
            continue
        b = BULLET.match(line)
        n = NUMBERED.match(line)
        if b or n:
            indent = len((b or n).group(1).replace("\t", "    "))
            depth = min(indent // 2, 2)
            if b:
                style = "List Bullet" if depth == 0 else f"List Bullet {depth + 1}"
                p = doc.add_paragraph(style=style)
                add_inline(p, b.group(2))
            else:
                # the number the model wrote is kept (Word's own numbering would restart in odd places)
                p = doc.add_paragraph(style="List Paragraph")
                p.paragraph_format.left_indent = Pt(18 * (depth + 1))
                p.paragraph_format.first_line_indent = Pt(-14)
                p.add_run(f"{n.group(2)}. ")
                add_inline(p, n.group(3))
            i += 1
            continue
        q = QUOTE.match(line)
        if q:
            quoted = []
            while i < len(lines) and QUOTE.match(lines[i]):
                quoted.append(QUOTE.match(lines[i]).group(1))
                i += 1
            p = doc.add_paragraph(style="Quote") if "Quote" in [s.name for s in doc.styles] else doc.add_paragraph()
            for k, ql in enumerate(quoted):
                if k:
                    p.add_run().add_break()
                add_inline(p, ql)
            continue
        # a paragraph: lines until an empty line or another block
        para = [line.strip()]
        i += 1
        while i < len(lines) and lines[i].strip() and not _starts_block(lines, i):
            para.append(lines[i].strip())
            i += 1
        p = doc.add_paragraph()
        for k, pl in enumerate(para):
            if k:
                p.add_run().add_break()
            add_inline(p, pl)


def _starts_block(lines: List[str], i: int) -> bool:
    line = lines[i]
    return bool(line.strip().startswith("```") or HEADING.match(line) or BULLET.match(line) or NUMBERED.match(line)
                or QUOTE.match(line) or RULE.match(line)
                or ("|" in line and i + 1 < len(lines) and TABLE_SEP.match(lines[i + 1])))


def _shade(paragraph, fill: str):
    props = paragraph._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    props.append(shd)


AI_NOTE = "Created with AI assistance (StarkLLM)"
_CUSTOM_PROPS_CT = "application/vnd.openxmlformats-officedocument.custom-properties+xml"
_CUSTOM_PROPS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"
_VT_NS = "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"
# the format id every custom document property carries (ECMA-376 part 1, 22.3.2.2)
_CUSTOM_PROP_FMTID = "{D5CDD505-2E9C-101B-9397-08002B2CF9AE}"


def generator_name(version: str = "") -> str:
    """'StarkLLM 2.7.0 (AI-generated content)': who made the file, in its properties (EU AI Act, Article 50(2))."""
    return f"StarkLLM {version} (AI-generated content)" if version else "StarkLLM (AI-generated content)"


def _mark_ai_generated(doc, version: str):
    """Machine-readable marking of AI-generated content (EU AI Act, Article 50(2)): the core properties (creator,
    keywords, comments), the application in docProps/app.xml, and a custom property ai_generated=true."""
    from xml.sax.saxutils import escape

    from docx.opc.constants import RELATIONSHIP_TYPE as RT
    from docx.opc.packuri import PackURI
    from docx.opc.part import Part

    generator = generator_name(version)
    props = doc.core_properties
    props.author = generator  # dc:creator
    props.last_modified_by = generator
    props.keywords = "AI-generated"
    props.comments = "AI-generated content, created with StarkLLM"
    package = doc.part.package
    for part in package.iter_parts():
        if str(part.partname) == "/docProps/app.xml" and isinstance(getattr(part, "_blob", None), bytes):
            # the template of python-docx says "Microsoft Macintosh Word" here
            part._blob = re.sub(rb"<Application>[^<]*</Application>",
                                b"<Application>" + escape(generator).encode("utf-8") + b"</Application>", part._blob)
    xml = (
        "<?xml version='1.0' encoding='UTF-8' standalone='yes'?>\n"
        f'<Properties xmlns="{_CUSTOM_PROPS_NS}" xmlns:vt="{_VT_NS}">'
        f'<property fmtid="{_CUSTOM_PROP_FMTID}" pid="2" name="ai_generated"><vt:bool>true</vt:bool></property>'
        f'<property fmtid="{_CUSTOM_PROP_FMTID}" pid="3" name="generator"><vt:lpwstr>{escape(generator)}</vt:lpwstr></property>'
        "</Properties>"
    ).encode("utf-8")
    custom = Part(PackURI("/docProps/custom.xml"), _CUSTOM_PROPS_CT, xml, package)
    package.relate_to(custom, RT.CUSTOM_PROPERTIES)


def _ai_footer(doc, text: str):
    """A short visible line at the foot of every page: the reader sees that the content was made with AI."""
    for section in doc.sections:
        p = section.footer.paragraphs[0] if section.footer.paragraphs else section.footer.add_paragraph()
        p.text = ""
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(_clean(text))
        r.font.size = Pt(8)
        r.font.color.rgb = RGBColor(0x77, 0x77, 0x77)


def chat_to_docx(title: str, messages: List[Dict], labels: Optional[Dict[str, str]] = None, date_text: str = "",
                 version: Optional[str] = None) -> bytes:
    """messages: [{role: 'user'|'assistant', content, time?, sources?: [str]}] -> the bytes of a .docx file.
    labels: the words of the user's language ({"user", "assistant", "sources", "exported", "ai_note"}).
    version: the app version for the document properties (default: the engine's version)."""
    words = {"user": "You", "assistant": "StarkLLM", "sources": "Sources", "exported": "Exported from StarkLLM",
             "ai_note": AI_NOTE}
    words.update({k: v for k, v in (labels or {}).items() if isinstance(v, str) and v.strip()})
    if version is None:
        from app.core.config import settings
        version = settings.VERSION
    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)
    doc.core_properties.title = _clean(title)[:200]
    _mark_ai_generated(doc, _clean(version)[:40])
    _ai_footer(doc, words["ai_note"])
    doc.add_heading(_clean(title) or "StarkLLM", level=1)
    meta = doc.add_paragraph()
    run = meta.add_run(f"{words['exported']}{' · ' + date_text if date_text else ''}")
    run.font.size = Pt(9)
    run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)
    for m in messages:
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        who = doc.add_paragraph()
        r = who.add_run(words["user"] if role == "user" else words["assistant"])
        r.bold = True
        r.font.color.rgb = RGBColor(0x4F, 0x46, 0xE5) if role == "user" else RGBColor(0x05, 0x96, 0x69)
        if m.get("time"):
            t = who.add_run(f"  {m['time']}")
            t.font.size = Pt(9)
            t.font.color.rgb = RGBColor(0x88, 0x88, 0x88)
        if role == "user":
            p = doc.add_paragraph()
            for k, line in enumerate(_clean(m.get("content", "")).split("\n")):
                if k:
                    p.add_run().add_break()
                p.add_run(line)
        else:
            add_markdown(doc, m.get("content", ""))
        sources = [s for s in (m.get("sources") or []) if isinstance(s, str) and s.strip()]
        if sources:
            p = doc.add_paragraph()
            sr = p.add_run(f"{words['sources']}: ")
            sr.italic = True
            sr.font.size = Pt(9)
            for k, s in enumerate(sources[:30]):
                x = p.add_run(("; " if k else "") + _clean(s)[:300])
                x.font.size = Pt(9)
                x.italic = True
        sep = doc.add_paragraph()
        sep.alignment = WD_ALIGN_PARAGRAPH.CENTER
        sep.add_run("· · ·").font.color.rgb = RGBColor(0xBB, 0xBB, 0xBB)
    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()
