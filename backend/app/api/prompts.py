import logging
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field, field_validator
from typing import List, Optional
from app.db.session import get_db
from app.db import models
from app.api.auth import get_current_user

router = APIRouter()
logger = logging.getLogger(__name__)

class PromptCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    content: str = Field(..., min_length=1, max_length=50_000)
    tags: Optional[str] = Field(None, max_length=500)

    @field_validator("title", "content")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("must not be blank")
        return v

class PromptUpdate(BaseModel):
    title: Optional[str] = Field(None, min_length=1, max_length=200)
    content: Optional[str] = Field(None, min_length=1, max_length=50_000)
    tags: Optional[str] = Field(None, max_length=500)

class PromptResponse(BaseModel):
    id: int
    title: str
    content: str
    tags: Optional[str] = None
    
    class Config:
        orm_mode = True

@router.get("/", response_model=List[PromptResponse])
def get_prompts(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Get all prompt templates for the current user."""
    return db.query(models.PromptTemplate).filter(
        models.PromptTemplate.user_id == current_user.id
    ).order_by(models.PromptTemplate.created_at.desc()).all()

@router.post("/", response_model=PromptResponse)
def create_prompt(
    prompt: PromptCreate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Create a new prompt template."""
    db_prompt = models.PromptTemplate(
        user_id=current_user.id,
        title=prompt.title,
        content=prompt.content,
        tags=prompt.tags
    )
    db.add(db_prompt)
    db.commit()
    db.refresh(db_prompt)
    return db_prompt

@router.put("/{prompt_id}", response_model=PromptResponse)
def update_prompt(
    prompt_id: int,
    prompt_update: PromptUpdate,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Update an existing prompt template."""
    db_prompt = db.query(models.PromptTemplate).filter(
        models.PromptTemplate.id == prompt_id,
        models.PromptTemplate.user_id == current_user.id
    ).first()
    
    if not db_prompt:
        raise HTTPException(status_code=404, detail="Prompt template not found")
        
    if prompt_update.title is not None:
        db_prompt.title = prompt_update.title
    if prompt_update.content is not None:
        db_prompt.content = prompt_update.content
    if prompt_update.tags is not None:
        db_prompt.tags = prompt_update.tags
        
    db.commit()
    db.refresh(db_prompt)
    return db_prompt

@router.delete("/{prompt_id}")
def delete_prompt(
    prompt_id: int,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """Delete a prompt template."""
    db_prompt = db.query(models.PromptTemplate).filter(
        models.PromptTemplate.id == prompt_id,
        models.PromptTemplate.user_id == current_user.id
    ).first()
    
    if not db_prompt:
        raise HTTPException(status_code=404, detail="Prompt template not found")
        
    db.delete(db_prompt)
    db.commit()
    return {"status": "deleted"}
