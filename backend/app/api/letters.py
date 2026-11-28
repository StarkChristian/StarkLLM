"""Reply letters from the inbox (services/reply_letters.py) and the user's details for them.

GET/PUT /letters/profile   the user's name and address, protected at rest, on this PC only
POST    /letters/draft     a draft reply to one letter of the inbox, to edit, export or copy

Nothing here sends anything: there is no mail, fax or post. A letter with signs of a scam gets no reply letter.
"""
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.core.config import settings
from app.db import models
from app.db.session import get_db
from app.services import reply_letters

router = APIRouter()

PROFILE_FIELDS = ("full_name", "street", "postal_code", "city", "country")


class ProfileIn(BaseModel):
    full_name: Optional[str] = Field(None, max_length=120)
    street: Optional[str] = Field(None, max_length=160)
    postal_code: Optional[str] = Field(None, max_length=20)
    city: Optional[str] = Field(None, max_length=120)
    country: Optional[str] = Field(None, max_length=80)


class DraftIn(BaseModel):
    scope: str = Field(..., pattern="^(ws|kb)$")
    document_id: int
    kind: str = Field(..., pattern="^(" + "|".join(reply_letters.KINDS) + ")$")
    ui_language: Optional[str] = Field(None, max_length=10)  # used when the letter's language is unclear
    use_model: bool = True


def profile_of(db: Session, user_id: int) -> dict:
    row = db.query(models.LetterProfile).filter(models.LetterProfile.user_id == user_id).first()
    return {f: (getattr(row, f) or "") if row else "" for f in PROFILE_FIELDS}


@router.get("/profile")
def get_profile(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """The user's name and address for reply letters (empty until filled in once in Settings)."""
    return profile_of(db, current_user.id)


@router.put("/profile")
def put_profile(body: ProfileIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Save the user's name and address for reply letters. Stored on this PC, protected at rest when protection is
    on; an empty field is removed."""
    row = db.query(models.LetterProfile).filter(models.LetterProfile.user_id == current_user.id).first()
    if not row:
        row = models.LetterProfile(user_id=current_user.id)
        db.add(row)
    sent = body.model_dump(exclude_unset=True)
    for f in PROFILE_FIELDS:
        if f in sent:
            setattr(row, f, (sent[f] or "").strip() or None)
    db.commit()
    return profile_of(db, current_user.id)


def _letter(db: Session, user_id: int, scope: str, document_id: int):
    """(item, pages, facts) of one of the user's documents, or a 404."""
    from app.api.dashboard import documents_with_pages
    from app.services.facts_service import document_facts_cached
    items, pages_of = documents_with_pages(db, user_id)
    for item, pages in zip(items, pages_of):
        if item["scope"] == scope and item["id"] == document_id:
            return item, pages, document_facts_cached(pages, item["filename"])
    raise HTTPException(status_code=404, detail="Document not found")


@router.post("/draft")
def make_draft(body: DraftIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """A reply letter to one letter of the inbox: the recipient, references, dates and amounts from the letter, the
    user's own details from the profile, the body by the local model (checked) or a fixed text, and the deadlines
    printed in the letter with their sentences. Nothing is sent."""
    item, pages, facts = _letter(db, current_user.id, body.scope, body.document_id)
    if facts.get("warnings"):
        # a letter with signs of a scam is not answered: a reply would confirm the address and the person to the sender
        raise HTTPException(status_code=409, detail={"code": "scam", "warnings": facts["warnings"]})
    if not facts.get("letter"):
        raise HTTPException(status_code=400, detail={"code": "not-a-letter"})
    from app.services.llm_service import llm_service
    model = (current_user.default_model or settings.DEFAULT_TEXT_MODEL) if body.use_model else None
    result = reply_letters.draft(body.kind, facts, pages, profile_of(db, current_user.id), date.today().isoformat(),
                                 ui_language=body.ui_language or "en", model=model,
                                 generate=llm_service.generate_chat if model else None)
    return {**result, "scope": item["scope"], "document_id": item["id"], "workspace_id": item.get("workspace_id"),
            "filename": item["filename"]}
