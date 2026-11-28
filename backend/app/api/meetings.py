"""Meeting assistant (services/meetings.py): record on this PC, write down, summarize, confirm tasks.

  POST   /meetings/sessions                     start (only with the consent that everyone agreed to be recorded)
  PUT    /meetings/sessions/{id}/parts/{n}      one part of the recording (raw bytes), every few seconds
  POST   /meetings/sessions/{id}/stop           the recording becomes a document in the chosen workspace
  GET    /meetings/sessions/unfinished          recordings a crash left behind: write them down or discard them
  DELETE /meetings/sessions/{id}                discard a recording
  GET    /meetings?workspace_id=                the meetings (which documents are meetings, audio still there?)
  GET    /meetings/{id}/audio                   listen again
  DELETE /meetings/{id}/audio                   delete the audio, keep the text
  GET    /meetings/{id}/summary                 the stored summary
  POST   /meetings/{id}/summary                 summarize the meeting (the local model; checked against the transcript)
  POST   /meetings/{id}/tasks/{index}           add a proposed task to the list (optionally changed) or skip it
  GET    /meetings/tasks                        the confirmed tasks (the inbox's deadline list)
  PUT    /meetings/tasks/{id}                   done / not done
  DELETE /meetings/tasks/{id}                   remove from the list

Everything stays on this PC; nothing here opens a connection.
"""
import json
import logging
import os
import secrets
import threading
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.auth import get_current_user
from app.core.config import settings
from app.core.protection import ProtectionLocked
from app.db import models
from app.db.models import DocStatus
from app.db.session import get_db
from app.services import meetings, vault

router = APIRouter()
logger = logging.getLogger(__name__)


def _workspace(db, user_id: int, workspace_id: int):
    ws = db.query(models.Workspace).filter(models.Workspace.id == workspace_id, models.Workspace.user_id == user_id).first()
    if not ws:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return ws


def _own_session(sid: str, user_id: int) -> dict:
    try:
        meta = meetings.session_meta(sid)
    except meetings.MeetingError:
        raise HTTPException(status_code=404, detail="Recording not found")
    if meta.get("user_id") != user_id:
        raise HTTPException(status_code=404, detail="Recording not found")
    return meta


def _own_meeting(db, user_id: int, meeting_id: int):
    m = db.query(models.MeetingRecording).filter(models.MeetingRecording.id == meeting_id,
                                                 models.MeetingRecording.user_id == user_id).first()
    if not m:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return m


# ------------------------------------------------------------------------------------------------ recording

class StartIn(BaseModel):
    workspace_id: int
    consent: bool = False          # the user confirmed that everyone in the meeting agreed to be recorded
    system_audio: bool = False
    language: Optional[str] = Field(None, max_length=10)
    mime: Optional[str] = Field("audio/webm", max_length=60)


