"""Settings > Other apps: turn access for other programs on or off, create and delete their keys."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.api.auth import get_current_user
from app.db import models
from app.services import connections_service

router = APIRouter()


class Switch(BaseModel):
    enabled: bool


class NewKey(BaseModel):
    name: str = Field(default="", max_length=60)


@router.get("")
def get_state(current_user: models.User = Depends(get_current_user)):
    return connections_service.state()


@router.put("")
def set_state(body: Switch, current_user: models.User = Depends(get_current_user)):
    return connections_service.set_enabled(body.enabled)


@router.post("/keys")
def create_key(body: NewKey, current_user: models.User = Depends(get_current_user)):
    """The full key is in this answer only; StarkLLM keeps just its hash."""
    return connections_service.create_key(body.name, current_user.id)


@router.delete("/keys/{key_id}")
def delete_key(key_id: str, current_user: models.User = Depends(get_current_user)):
    if not connections_service.delete_key(key_id):
        raise HTTPException(status_code=404, detail="Key not found")
    return {"ok": True}
