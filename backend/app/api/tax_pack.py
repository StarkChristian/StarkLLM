"""The yearly package for the tax advisor (StarkLLM 2.8, option 11): Inbox > "Export for my tax advisor".

POST /preview: the year's letters of the chosen workspaces with category, amount, status and new file name, for the
user to check. POST /export: the ZIP with the documents in category folders, the overview (CSV, XLSX) and the
summary (Word). Made on this PC by services/tax_pack.py; nothing is sent anywhere. The documents are decrypted in
memory and only into the ZIP that the page saves where the user chooses; no plain copy is left on disk.
"""
import logging
from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.db import models
from app.db.session import get_db
from app.services import tax_pack

logger = logging.getLogger(__name__)
router = APIRouter()

MAX_EXPORT_BYTES = 500 * 1024 * 1024   # the documents of a household's year are far smaller; the ZIP is built in memory
MIN_PASSWORD = 8


class PackIn(BaseModel):
    year: int = Field(..., ge=1970, le=2100)
    workspaces: List[int] = Field(default_factory=list, max_length=500)
    include_kb: bool = False
    lang: str = Field("en", pattern="^(en|de|es|fr|it|tr)$")


class PreviewIn(PackIn):
    suggest: bool = False   # ask the local model about the letters the rules put into "Other"


class Override(BaseModel):
    key: str = Field(..., pattern=r"^(ws|kb)-\d{1,12}$")
    category: Optional[str] = Field(None, pattern="^(tax|insurance|housing|work|health|other)$")
    included: Optional[bool] = None
    source: Optional[str] = Field(None, pattern="^(user|model)$")


class ExportIn(PackIn):
    overrides: List[Override] = Field(default_factory=list, max_length=20000)
    password: Optional[str] = Field(None, max_length=200)


def _rows(db, user_id: int, body: PackIn):
    from app.api.dashboard import documents_with_pages, replaced_documents
    from app.services.facts_service import document_facts_cached
    own = {w.id for w in db.query(models.Workspace.id).filter(models.Workspace.user_id == user_id).all()}
    chosen = [w for w in body.workspaces if w in own]
    items, pages_of = documents_with_pages(db, user_id, include_kb=body.include_kb)
    done = {}
    for r in db.query(models.DeadlineDone).filter(models.DeadlineDone.user_id == user_id).all():
        done.setdefault((r.scope, r.document_id), set()).add(r.kind)
    rows, years = tax_pack.build_rows(items, pages_of, replaced_documents(pages_of), document_facts_cached, body.year,
                                      chosen, body.include_kb, body.lang, date.today().isoformat(), done)
    return rows, years, items, pages_of


def _ask_local_model(messages):
    from app.core import netguard
    from app.core.config import settings
    from app.services.llm_service import llm_service
    model = settings.DEFAULT_TEXT_MODEL
    if netguard.is_cloud_model(model):
        raise RuntimeError("only a model on this PC may read the letters")
    result = llm_service.generate_chat(model, messages, options={"temperature": 0})
    return ((result or {}).get("message") or {}).get("content", "")


@router.post("/preview")
def preview(body: PreviewIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """The list to check before the export. Each row: date, sender, kind, category by the rules (with the word and
    page that decided it), amount, due date, paid/done status, page, the new file name and whether it goes into the
    package (else why not: scam, duplicate, replaced, not_financial). With suggest, rows the rules put into "other"
    can carry `suggested`: the local model's category, which the page offers and the export receives as an override."""
    rows, years, items, pages_of = _rows(db, current_user.id, body)
    model_used = False
    if body.suggest:
        texts = {f"{i['scope']}-{i['id']}": "\n".join(t for _, t in sorted((p or {}).items()))
                 for i, p in zip(items, pages_of)}
        suggestions = tax_pack.model_suggestions(rows, texts.get, _ask_local_model)
        # a suggestion stays apart from the rules' category: the page shows it as the model's and the user decides
        for r in rows:
            if r["key"] in suggestions:
                r["suggested"] = suggestions[r["key"]]
                model_used = True
    lang = tax_pack.lang_code(body.lang)
    return {
        "year": body.year, "years": years, "lang": lang, "model_used": model_used,
        "categories": [{"id": c, "name": tax_pack.CATEGORY_NAMES[lang][c]} for c in tax_pack.CATEGORIES],
        "rows": [{k: v for k, v in r.items() if k not in ("amount_text",)} for r in rows],
        "package": tax_pack.package_name(lang, body.year),
    }


def _reader(db, user_id: int):
    from app.services import vault

    def read(row) -> Optional[bytes]:
        if row["scope"] == "ws":
            doc = (db.query(models.Document).join(models.Workspace, models.Document.workspace_id == models.Workspace.id)
                   .filter(models.Document.id == row["id"], models.Workspace.user_id == user_id).first())
            path = doc.filepath if doc else None
        else:
            doc = (db.query(models.KnowledgeBaseDocument)
                   .join(models.KnowledgeBaseFolder, models.KnowledgeBaseDocument.folder_id == models.KnowledgeBaseFolder.id)
                   .filter(models.KnowledgeBaseDocument.id == row["id"], models.KnowledgeBaseFolder.user_id == user_id).first())
            path = doc.file_path if doc else None
        if not path:
            return None
        try:
            return vault.read_bytes(path)
        except Exception as e:
            logger.warning(f"tax package: document {row['key']} could not be read: {type(e).__name__}")
            return None
    return read


def _size(db, user_id: int, rows) -> int:
    import os
    from app.services import vault
    total = 0
    for r in rows:
        if not r["included"]:
            continue
        if r["scope"] == "ws":
            doc = db.get(models.Document, r["id"])
            path = doc.filepath if doc else None
        else:
            doc = db.get(models.KnowledgeBaseDocument, r["id"])
            path = doc.file_path if doc else None
        try:
            total += vault.size(path) if path and os.path.exists(path) else 0
        except OSError:
            pass
    return total


@router.post("/export")
def export(body: ExportIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """The package as a ZIP file, with the user's changes from the review applied. With a password (8 characters or
    more) every file in the ZIP is encrypted with AES-256; the file names stay readable."""
    password = body.password or None
    if password is not None and len(password) < MIN_PASSWORD:
        raise HTTPException(status_code=422, detail=f"The password needs at least {MIN_PASSWORD} characters.")
    rows, _, _, _ = _rows(db, current_user.id, body)
    rows = tax_pack.apply_overrides(rows, [o.model_dump() for o in body.overrides], body.lang)
    if not any(r["included"] for r in rows):
        raise HTTPException(status_code=422, detail="No document is chosen for the package.")
    if _size(db, current_user.id, rows) > MAX_EXPORT_BYTES:
        raise HTTPException(status_code=413, detail="The documents are larger than 500 MB together. Choose fewer workspaces.")
    archive, info = tax_pack.build_package(rows, _reader(db, current_user.id), body.lang, body.year,
                                           date.today().isoformat(), password)
    from urllib.parse import quote
    return Response(archive, media_type="application/zip", headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(info['name'])}",
        "X-Package-Documents": str(info["documents"]),
        "X-Package-Missing": str(info["missing"]),
        "Cache-Control": "no-store",
    })
