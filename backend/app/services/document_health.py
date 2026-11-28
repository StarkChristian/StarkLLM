"""Document health (StarkLLM 2.7, option 5): what StarkLLM could read from one document, and what may be missing.

Answers fail silently when the text behind them is poor: a scan without a text layer, a password-protected PDF, a Word
file with unaccepted tracked changes, a table that became a run of numbers. The document list opens this view per
document. Everything here comes from the indexed passages (their metadata: page, OCR, vision) and from a look at the
file itself; nothing is sent anywhere and no model is asked.

    health(...)  -> {"pages", "chunks", "chars", "text_preview", "ocr": {...}, "vision_pages", "warnings": [...]}

Warning kinds (the UI words them): parse_error, encrypted, empty_pages, little_text, tracked_changes,
tables_flattened, hidden_text, not_indexed.
"""
import logging
import os
import re
import zipfile
from typing import Dict, Iterable, List, Optional, Tuple

from app.services import untrusted

logger = logging.getLogger(__name__)

PREVIEW_CHARS = 2000
LITTLE_TEXT_CHARS = 200          # less than this for the whole document: little text
LITTLE_TEXT_PER_PAGE = 80        # or, for a PDF, less than this per page on average
TABLE_CHECK_PAGES = 20           # PDF pages looked at for tables (finding tables is slow on long documents)
OLE_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"  # a password-protected Word/Excel file is an OLE container, not a zip

OCR_TYPES = {"ocr"}
VISION_TYPES = {"vision_fallback", "image_description"}


def _page_of(meta: Dict) -> Optional[int]:
    try:
        return int(meta["page"]) + 1 if meta.get("page") is not None else None
    except (TypeError, ValueError):
        return None


def _ranges(pages: Iterable[int]) -> List[int]:
    return sorted(set(p for p in pages if p))


def inspect_pdf(path: str, table_pages: int = TABLE_CHECK_PAGES) -> Dict:
    """Pages, encryption and tables of a PDF."""
    try:
        import pymupdf as fitz
    except ImportError:  # pragma: no cover - older PyMuPDF
        import fitz
    out = {"pages": None, "encrypted": False, "table_pages": [], "tables_checked": 0, "error": ""}
    try:
        doc = fitz.open(path)
    except Exception as e:
        out["error"] = str(e)[:200]
        return out
    try:
        out["encrypted"] = bool(doc.needs_pass)
        out["pages"] = len(doc)
        if doc.needs_pass:
            return out
        checked = min(len(doc), table_pages)
        for n in range(checked):
            try:
                if doc[n].find_tables().tables:
                    out["table_pages"].append(n + 1)
            except Exception:  # an odd page must not hide the rest of the view
                continue
        out["tables_checked"] = checked
    finally:
        doc.close()
    return out


def inspect_docx(path: str) -> Dict:
    """Encryption, tracked changes and tables of a Word file (read straight from its XML)."""
    out = {"encrypted": False, "tracked_changes": 0, "tables": 0, "error": ""}
    try:
        with open(path, "rb") as f:
            head = f.read(8)
        if head == OLE_MAGIC:
            out["encrypted"] = True
            return out
        with zipfile.ZipFile(path) as z:
            xml = z.read("word/document.xml").decode("utf-8", errors="replace")
    except Exception as e:
        out["error"] = str(e)[:200]
        return out
    out["tracked_changes"] = len(re.findall(r"<w:(?:ins|del|moveFrom|moveTo)\b", xml))
    out["tables"] = len(re.findall(r"<w:tbl\b", xml))
    return out


def inspect_file(path: Optional[str], file_type: str) -> Dict:
    """What the file itself shows. A protected (encrypted-at-rest) upload is read from a temporary plain copy."""
    ext = (file_type or "").lower().lstrip(".")
    if not path or not os.path.exists(path) or ext not in ("pdf", "docx"):
        return {}
    from app.services import vault
    try:
        with vault.plain_path(path) as readable:
            return inspect_pdf(readable) if ext == "pdf" else inspect_docx(readable)
    except Exception as e:
        logger.warning(f"document health: the file could not be inspected: {e}")
        return {"error": str(e)[:200]}


