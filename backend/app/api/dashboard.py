"""
Dashboard aggregate stats endpoint.
Returns all summary statistics in a single request to avoid N+1 frontend queries.
"""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func
from app.db.session import get_db
from app.db import models
from app.api.auth import get_current_user

router = APIRouter()


@router.get("/stats")
def get_dashboard_stats(
    db: Session = Depends(get_db),
    current_user: models.User = Depends(get_current_user),
):
    """Return workspace count, document count, KB stats and chat count in one query."""
    user_id = current_user.id

    # Workspace count
    workspace_count = (
        db.query(func.count(models.Workspace.id))
        .filter(models.Workspace.user_id == user_id)
        .scalar()
    )

    # Document count (across all workspaces)
    doc_count = (
        db.query(func.count(models.Document.id))
        .join(models.Workspace, models.Document.workspace_id == models.Workspace.id)
        .filter(models.Workspace.user_id == user_id)
        .scalar()
    )

    # Chat count (across all workspaces)
    chat_count = (
        db.query(func.count(models.Chat.id))
        .join(models.Workspace, models.Chat.workspace_id == models.Workspace.id)
        .filter(models.Workspace.user_id == user_id)
        .scalar()
    )

    # Message count
    message_count = (
        db.query(func.count(models.Message.id))
        .join(models.Chat, models.Message.chat_id == models.Chat.id)
        .join(models.Workspace, models.Chat.workspace_id == models.Workspace.id)
        .filter(models.Workspace.user_id == user_id)
        .scalar()
    )

    # KB folders count
    kb_folder_count = (
        db.query(func.count(models.KnowledgeBaseFolder.id))
        .filter(models.KnowledgeBaseFolder.user_id == user_id)
        .scalar()
    )

    # KB documents count (indexed ones)
    kb_doc_count = (
        db.query(func.count(models.KnowledgeBaseDocument.id))
        .join(models.KnowledgeBaseFolder, models.KnowledgeBaseDocument.folder_id == models.KnowledgeBaseFolder.id)
        .filter(
            models.KnowledgeBaseFolder.user_id == user_id,
            models.KnowledgeBaseDocument.status == "indexed",
        )
        .scalar()
    )

    return {
        "workspaces": workspace_count or 0,
        "documents": doc_count or 0,
        "chats": chat_count or 0,
        "messages": message_count or 0,
        "kb_folders": kb_folder_count or 0,
        "kb_documents": kb_doc_count or 0,
    }

import httpx
from fastapi import HTTPException

@router.get("/market-prices")
async def get_market_prices(symbol: str, consent: int = 0):
    """Proxy Yahoo Finance API to avoid frontend CORS issues.

    This is the only dashboard call that leaves the PC, so it only runs after the user switched live prices on
    in the widget (the widget then sends consent=1). Without consent nothing is requested from the internet."""
    if consent != 1:
        raise HTTPException(status_code=403, detail="Live market prices are off. Turn them on in the dashboard widget to allow this external request.")
    if symbol not in ["GC=F", "BZ=F"]:
        raise HTTPException(status_code=400, detail="Invalid symbol")
    
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    headers = {"User-Agent": "Mozilla/5.0"}
    
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, headers=headers, timeout=5.0)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"Failed to fetch market data: {str(e)}")


import time as _time

@router.get("/system-status")
async def get_system_status(
    current_user: models.User = Depends(get_current_user),
):
    """
    Lightweight health probe of all local services.
    Returns status for: backend, Ollama, text model, embedding model.
    This endpoint is NOT auth-gated for health data but IS token-gated to prevent abuse.
    """
    from app.core.config import settings as app_settings

    result = {
        "backend": {"status": "online", "latency_ms": 0, "error": None},
        "ollama": {"status": "unknown", "latency_ms": None, "url": app_settings.OLLAMA_BASE_URL, "error": None},
        "text_model": {
            "name": app_settings.DEFAULT_TEXT_MODEL,
            "status": "unknown",
            "error": None
        },
        "embedding_model": {
            "name": app_settings.DEFAULT_EMBEDDING_MODEL,
            "status": "unknown",
            "error": None
        },
        "available_models": [],
    }

    # Probe Ollama
    ollama_url = app_settings.OLLAMA_BASE_URL
    t0 = _time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=4.0) as client:
            tags_resp = await client.get(f"{ollama_url}/api/tags")
            tags_resp.raise_for_status()
            latency = round((_time.monotonic() - t0) * 1000)
            result["ollama"]["status"] = "online"
            result["ollama"]["latency_ms"] = latency
            result["ollama"]["error"] = None

            models_raw = tags_resp.json().get("models", [])
            available = [m.get("name", "") for m in models_raw]
            result["available_models"] = available

            # Check if configured models are present
            text_model = app_settings.DEFAULT_TEXT_MODEL
            embed_model = app_settings.DEFAULT_EMBEDDING_MODEL

            def _model_present(name: str, available: list[str]) -> bool:
                """Match by prefix — e.g. 'qwen3:latest' matches 'qwen3'."""
                for a in available:
                    if a == name or a.startswith(name.split(":")[0]):
                        return True
                return False

            text_model_present = _model_present(text_model, available)
            embed_model_present = _model_present(embed_model, available)

            result["text_model"]["status"] = "online" if text_model_present else "missing"
            result["text_model"]["error"] = None if text_model_present else f"Model '{text_model}' is missing. Run 'ollama pull {text_model}' in your terminal."

            result["embedding_model"]["status"] = "online" if embed_model_present else "missing"
            result["embedding_model"]["error"] = None if embed_model_present else f"Model '{embed_model}' is missing. Run 'ollama pull {embed_model}' in your terminal."

    except httpx.ConnectError:
        result["ollama"]["status"] = "offline"
        result["ollama"]["error"] = "Ollama is unreachable. Ensure Ollama is installed and running (e.g. 'ollama serve')."
        result["text_model"]["status"] = "offline"
        result["text_model"]["error"] = "Cannot check model (Ollama is offline)."
        result["embedding_model"]["status"] = "offline"
        result["embedding_model"]["error"] = "Cannot check model (Ollama is offline)."
    except Exception as e:
        result["ollama"]["status"] = "degraded"
        result["ollama"]["error"] = f"Ollama connection error: {str(e)}"
        result["text_model"]["status"] = "unknown"
        result["embedding_model"]["status"] = "unknown"

    return result