@router.post("/sessions")
def start_recording(body: StartIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Start a recording. Refused without the consent: a meeting is only recorded when everyone in it agreed."""
    if not body.consent:
        raise HTTPException(status_code=400, detail="Please confirm that everyone in the meeting agreed to be recorded.")
    _workspace(db, current_user.id, body.workspace_id)
    sid = meetings.start_session(current_user.id, body.workspace_id, body.mime or "audio/webm", body.system_audio, body.language)
    return {"id": sid, "part_seconds": meetings.PART_SECONDS}


@router.put("/sessions/{sid}/parts/{index}")
async def save_part(sid: str, index: int, request: Request, current_user: models.User = Depends(get_current_user)):
    _own_session(sid, current_user.id)
    data = await request.body()
    try:
        return meetings.save_part(sid, index, data)
    except meetings.MeetingError as e:
        raise HTTPException(status_code=413 if "large" in str(e) or "long" in str(e) else 400, detail=str(e))


@router.get("/sessions/unfinished")
def unfinished(current_user: models.User = Depends(get_current_user)):
    return {"sessions": meetings.unfinished(current_user.id)}


@router.delete("/sessions/{sid}")
def discard(sid: str, current_user: models.User = Depends(get_current_user)):
    _own_session(sid, current_user.id)
    meetings.discard(sid)
    return {"ok": True}


class StopIn(BaseModel):
    title: Optional[str] = Field(None, max_length=120)   # the document's name, in the language of the interface


def stop_session(db, user_id: int, sid: str, title: Optional[str] = None) -> models.MeetingRecording:
    """The parts into one recording, the transcript document (written down in the background) and the meeting row."""
    from app.api.documents import _disk_name
    meta = _own_session(sid, user_id)
    _workspace(db, user_id, meta["workspace_id"])
    if not meetings.parts(sid):
        raise HTTPException(status_code=400, detail="Nothing was recorded.")
    started = meta.get("started") or datetime.now().isoformat(timespec="seconds")
    name = " ".join("".join(c for c in (title or "") if c not in '<>:"/\\|?*' and c >= " ").split()).strip(" .")
    name = (name or f"Meeting {started[:16].replace('T', ' ').replace(':', '.')}")[:120] + ".txt"
    prefix = secrets.token_hex(4)
    audio = os.path.join(meetings.meetings_dir(), f"{prefix}{secrets.token_hex(4)}{meetings.audio_extension(sid)}")
    text_path = os.path.join(os.path.abspath(settings.UPLOAD_DIR), _disk_name(prefix, name))
    meetings.assemble(sid, audio)
    doc = models.Document(workspace_id=meta["workspace_id"], filename=name, filepath=text_path, file_type="txt",
                          status=DocStatus.UPLOADING)
    db.add(doc)
    db.flush()
    m = models.MeetingRecording(user_id=user_id, scope="ws", document_id=doc.id, workspace_id=meta["workspace_id"],
                                audio_path=audio, mime=meta.get("mime"), started=started, language=meta.get("language"),
                                system_audio=bool(meta.get("system_audio")), status="transcribing")
    db.add(m)
    db.commit()
    db.refresh(m)
    meetings.discard(sid)
    return m


@router.post("/sessions/{sid}/stop")
def stop_recording(sid: str, body: StopIn = None, db: Session = Depends(get_db),
                   current_user: models.User = Depends(get_current_user)):
    """Stop (also for a recording a crash left behind): it is written down on this PC in the background and becomes
    a document of the chosen workspace."""
    try:
        m = stop_session(db, current_user.id, sid, (body.title if body else None))
    except ProtectionLocked:
        raise
    threading.Thread(target=meetings.transcribe_meeting, args=(m.id,), daemon=True).start()
    return _meeting_out(m)


# ------------------------------------------------------------------------------------------------ meetings

def _meeting_out(m) -> dict:
    summary = json.loads(m.summary) if m.summary else None
    return {"id": m.id, "document_id": m.document_id, "workspace_id": m.workspace_id, "started": m.started,
            "duration": m.duration, "language": m.language, "status": m.status,
            "has_audio": bool(m.audio_path and os.path.exists(m.audio_path)), "system_audio": bool(m.system_audio),
            "has_summary": summary is not None}


@router.get("")
def list_meetings(workspace_id: Optional[int] = Query(None), db: Session = Depends(get_db),
                  current_user: models.User = Depends(get_current_user)):
    q = db.query(models.MeetingRecording).filter(models.MeetingRecording.user_id == current_user.id)
    if workspace_id is not None:
        q = q.filter(models.MeetingRecording.workspace_id == workspace_id)
    return {"meetings": [_meeting_out(m) for m in q.order_by(models.MeetingRecording.id.desc()).all()]}


@router.get("/tasks")
def list_tasks(db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """The tasks the user added from meetings, those with a day first (soonest first), then the others."""
    rows = db.query(models.MeetingTask).filter(models.MeetingTask.user_id == current_user.id).all()
    docs = {d.id: d for d in db.query(models.Document).filter(models.Document.id.in_([r.document_id for r in rows] or [-1])).all()}
    today = date.today()
    out = []
    for r in rows:
        doc = docs.get(r.document_id)
        out.append({"id": r.id, "meeting_id": r.meeting_id, "document_id": r.document_id,
                    "workspace_id": doc.workspace_id if doc else None, "filename": doc.filename if doc else None,
                    "text": r.text, "owner": r.owner, "due_text": r.due_text, "due_date": r.due_date,
                    "days": (date.fromisoformat(r.due_date) - today).days if r.due_date else None,
                    "time": meetings_stamp(r.seconds), "seconds": r.seconds, "done": bool(r.done)})
    out.sort(key=lambda t: (t["done"], t["due_date"] is None, t["due_date"] or "", t["meeting_id"], t["seconds"]))
    return {"today": today.isoformat(), "tasks": out}


def meetings_stamp(seconds) -> str:
    from app.services.recordings import stamp
    return stamp(seconds)


class TaskStateIn(BaseModel):
    done: bool


@router.put("/tasks/{task_id}")
def set_task(task_id: int, body: TaskStateIn, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    r = db.query(models.MeetingTask).filter(models.MeetingTask.id == task_id, models.MeetingTask.user_id == current_user.id).first()
    if not r:
        raise HTTPException(status_code=404, detail="Task not found")
    r.done = 1 if body.done else 0
    db.commit()
    return {"id": r.id, "done": bool(r.done)}


@router.delete("/tasks/{task_id}")
def delete_task(task_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    r = db.query(models.MeetingTask).filter(models.MeetingTask.id == task_id, models.MeetingTask.user_id == current_user.id).first()
    if not r:
        raise HTTPException(status_code=404, detail="Task not found")
    m = db.get(models.MeetingRecording, r.meeting_id)
    if m and m.summary:  # the proposal can be added again
        summary = json.loads(m.summary)
        for t in summary.get("tasks", []):
            if t.get("task_id") == r.id:
                t["status"], t["task_id"] = "proposed", None
        m.summary = json.dumps(summary)
    db.delete(r)
    db.commit()
    return {"ok": True}


@router.get("/{meeting_id}/audio")
def get_audio(meeting_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    m = _own_meeting(db, current_user.id, meeting_id)
    if not m.audio_path or not os.path.exists(m.audio_path):
        raise HTTPException(status_code=404, detail="The audio of this meeting was deleted.")
    ext = os.path.splitext(m.audio_path)[1]
    return vault.file_response(m.audio_path, m.mime or "audio/webm", f"meeting-{m.id}{ext}")


@router.delete("/{meeting_id}/audio")
def delete_audio(meeting_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Delete the recording; the transcript (the document) and the summary stay."""
    m = _own_meeting(db, current_user.id, meeting_id)
    if m.status == "transcribing":
        raise HTTPException(status_code=409, detail="The meeting is still being written down.")
    meetings.remove_audio(m.audio_path)
    m.audio_path = None
    db.commit()
    return _meeting_out(m)


@router.get("/{meeting_id}/summary")
def get_summary(meeting_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    m = _own_meeting(db, current_user.id, meeting_id)
    return {"meeting": _meeting_out(m), "summary": json.loads(m.summary) if m.summary else None}


def _transcript(db, m) -> str:
    doc = db.get(models.Document, m.document_id)
    if not doc or not doc.filepath or not os.path.exists(doc.filepath):
        raise HTTPException(status_code=409, detail="The meeting has not been written down yet.")
    return vault.read_text(doc.filepath)


def _meeting_day(m) -> date:
    try:
        return datetime.fromisoformat(m.started).date()
    except (TypeError, ValueError):
        return date.today()


@router.post("/{meeting_id}/summary")
def make_summary(meeting_id: int, db: Session = Depends(get_db), current_user: models.User = Depends(get_current_user)):
    """Summarize the meeting: decisions, open points and tasks, each with its time. Tasks are proposals; tasks the
    user already added stay added."""
    m = _own_meeting(db, current_user.id, meeting_id)
    text = _transcript(db, m)
    try:
        summary = meetings.summarize(text, _meeting_day(m))
    except meetings.MeetingError as e:
        raise HTTPException(status_code=409, detail=str(e))
    old = json.loads(m.summary) if m.summary else {}
    added = {(t.get("time"), meetings._norm(t.get("text"))): t for t in old.get("tasks", []) if t.get("status") != "proposed"}
    for t in summary["tasks"]:
        before = added.get((t["time"], meetings._norm(t["text"])))
        if before:
            t["status"], t["task_id"] = before.get("status"), before.get("task_id")
    summary["made"] = datetime.now().isoformat(timespec="seconds")
    m.summary = json.dumps(summary)
    db.commit()
    return {"meeting": _meeting_out(m), "summary": summary}


class TaskDecisionIn(BaseModel):
    action: str = Field(..., pattern="^(add|skip)$")
    # what the user changed before adding; an owner or a date typed here is the user's own, not the model's
    text: Optional[str] = Field(None, max_length=400)
    owner: Optional[str] = Field(None, max_length=80)
    due_date: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")


@router.post("/{meeting_id}/tasks/{index}")
def decide_task(meeting_id: int, index: int, body: TaskDecisionIn, db: Session = Depends(get_db),
                current_user: models.User = Depends(get_current_user)):
    """The user confirms a proposed task (it is added to the list, with the time it was said) or skips it. Nothing
    is added without this."""
    m = _own_meeting(db, current_user.id, meeting_id)
    summary = json.loads(m.summary) if m.summary else None
    tasks = (summary or {}).get("tasks", [])
    task = next((t for t in tasks if t.get("index") == index), None)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.get("status") == "added":
        raise HTTPException(status_code=409, detail="The task is already in the list.")
    if body.action == "skip":
        task["status"] = "skipped"
        m.summary = json.dumps(summary)
        db.commit()
        return {"task": task}
    sent = body.model_dump(exclude_unset=True)
    if body.due_date:
        try:
            date.fromisoformat(body.due_date)
        except ValueError:
            raise HTTPException(status_code=422, detail="Not a date")
    text = " ".join((sent.get("text") or task["text"]).split())
    if not text:
        raise HTTPException(status_code=422, detail="The task has no text")
    owner = (" ".join((sent["owner"] or "").split()) or None) if "owner" in sent else task.get("owner")
    due_date = (sent["due_date"] or None) if "due_date" in sent else task.get("due_date")
    row = models.MeetingTask(user_id=current_user.id, scope="ws", document_id=m.document_id, meeting_id=m.id,
                             text=text, owner=owner, due_text=task.get("due_text"), due_date=due_date,
                             seconds=int(task.get("seconds") or 0))
    db.add(row)
    db.flush()
    task.update({"status": "added", "task_id": row.id})
    m.summary = json.dumps(summary)
    db.commit()
    return {"task": task, "id": row.id}
