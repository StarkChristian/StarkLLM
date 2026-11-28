"""Shared household workspaces: create, invite by account name, accept once, leave, remove, delete, and who did what
(services/household.py, docs/household-design.md). A paired phone uses the same session as its account, so it has
exactly that account's rights."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.db import models
from app.db.session import get_db
from app.services import household
from app.services.household import HouseholdError

router = APIRouter()


class SharedCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


class InviteIn(BaseModel):
    username: str = Field(..., min_length=1, max_length=64)


def _fail(e: HouseholdError):
    raise HTTPException(status_code=e.status, detail={"code": e.code, "message": str(e)})


@router.get("")
@router.get("/", include_in_schema=False)
def get_household(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Invitations waiting for this account, and the shared workspaces it is in, with their members."""
    return household.overview(db, current_user.id)


@router.post("/workspaces")
def create_shared_workspace(body: SharedCreate, db: Session = Depends(get_db),
                            current_user: models.User = Depends(get_current_user)):
    try:
        ws = household.create_shared(db, current_user, body.name)
    except HouseholdError as e:
        _fail(e)
    return {"id": ws.id, "name": ws.name, "shared": True, "role": household.OWNER, "owner": current_user.username}


@router.post("/workspaces/{workspace_id}/invite")
def invite_member(workspace_id: int, body: InviteIn, db: Session = Depends(get_db),
                  current_user: models.User = Depends(get_current_user)):
    """The owner invites another account of this PC by its name. It sees nothing until it accepts."""
    try:
        m = household.invite(db, workspace_id, current_user.id, body.username)
    except HouseholdError as e:
        _fail(e)
    return {"workspace_id": workspace_id, "user_id": m.user_id, "status": m.status}


@router.post("/invitations/{workspace_id}/accept")
def accept_invitation(workspace_id: int, db: Session = Depends(get_db),
                      current_user: models.User = Depends(get_current_user)):
    try:
        ws = household.accept(db, workspace_id, current_user.id)
    except HouseholdError as e:
        _fail(e)
    return {"id": ws.id, "name": ws.name, "shared": True, "role": household.MEMBER}


@router.post("/invitations/{workspace_id}/decline")
def decline_invitation(workspace_id: int, db: Session = Depends(get_db),
                       current_user: models.User = Depends(get_current_user)):
    try:
        household.decline(db, workspace_id, current_user.id)
    except HouseholdError as e:
        _fail(e)
    return {"status": "declined"}


@router.post("/workspaces/{workspace_id}/leave")
def leave_workspace(workspace_id: int, db: Session = Depends(get_db),
                    current_user: models.User = Depends(get_current_user)):
    """A member leaves: they lose access at once; their own chats in it are deleted."""
    try:
        return household.remove_member(db, workspace_id, current_user.id, current_user.id)
    except HouseholdError as e:
        _fail(e)


@router.delete("/workspaces/{workspace_id}/members/{user_id}")
def remove_member(workspace_id: int, user_id: int, db: Session = Depends(get_db),
                  current_user: models.User = Depends(get_current_user)):
    """The owner removes a member (or withdraws an invitation)."""
    try:
        return household.remove_member(db, workspace_id, current_user.id, user_id)
    except HouseholdError as e:
        _fail(e)


@router.delete("/workspaces/{workspace_id}")
def delete_shared_workspace(workspace_id: int, db: Session = Depends(get_db),
                            current_user: models.User = Depends(get_current_user)):
    """Only the owner deletes the workspace: its letters, and every member's chats in it."""
    from app.api.workspaces import delete_workspace_completely
    ws = db.query(models.Workspace).filter_by(id=workspace_id, shared=1).first()
    r = household.role(db, ws, current_user.id)
    if r is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    if r != household.OWNER:
        _fail(HouseholdError("owner_only", "Only the owner of the workspace can do this.", 403))
    delete_workspace_completely(db, ws)
    return {"status": "deleted"}


@router.get("/workspaces/{workspace_id}/activity")
def get_activity(workspace_id: int, db: Session = Depends(get_db),
                 current_user: models.User = Depends(get_current_user)):
    """Who did what in the shared workspace, newest first."""
    ws = db.query(models.Workspace).filter_by(id=workspace_id, shared=1).first()
    if household.role(db, ws, current_user.id) is None:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return {"workspace_id": workspace_id, "activity": household.activity(db, workspace_id)}
