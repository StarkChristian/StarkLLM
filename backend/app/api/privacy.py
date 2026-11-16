"""Settings > Privacy: the fully offline switch and the list of outgoing connections (roadmap phase 3)."""
import csv
import io

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel

from app.api.auth import desktop_key_valid, get_current_user
from app.api.system import is_admin
from app.core import netguard
from app.db import models
from app.db.session import get_db

router = APIRouter()

CSV_COLUMNS = ["time", "source", "feature", "purpose", "host", "port", "method", "zone", "outcome", "bytes_out",
               "bytes_in", "status", "error"]


class OfflineSwitch(BaseModel):
    enabled: bool


@router.get("/status")
def get_status(current_user: models.User = Depends(get_current_user)):
    return netguard.status()


OFF_NOT_ALLOWED = ('Only the administrator of this StarkLLM, or the account that turned "Fully offline" on, '
                   'can turn it off.')


@router.put("/offline")
def put_offline(body: OfflineSwitch, current_user: models.User = Depends(get_current_user), db=Depends(get_db)):
    # Turning it on is always allowed, and who did it is kept. Turning it off lets the engine reach the internet again
    # for every account: the administrator may, and so may the account that turned it on (nobody else is affected
    # more than before it did). When it came from the desktop app or STARKLLM_OFFLINE (set_by None), only the
    # administrator, or the desktop app through /offline/desktop.
    if not body.enabled and netguard.is_offline():
        set_by = netguard.offline_set_by()
        if not (is_admin(current_user, db) or (set_by is not None and set_by == current_user.id)):
            raise HTTPException(status_code=403, detail=OFF_NOT_ALLOWED)
    netguard.set_offline(body.enabled, set_by=current_user.id)
    return netguard.status()


@router.put("/offline/desktop")
def put_offline_desktop(body: OfflineSwitch, x_desktop_key: str = Header(default="")):
    """The switch of the desktop app on this PC: the person at the app owns the PC (like the first-start question), so
    it may turn it on and off. Authorised by the same key as /auth/desktop-session."""
    if not desktop_key_valid(x_desktop_key):
        raise HTTPException(status_code=403, detail="Not allowed")
    netguard.set_offline(body.enabled, set_by=None)
    return netguard.status()


@router.get("/network-log")
def get_network_log(limit: int = Query(500, ge=1, le=5000), current_user: models.User = Depends(get_current_user)):
    return {"status": netguard.status(), "features": netguard.FEATURES, "entries": netguard.entries(limit)}


@router.delete("/network-log")
def delete_network_log(current_user: models.User = Depends(get_current_user)):
    netguard.clear_log()
    return {"ok": True}


@router.get("/network-log/export")
def export_network_log(format: str = Query("csv", pattern="^(csv|json)$"), current_user: models.User = Depends(get_current_user)):
    rows = netguard.entries(5000)
    if format == "json":
        import json
        return Response(json.dumps(rows, ensure_ascii=False, indent=1), media_type="application/json",
                        headers={"Content-Disposition": 'attachment; filename="starkllm-network-log.json"'})
    out = io.StringIO()
    w = csv.DictWriter(out, fieldnames=CSV_COLUMNS, extrasaction="ignore")
    w.writeheader()
    for r in rows:
        # a cell that starts with = + - @ is read as a formula by spreadsheet programs
        w.writerow({k: ("'" + str(v) if isinstance(v, str) and v[:1] in "=+-@" else v) for k, v in r.items() if k in CSV_COLUMNS})
    return Response(out.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="starkllm-network-log.csv"'})
