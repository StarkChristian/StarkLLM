import os
import json
import logging
from typing import Optional, List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.db.session import get_db
from app.db import models
from app.core.config import settings
from app.api.auth import get_current_user
from app.services.llm_service import llm_service

router = APIRouter()
logger = logging.getLogger(__name__)

class SynthesizeStudioRequest(BaseModel):
    type: str  # "podcast" | "briefing" | "study_guide" | "comparison"
    model: Optional[str] = None
    focus: Optional[str] = None
    language: Optional[str] = None  # the interface language ("de", "en"): the result is written in it

# Files that are plain text. Everything else (images, Word, Excel, ...) is read only through the text
# StarkLLM extracted when it indexed the file: reading an image as text gave the model JPEG bytes.
TEXT_FILES = {"txt", "md", "markdown", "csv", "tsv", "json", "xml", "log", "html", "htm", "yaml", "yml",
              "ini", "cfg", "toml"}
LANGUAGE_NAMES = {"de": "German", "en": "English"}


def _document_text(collection, doc) -> str:
    """The text of one document: the pieces made when it was indexed (with OCR for images and scans), else
    the PDF text or the file itself if it is plain text. Never the raw bytes of a binary file."""
    if collection is not None:
        try:
            got = collection.get(where={"source": doc.filepath}, include=["documents"])
            text = "\n".join(d for d in (got.get("documents") or []) if d)
            if text.strip():
                return text
        except Exception as e:
            logger.warning(f"Studio: indexed text of {doc.filename} not readable: {e}")
    if not doc.filepath or not os.path.exists(doc.filepath):
        return ""
    ext = (doc.file_type or os.path.splitext(doc.filepath)[1]).lower().strip(".")
    if ext == "pdf":
        try:
            import fitz
            with fitz.open(doc.filepath) as pdf:
                return "\n".join(pdf[p].get_text("text") for p in range(min(len(pdf), 15)))
        except Exception as e:
            logger.warning(f"Studio: PDF {doc.filename} not readable: {e}")
            return ""
    if ext in TEXT_FILES:
        with open(doc.filepath, "r", encoding="utf-8", errors="replace") as f:
            return f.read(8000)
    return ""


