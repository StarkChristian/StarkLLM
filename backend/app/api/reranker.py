"""Settings > Document search: the optional multilingual reranker (services/reranker.py).

Everyone may look; downloading or removing it is for the instance administrator, because the model is shared by all
accounts of this installation (like the OCR language packs). The download starts only with this request, which the
Settings page sends after the user clicked the button that shows the size."""
import logging

from fastapi import APIRouter, Depends, HTTPException

from app.api.auth import get_current_user
from app.api.system import require_admin
from app.core import netguard
from app.db import models
from app.services import reranker

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("")
def get_status(current_user: models.User = Depends(get_current_user)):
    return {**reranker.status(), "offline": netguard.is_offline()}


@router.post("/install")
def install(current_user: models.User = Depends(require_admin)):
    if reranker.installed():
        return {**reranker.status(), "offline": netguard.is_offline()}
    if netguard.is_offline():
        raise HTTPException(status_code=409, detail="Fully offline mode is on: turn it off in Settings > Privacy & network to download the model.")
    reranker.start_download()
    return {**reranker.status(), "offline": False}


@router.delete("")
def remove(current_user: models.User = Depends(require_admin)):
    try:
        reranker.remove()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {**reranker.status(), "offline": netguard.is_offline()}
