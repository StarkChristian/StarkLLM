"""
Model management routes (Ollama model hub).

Extracted from chat.py to keep chat.py focused on conversation logic.
Mounted at /api/v1/chat by the main router (same prefix as before).
"""

import logging
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.services.llm_service import llm_service

router = APIRouter()
logger = logging.getLogger(__name__)


class PullModelRequest(BaseModel):
    model_name: str


@router.get("/models")
def get_models():
    """Return available models from Ollama."""
    models = llm_service.get_available_models()
    return {"models": models}


@router.get("/models/detailed")
def get_detailed_models():
    """Return detailed metadata for all installed Ollama models."""
    models = llm_service.get_detailed_models()
    return {"models": models}


@router.get("/models/catalog")
def get_model_catalog():
    """Return curated list of recommended models with installation status."""
    catalog = llm_service.get_recommended_catalog()
    return {"catalog": catalog}


@router.post("/models/pull")
def pull_model(req: PullModelRequest):
    """Stream model download progress from Ollama."""
    return StreamingResponse(
        llm_service.pull_model_stream(req.model_name),
        media_type="application/x-ndjson"
    )


@router.delete("/models/{model_name:path}")
def delete_model(model_name: str):
    """Delete an installed model from Ollama."""
    success = llm_service.delete_model(model_name)
    if not success:
        from fastapi import HTTPException
        raise HTTPException(status_code=500, detail=f"Failed to delete model {model_name}")
    return {"status": "success", "message": f"Model {model_name} deleted successfully"}