def _extract_workspace_context(db: Session, workspace_id: int, user_id: int, max_chars: int = 14000) -> str:
    """Text of the workspace's documents, every document with a fair share of max_chars."""
    docs = db.query(models.Document).filter(
        models.Document.workspace_id == workspace_id,
        models.Document.status == models.DocStatus.INDEXED
    ).all()

    if not docs:
        docs = db.query(models.Document).filter(
            models.Document.workspace_id == workspace_id
        ).all()

    if not docs:
        raise HTTPException(
            status_code=400,
            detail="No documents found in this workspace. Upload documents before generating studio overviews."
        )

    try:
        from app.services.rag_service import rag_service
        collection = rag_service.get_or_create_collection(workspace_id, user_id)
    except Exception as e:
        logger.warning(f"Studio: workspace collection not available: {e}")
        collection = None

    # Before, the first three or four documents filled the budget and the rest were left out.
    share = min(4000, max(600, max_chars // len(docs)))
    context_parts = []
    for doc in docs:
        try:
            clean_text = " ".join(_document_text(collection, doc).split())
        except Exception as e:
            logger.warning(f"Error extracting context for {doc.filename}: {e}")
            continue
        if clean_text:
            context_parts.append(f"=== Document: {doc.filename} ===\n{clean_text[:share]}\n")

    if not context_parts:
        raise HTTPException(
            status_code=400,
            detail="Unable to extract readable text from workspace documents."
        )

    return "\n\n".join(context_parts)


def _ground_rules(language: Optional[str]) -> str:
    """Appended to every studio prompt: the answer language, today's date, no invented facts."""
    from datetime import date
    lang = LANGUAGE_NAMES.get((language or "").lower()[:2])
    write_in = (f"Write all text for the reader in {lang}, also when the documents are in another language; "
                "translate the section headings given above too (keep JSON keys as given)."
                if lang else "Write in the language of the documents.")
    return (f"\n\nToday is {date.today().isoformat()}. {write_in} Use only names, numbers and dates that appear in "
            "the source documents; never invent a date, author or recipient. If a document's text is empty or "
            "unreadable, leave it out without comment.")


@router.post("/{workspace_id}/synthesize")
async def synthesize_studio(
    workspace_id: int,
    req: SynthesizeStudioRequest,
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user)
):
    """
    AI Studio Synthesizer (Offline-first):
    Generates Podcast Audio Overviews, Executive Briefings, Study Guides & Quizzes,
    or Comparative Matrices directly from workspace documents.
    """
    ws = db.query(models.Workspace).filter(
        models.Workspace.id == workspace_id,
        models.Workspace.user_id == current_user.id
    ).first()
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")

    context_corpus = _extract_workspace_context(db, workspace_id, current_user.id)
    target_model = req.model or current_user.default_model or settings.DEFAULT_TEXT_MODEL

    focus_note = f"Specific Focus: {req.focus}\n" if req.focus else ""

    if req.type == "podcast":
        system_prompt = (
            "You are an award-winning podcast producer and AI research analyst. "
            "You transform dense technical or business documents into an engaging, natural, "
            "conversational Audio Overview between two insightful hosts: "
            "Alex (curious, analytical, frames the big picture) and "
            "Taylor (sharp, grounded, dives into key evidence and practical implications).\n\n"
            "Rules for Dialogue:\n"
            "- Make it sound completely authentic, engaging, and dynamic.\n"
            "- Start with an energetic greeting and preview the topic.\n"
            "- Have hosts naturally build on each other's points, ask clarifying questions, and use conversational transitions.\n"
            "- Strictly ground all facts in the provided source documents. Do not hallucinate external facts.\n"
            "- Produce exactly 8 to 14 dialogue turns.\n"
            "- Output MUST be pure JSON with no markdown wrapping or preamble, matching this exact schema:\n"
            "{\n"
            '  "title": "Title of Podcast Episode",\n'
            '  "summary": "Brief 2-sentence episode summary",\n'
            '  "dialogue": [\n'
            '    {"speaker": "Alex", "text": "..."},\n'
            '    {"speaker": "Taylor", "text": "..."}\n'
            "  ]\n"
            "}"
        )
        user_prompt = (
            f"{focus_note}"
            f"Here are the source documents:\n\n{context_corpus}\n\n"
            "Generate the conversational 2-host audio overview script in pure JSON now:"
        )

    elif req.type == "briefing":
        system_prompt = (
            "You are a top-tier management consultant and technical strategist. "
            "Synthesize the provided documents into a high-impact, professional Executive Briefing. "
            "Use clear Markdown formatting with sections: \n"
            "# Executive Summary\n"
            "## Strategic Highlights & Core Discoveries\n"
            "## Risk Assessment & Critical Assumptions\n"
            "## Recommended Decisions & Action Items\n"
            "Ground every insight strictly in the source documents with specific references."
        )
        user_prompt = (
            f"{focus_note}"
            f"Source Documents:\n\n{context_corpus}\n\n"
            "Generate the comprehensive Executive Briefing now:"
        )

    elif req.type == "study_guide":
        system_prompt = (
            "You are an expert educator and research mentor. "
            "Create a master Study Guide and Interactive Quiz based on the provided documents.\n"
            "Output MUST be pure JSON matching this schema:\n"
            "{\n"
            '  "title": "Master Study Guide",\n'
            '  "overview": "Comprehensive overview paragraph",\n'
            '  "concepts": [\n'
            '    {"name": "Concept Name", "definition": "Clear concise definition grounded in text"}\n'
            '  ],\n'
            '  "quiz": [\n'
            '    {"question": "Insightful question testing understanding", "answer": "Detailed answer citing evidence from the text"}\n'
            '  ]\n'
            "}"
        )
        user_prompt = (
            f"{focus_note}"
            f"Source Documents:\n\n{context_corpus}\n\n"
            "Generate the Study Guide and Quiz JSON now:"
        )

    elif req.type == "comparison":
        system_prompt = (
            "You are an analytical research scientist. "
            "Compare and contrast the themes, methodologies, viewpoints, and data across the provided workspace documents. "
            "Provide a structured Markdown output with an Executive Synthesis, a detailed Markdown comparison table, "
            "and Key Divergences / Synergies."
        )
        user_prompt = (
            f"{focus_note}"
            f"Source Documents:\n\n{context_corpus}\n\n"
            "Generate the Comparative Analysis now:"
        )
    else:
        raise HTTPException(status_code=400, detail=f"Unsupported studio synthesis type: {req.type}")

    system_prompt += _ground_rules(req.language)

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt}
    ]

    try:
        response = llm_service.generate_chat(
            model=target_model,
            messages=messages,
            stream=False,
            options={"temperature": 0.4, "top_p": 0.9}
        )

        reply_content = response.get("message", {}).get("content", "").strip()

        # Handle JSON parsing for podcast and study_guide
        if req.type in ("podcast", "study_guide"):
            # Strip markdown json codeblocks if returned
            clean_json = reply_content
            if "```json" in clean_json:
                clean_json = clean_json.split("```json", 1)[1].split("```", 1)[0].strip()
            elif "```" in clean_json:
                clean_json = clean_json.split("```", 1)[1].split("```", 1)[0].strip()

            try:
                parsed_data = json.loads(clean_json)
                return {
                    "type": req.type,
                    "model": target_model,
                    "data": parsed_data
                }
            except Exception as json_err:
                logger.warning(f"Could not parse LLM output as JSON ({json_err}). Returning raw text.")
                return {
                    "type": req.type,
                    "model": target_model,
                    "raw": reply_content
                }
        else:
            return {
                "type": req.type,
                "model": target_model,
                "content": reply_content
            }

    except Exception as e:
        logger.error(f"Studio generation failed: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Studio synthesis failed: {str(e)}")
