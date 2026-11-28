"""
Model management routes (Ollama model hub).

Extracted from chat.py to keep chat.py focused on conversation logic.
Mounted at /api/v1/chat by the main router (same prefix as before).
"""

import logging
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.api.auth import get_current_user
from app.services.llm_service import llm_service, RECOMMENDED_MODELS
from app.services import model_fit

# Every route here lists, downloads or deletes models on the PC's Ollama, so a logged-in user is required.
router = APIRouter(dependencies=[Depends(get_current_user)])
logger = logging.getLogger(__name__)


class PullModelRequest(BaseModel):
    model_name: str


@router.get("/models")
def get_models():
    """Return available models from Ollama."""
    models = llm_service.get_available_models()
    return {"models": models}


def _catalog_sizes() -> dict:
    return {m["name"]: model_fit.parse_size(m.get("size")) for m in RECOMMENDED_MODELS}


@router.get("/models/detailed")
def get_detailed_models():
    """Return detailed metadata for all installed Ollama models, each with whether it fits this PC."""
    models = llm_service.get_detailed_models()
    hw = model_fit.detect_hardware()
    for m in models:
        if isinstance(m, dict):
            m["fit"] = model_fit.assess(m.get("size") or 0, hw, installed=True)
    return {"models": models}


@router.get("/models/catalog")
def get_model_catalog():
    """Return curated list of recommended models with installation status, size and whether each fits this PC."""
    catalog = llm_service.get_recommended_catalog()
    hw = model_fit.detect_hardware()
    rec = model_fit.recommendation(hw, _catalog_sizes())
    for item in catalog:
        item["size_bytes"] = model_fit.parse_size(item.get("size"))
        item["fit"] = model_fit.assess(item["size_bytes"], hw, installed=bool(item.get("is_installed")))
        item["recommended"] = ("text" if item["name"] == rec["text"]["name"]
                               else "vision" if item["name"] == rec["vision"]["name"] else None)
    return {"catalog": catalog, "recommendation": rec}


@router.get("/models/hardware")
def get_hardware():
    """The hardware of this PC and the chat and image model recommended for it (the model picker)."""
    hw = model_fit.detect_hardware()
    return {"hardware": hw, "recommendation": model_fit.recommendation(hw, _catalog_sizes())}


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
        raise HTTPException(status_code=500, detail=f"Failed to delete model {model_name}")
    return {"status": "success", "message": f"Model {model_name} deleted successfully"}