def health(*, status: str, error_message: Optional[str], file_type: str,
           passages: List[Tuple[str, Dict]], file_info: Optional[Dict] = None) -> Dict:
    """The health of one document from its indexed passages [(text, metadata)] and inspect_file()."""
    file_info = file_info or {}
    ext = (file_type or "").lower().lstrip(".")
    ordered = sorted(passages, key=lambda p: (_page_of(p[1] or {}) or 0, (p[1] or {}).get("chunk") or 0))
    texts = [t or "" for t, _ in ordered]
    metas = [m or {} for _, m in ordered]
    chars = sum(len(t.strip()) for t in texts)
    full = "\n\n".join(t.strip() for t in texts if t.strip())
    preview = untrusted.HIDDEN_MARKER_RE.sub("", full).strip()

    pages_with_text = _ranges(_page_of(m) for m in metas)
    ocr_pages = _ranges(_page_of(m) or 1 for m in metas if m.get("type") in OCR_TYPES)
    vision_pages = _ranges(_page_of(m) or 1 for m in metas if m.get("type") in VISION_TYPES)
    languages = sorted({lang for m in metas if m.get("type") in OCR_TYPES
                        for lang in (m.get("ocr_languages") or "").split("+") if lang})
    confidences = [float(m["ocr_confidence"]) for m in metas
                   if m.get("type") in OCR_TYPES and isinstance(m.get("ocr_confidence"), (int, float))]
    pages = file_info.get("pages")
    if pages is None and ext == "pptx":
        pages = max(pages_with_text, default=None)

    warnings: List[Dict] = []
    if status == "failed":
        warnings.append({"kind": "parse_error", "detail": (error_message or "")[:300]})
    elif status not in ("indexed", "missing") and not texts:
        warnings.append({"kind": "not_indexed", "status": status})
    if file_info.get("encrypted"):
        warnings.append({"kind": "encrypted"})
    elif file_info.get("error") and status != "failed":
        warnings.append({"kind": "parse_error", "detail": file_info["error"]})
    if ext == "pdf" and pages and texts:
        empty = [p for p in range(1, pages + 1) if p not in pages_with_text]
        if empty:
            warnings.append({"kind": "empty_pages", "pages": empty, "count": len(empty)})
    if texts and (chars < LITTLE_TEXT_CHARS or (ext == "pdf" and pages and chars / pages < LITTLE_TEXT_PER_PAGE)):
        warnings.append({"kind": "little_text", "chars": chars, "pages": pages})
    if file_info.get("tracked_changes"):
        warnings.append({"kind": "tracked_changes", "count": file_info["tracked_changes"]})
    if file_info.get("tables"):
        warnings.append({"kind": "tables_flattened", "count": file_info["tables"], "pages": []})
    elif file_info.get("table_pages"):
        warnings.append({"kind": "tables_flattened", "count": len(file_info["table_pages"]), "pages": file_info["table_pages"],
                         "checked_pages": file_info.get("tables_checked")})
    hidden = max((int(n) for t in texts for n in untrusted.HIDDEN_MARKER_RE.findall(t)), default=0)
    if hidden:
        warnings.append({"kind": "hidden_text", "count": hidden})

    return {
        "pages": pages,
        "pages_with_text": len(pages_with_text) if pages_with_text else (1 if texts else 0),
        "chunks": len(texts),
        "chars": chars,
        "text_preview": preview[:PREVIEW_CHARS],
        "preview_truncated": len(preview) > PREVIEW_CHARS,
        "ocr": {"used": bool(ocr_pages), "pages": ocr_pages, "languages": languages,
                "languages_recorded": bool(languages) or not ocr_pages,
                "confidence": round(sum(confidences) / len(confidences)) if confidences else None},
        "vision_pages": vision_pages,
        "warnings": warnings,
    }
