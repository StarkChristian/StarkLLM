"""Settings > Letters from a folder: the watched folders of the user, their import history and the notices
("3 letters imported from Scans"). The watching itself is services/watch_service.py."""
import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.db import models
from app.db.session import get_db
from app.services import watch_service
from app.services.watch_service import watcher

router = APIRouter()


class FolderIn(BaseModel):
    folder_path: str
    workspace_id: int
    import_existing: bool = False      # also import the files that are in the folder now
    move_imported: bool = False


class FolderChange(BaseModel):
    workspace_id: Optional[int] = None
    move_imported: Optional[bool] = None
    is_active: Optional[bool] = None


def _workspace(db: Session, user: models.User, workspace_id: int) -> models.Workspace:
    ws = db.query(models.Workspace).filter(models.Workspace.id == workspace_id,
                                           models.Workspace.user_id == user.id).first()
    if ws is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return ws


def _folder(db: Session, user: models.User, folder_id: int) -> models.WatchedFolder:
    folder = db.query(models.WatchedFolder).filter(models.WatchedFolder.id == folder_id,
                                                   models.WatchedFolder.user_id == user.id).first()
    if folder is None:
        raise HTTPException(status_code=404, detail="Folder not found")
    return folder


def _out(db: Session, folder: models.WatchedFolder) -> dict:
    ws = db.query(models.Workspace).filter(models.Workspace.id == folder.workspace_id).first()
    imported = db.query(models.WatchedImport.id).filter(models.WatchedImport.folder_id == folder.id,
                                                        models.WatchedImport.status == "imported").count()
    path = folder.folder_path or ""
    return {
        "id": folder.id,
        "folder_path": path,
        "folder_name": watch_service.folder_label(path),
        "workspace_id": folder.workspace_id,
        "workspace_name": ws.name if ws else None,
        "move_imported": bool(folder.move_imported),
        "is_active": bool(folder.is_active),
        "network": watch_service.is_network_path(path),
        "available": os.path.isdir(path),
        "imported_count": imported,
        "created_at": folder.created_at.isoformat() if folder.created_at else None,
    }


@router.get("/")
@router.get("", include_in_schema=False)
def list_folders(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    folders = (db.query(models.WatchedFolder).filter(models.WatchedFolder.user_id == current_user.id)
               .order_by(models.WatchedFolder.id).all())
    return [_out(db, f) for f in folders]


@router.post("/")
@router.post("", include_in_schema=False)
def add_folder(body: FolderIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    _workspace(db, current_user, body.workspace_id)
    try:
        path = watch_service.check_folder(body.folder_path)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    wanted = watch_service.normalized(path)
    for other in db.query(models.WatchedFolder).filter(models.WatchedFolder.user_id == current_user.id).all():
        if other.folder_path and watch_service.normalized(other.folder_path) == wanted:
            raise HTTPException(status_code=409, detail="This folder is watched already.")
    folder = models.WatchedFolder(user_id=current_user.id, workspace_id=body.workspace_id, folder_path=path,
                                  move_imported=1 if body.move_imported else 0, is_active=1)
    db.add(folder)
    db.commit()
    db.refresh(folder)
    existing = 0
    if not body.import_existing:
        existing = watcher.mark_existing(db, folder)   # only what arrives from now on (and while StarkLLM is closed)
    out = _out(db, folder)
    out["existing_files"] = existing
    return out


@router.patch("/{folder_id}")
def change_folder(folder_id: int, body: FolderChange, db: Session = Depends(get_db),
                  current_user: models.User = Depends(get_current_user)):
    folder = _folder(db, current_user, folder_id)
    if body.workspace_id is not None:
        _workspace(db, current_user, body.workspace_id)
        folder.workspace_id = body.workspace_id
    if body.move_imported is not None:
        folder.move_imported = 1 if body.move_imported else 0
    if body.is_active is not None:
        folder.is_active = 1 if body.is_active else 0
    db.commit()
    watcher.forget_folder(folder.id)
    return _out(db, folder)


@router.delete("/{folder_id}")
def remove_folder(folder_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Stops watching. The folder and its files stay as they are; imported letters stay in the inbox."""
    folder = _folder(db, current_user, folder_id)
    db.query(models.WatchedImport).filter(models.WatchedImport.folder_id == folder.id).delete(synchronize_session=False)
    db.delete(folder)
    db.commit()
    watcher.forget_folder(folder_id)
    return {"status": "removed"}


@router.get("/history")
def history(limit: int = watch_service.HISTORY_LIMIT, db: Session = Depends(get_db),
            current_user: models.User = Depends(get_current_user)):
    rows = (db.query(models.WatchedImport, models.WatchedFolder)
            .join(models.WatchedFolder, models.WatchedImport.folder_id == models.WatchedFolder.id)
            .filter(models.WatchedImport.user_id == current_user.id, models.WatchedImport.status != "existing")
            .order_by(models.WatchedImport.id.desc()).limit(max(1, min(limit, 1000))).all())
    return [{
        "id": row.id,
        "folder_id": row.folder_id,
        "folder_name": watch_service.folder_label(folder.folder_path),
        "file_name": row.file_name,
        "status": row.status,
        "error": row.error,
        "moved": bool(row.moved),
        "document_id": row.document_id,
        "workspace_id": row.workspace_id,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    } for row, folder in rows]


@router.post("/history/{import_id}/retry")
def retry(import_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """A failed import is tried again at the next look at the folder (if the file is still there)."""
    row = db.query(models.WatchedImport).filter(models.WatchedImport.id == import_id,
                                                models.WatchedImport.user_id == current_user.id,
                                                models.WatchedImport.status == "failed").first()
    if row is None:
        raise HTTPException(status_code=404, detail="Entry not found")
    folder_id = row.folder_id
    db.delete(row)
    db.commit()
    watcher.forget_file(folder_id)
    return {"status": "queued"}


@router.post("/notices")
def take_notices(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    return watch_service.notices(db, current_user.id)
