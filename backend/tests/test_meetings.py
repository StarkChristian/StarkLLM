"""Meeting assistant (2.8, option 13): recording in parts and recovery after a crash, the transcript document, the
summary checked against the transcript (no invented owners or dates), the confirmation of each task, and the audio
encrypted at rest and deletable while the text stays."""
import json
import os
import time
import uuid
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core import crypto
from app.core.config import settings
from app.core.protection import protection
from app.db import models
from app.db.session import SessionLocal
from app.main import app
from app.services import meetings, vault

client = TestClient(app)
API = "/api/v1/meetings"
FIXTURES = Path(__file__).parent / "fixtures" / "meetings"
EN = (FIXTURES / "meeting-en.txt").read_text(encoding="utf8")
DE = (FIXTURES / "meeting-de.txt").read_text(encoding="utf8")
DAY = date(2026, 11, 28)


@pytest.fixture()
def uploads(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setattr(settings, "TEMP_DIR", str(tmp_path / "tmp"))
    os.makedirs(settings.UPLOAD_DIR)
    yield tmp_path


@pytest.fixture()
def protected(tmp_path):
    protection.set_directory(str(tmp_path / "protection"))
    protection.clear_key()
    protection.set_key(crypto.new_key())
    protection.mark_enabled(True)
    yield
    protection.set_directory(None)
    protection.clear_key()
    protection._state_cache = None


def _user():
    from app.api.auth import create_access_token, get_password_hash
    name = f"meet_{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        user = models.User(username=name, hashed_password=get_password_hash("x" * 12))
        db.add(user)
        db.commit()
        ws = models.Workspace(name="Team", user_id=user.id)
        db.add(ws)
        db.commit()
        ids = (user.id, ws.id)
    finally:
        db.close()
    return ids, {"Authorization": f"Bearer {create_access_token({'sub': name})}"}


def _meeting(user_id, ws_id, text, tmp_path, started="2026-11-28T10:00:00", audio=b"OggS fake audio"):
    """A meeting that has been written down: the transcript document and the audio beside it."""
    text_path = str(tmp_path / f"{uuid.uuid4().hex[:6]}_Meeting.txt")
    vault.write_text(text_path, text)
    audio_path = str(tmp_path / f"{uuid.uuid4().hex[:6]}.webm")
    vault.write_bytes(audio_path, audio)
    db = SessionLocal()
    try:
        doc = models.Document(workspace_id=ws_id, filename="Meeting.txt", filepath=text_path, file_type="txt", status="indexed")
        db.add(doc)
        db.flush()
        m = models.MeetingRecording(user_id=user_id, scope="ws", document_id=doc.id, workspace_id=ws_id, audio_path=audio_path,
                                    mime="audio/webm", started=started, status="ready")
        db.add(m)
        db.commit()
        return m.id, doc.id, audio_path, text_path
    finally:
        db.close()


# ------------------------------------------------------------------------------------------------ the model (fake)

EN_ANSWER = {
    "decisions": [{"text": "Launch the new website on 15 January", "time": "00:00:09"},
                  {"text": "Keep the old logo for now", "time": "[00:06:30]"}],
    "open_points": [{"text": "Whether a new hosting contract is needed", "time": "00:05:10"}],
    "tasks": [
        {"text": "Send the final texts to the agency", "owner": "Anna", "due": "by 9 December", "time": "00:01:20"},
        # nobody was named and no date was said: the model invents both
        {"text": "Check the translations", "owner": "Peter", "due": "1 December 2026", "time": "00:02:05"},
        {"text": "Update the budget sheet", "owner": "Tom", "due": "by Friday", "time": "00:03:40"},
        {"text": "Book the room for the workshop", "owner": "Maria Schulz", "due": "next Monday", "time": "12:30"},
        # never said at all
        {"text": "Prepare the press release", "owner": "Lisa", "due": "tomorrow", "time": "00:20:00"},
    ],
}

DE_ANSWER = {
    "decisions": [{"text": "Umzug am 1. Februar", "time": "00:00:15"}],
    "open_points": [{"text": "Wer übernimmt die Schlüssel?", "time": "00:02:30"}],
    "tasks": [
        {"text": "Umzugsfirma beauftragen", "owner": "Herr Becker", "due": "bis zum 12.12.2026", "time": "00:01:02"},
        {"text": "Mietvertrag prüfen", "owner": "Frau Yilmaz", "due": "bis 15.12.2026", "time": "00:03:10"},
        {"text": "Möbelliste schicken", "owner": "ich", "due": "bis Freitag", "time": "00:04:00"},
    ],
}


def _fake(answer):
    calls = []

    def ask(window_text):
        calls.append(window_text)
        return "Here are the minutes:\n```json\n" + json.dumps(answer) + "\n```"
    ask.calls = calls
    return ask


# ------------------------------------------------------------------------------------------------ task extraction

def test_tasks_keep_only_owners_and_dates_that_were_said():
    out = meetings.summarize(EN, DAY, ask=_fake(EN_ANSWER))
    tasks = {t["text"]: t for t in out["tasks"]}
    assert "Prepare the press release" not in tasks, "a task that is not in the transcript is left out"
    anna = tasks["Send the final texts to the agency"]
    assert (anna["owner"], anna["due_text"], anna["due_date"], anna["time"]) == ("Anna", "by 9 December", "2026-12-09", "00:01:20")
    check = tasks["Check the translations"]
    assert check["owner"] is None and check["due_text"] is None and check["due_date"] is None, "no invented owner or date"
    tom = tasks["Update the budget sheet"]
    assert tom["owner"] == "Tom" and tom["due_text"] == "by Friday" and tom["due_date"] is None, "a weekday gets no made-up day"
    maria = tasks["Book the room for the workshop"]
    assert maria["owner"] == "Maria" and maria["due_text"] is None and maria["time"] == "00:12:30"
    assert all(t["status"] == "proposed" for t in out["tasks"])
    assert [t["index"] for t in out["tasks"]] == list(range(len(out["tasks"])))
    assert [d["time"] for d in out["decisions"]] == ["00:00:09", "00:06:30"]
    assert out["open_points"][0]["quote"].startswith("It is still open")


def test_german_meeting_tasks():
    out = meetings.summarize(DE, DAY, ask=_fake(DE_ANSWER))
    tasks = {t["text"]: t for t in out["tasks"]}
    becker = tasks["Umzugsfirma beauftragen"]
    assert (becker["owner"], becker["due_date"]) == ("Herr Becker", "2026-12-12")
    yilmaz = tasks["Mietvertrag prüfen"]
    assert yilmaz["owner"] == "Frau Yilmaz" and yilmaz["due_text"] is None and yilmaz["due_date"] is None
    moebel = tasks["Möbelliste schicken"]
    assert moebel["owner"] is None and moebel["due_text"] == "bis Freitag" and moebel["due_date"] is None


def test_the_transcript_reaches_the_model_as_data_in_windows():
    long = "\n".join(f"[00:{i // 60:02d}:{i % 60:02d}] Sentence number {i} about the budget." for i in range(600)) + "\n"
    ask = _fake({"decisions": [], "open_points": [], "tasks": []})
    meetings.summarize(long, DAY, ask=ask)
    assert len(ask.calls) > 1 and all(len(c) <= meetings.WINDOW_CHARS + 200 for c in ask.calls)
    assert ask.calls[0].startswith("[00:00:00] Sentence number 0")


def test_a_broken_answer_gives_an_empty_summary_not_an_error():
    out = meetings.summarize(EN, DAY, ask=lambda text: "Sorry, I cannot help with that.")
    assert out == {"decisions": [], "open_points": [], "tasks": []}


def test_dates_said_in_a_meeting():
    said = lambda s: meetings._said_date(s, DAY)
    assert said("by 9 December") == "2026-12-09"
    assert said("until December 3rd") == "2026-12-03"
    assert said("bis zum 15.1.") == "2027-01-15"
    assert said("avant le 15 janvier 2027") == "2027-01-15"
    assert said("by Friday") is None and said("next week") is None
    assert said("by 03/04/2027") is None, "day or month first is not known"


def test_times_and_transcripts():
    assert meetings.stamp_seconds("00:12:30") == 750 == meetings.stamp_seconds("[00:12:30]") == meetings.stamp_seconds("12:30")
    assert meetings.stamp_seconds("soon") is None
    assert meetings.is_transcript(EN) and not meetings.is_transcript("A note\nwith [00:00:01] a time")
    parts = meetings.transcript_passages(EN)
    assert parts[0]["text"].startswith("[00:00:02] Good morning")


def test_a_transcript_document_is_searched_by_its_times(tmp_path):
    from app.services.rag_service import rag_service
    path = tmp_path / "ab12_Meeting.txt"
    path.write_text(EN, encoding="utf8")
    chunks, metas, ids = rag_service._process_file_to_chunks(str(path))
    assert chunks and chunks[0].startswith("[00:00:02]")
    assert metas[0]["type"] == "recording" and metas[0]["locator"] == "Time 00:00:02"


# ------------------------------------------------------------------------------------------------ recording in parts

def test_parts_are_saved_whole_and_a_crash_leaves_them_recoverable(uploads):
    sid = meetings.start_session(7, 3, "audio/webm;codecs=opus")
    for i, data in enumerate([b"HEADER+A", b"B" * 1000, b"C" * 10]):
        meetings.save_part(sid, i, data)
    meetings.save_part(sid, 1, b"B" * 1000)  # a retry of the same part replaces it
    # the crash: a part was being written when the PC went off
    open(os.path.join(meetings.meetings_dir(), sid, "part-000003.tmp"), "wb").write(b"half")
    assert len(meetings.parts(sid)) == 3
    old = time.time() - 600
    for p in meetings.parts(sid):
        os.utime(p, (old, old))
    found = meetings.unfinished(7)
    assert [s["id"] for s in found] == [sid] and found[0]["parts"] == 3 and not found[0]["active"]
    assert meetings.unfinished(8) == [], "another user does not see it"
    dest = os.path.join(meetings.meetings_dir(), "x.webm")
    assert meetings.assemble(sid, dest) == 8 + 1000 + 10
    assert open(dest, "rb").read() == b"HEADER+A" + b"B" * 1000 + b"C" * 10
    assert meetings.audio_extension(sid) == ".webm"


def test_empty_stale_sessions_are_cleaned_up_and_bad_parts_refused(uploads):
    sid = meetings.start_session(7, 3)
    meta = os.path.join(meetings.meetings_dir(), sid, "meta.json")
    os.utime(meta, (time.time() - 600, time.time() - 600))
    assert meetings.unfinished(7) == [] and not os.path.exists(os.path.join(meetings.meetings_dir(), sid))
    sid = meetings.start_session(7, 3)
    with pytest.raises(meetings.MeetingError):
        meetings.save_part(sid, 0, b"")
    with pytest.raises(meetings.MeetingError):
        meetings.save_part(sid, -1, b"x")
    with pytest.raises(meetings.MeetingError):
        meetings.save_part("../../etc", 0, b"x")


def test_recording_needs_consent_and_stop_makes_a_document(uploads, monkeypatch):
    (user_id, ws_id), headers = _user()
    started = []
    monkeypatch.setattr(meetings, "transcribe_meeting", lambda meeting_id, transcribe=None: started.append(meeting_id))
    r = client.post(f"{API}/sessions", json={"workspace_id": ws_id}, headers=headers)
    assert r.status_code == 400 and "agreed" in r.json()["detail"]
    r = client.post(f"{API}/sessions", json={"workspace_id": ws_id + 999, "consent": True}, headers=headers)
    assert r.status_code == 404
    sid = client.post(f"{API}/sessions", json={"workspace_id": ws_id, "consent": True, "mime": "audio/webm"}, headers=headers).json()["id"]
    for i in range(3):
        assert client.put(f"{API}/sessions/{sid}/parts/{i}", content=bytes([65 + i]) * 50, headers=headers).status_code == 200
    (_, other) = _user()
    assert client.put(f"{API}/sessions/{sid}/parts/3", content=b"x", headers=other).status_code == 404
    assert client.get(f"{API}/sessions/unfinished", headers=headers).json()["sessions"][0]["parts"] == 3
    r = client.post(f"{API}/sessions/{sid}/stop", json={"title": "Weekly: team / plans"}, headers=headers)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["has_audio"] and body["status"] == "transcribing" and started == [body["id"]]
    assert client.get(f"{API}/sessions/unfinished", headers=headers).json()["sessions"] == []
    db = SessionLocal()
    try:
        doc = db.get(models.Document, body["document_id"])
        m = db.get(models.MeetingRecording, body["id"])
        assert doc.workspace_id == ws_id and doc.filename == "Weekly team plans.txt" and doc.file_type == "txt"
        assert vault.read_bytes(m.audio_path) == b"A" * 50 + b"B" * 50 + b"C" * 50
    finally:
        db.close()


def test_after_stop_the_meeting_is_written_down_with_times(uploads, monkeypatch):
    from app.api import documents as docs_api
    (user_id, ws_id), headers = _user()
    m_id, doc_id, audio, text_path = _meeting(user_id, ws_id, "", uploads)
    os.remove(text_path)
    indexed = []
    monkeypatch.setattr(docs_api, "_index_document_background", lambda *a: indexed.append(a))
    heard = {"language": "en", "duration": 95.0, "passages": [{"start": 0, "end": 60, "text": "[00:00:02] Good morning.\n[00:00:09] We decided."}]}
    meetings.transcribe_meeting(m_id, transcribe=lambda path, language=None: heard)
    assert vault.read_text(text_path) == "[00:00:02] Good morning.\n[00:00:09] We decided.\n"
    assert indexed and indexed[0][0] == doc_id and indexed[0][3] == text_path
    db = SessionLocal()
    try:
        m = db.get(models.MeetingRecording, m_id)
        assert (m.status, m.duration, m.language) == ("ready", 95.0, "en")
    finally:
        db.close()
    # nothing heard: the document says so instead of staying empty
    meetings.transcribe_meeting(m_id, transcribe=lambda path, language=None: {"passages": [], "duration": 3})
    db = SessionLocal()
    try:
        assert db.get(models.Document, doc_id).status == "failed"
        assert db.get(models.MeetingRecording, m_id).status == "failed"
    finally:
        db.close()


# ------------------------------------------------------------------------------------------------ confirmation flow

def test_tasks_are_only_added_after_the_user_confirms_each(uploads, monkeypatch):
    (user_id, ws_id), headers = _user()
    m_id, doc_id, _, _ = _meeting(user_id, ws_id, EN, uploads)
    monkeypatch.setattr(meetings, "_ask_model", _fake(EN_ANSWER))
    r = client.post(f"{API}/{m_id}/summary", headers=headers)
    assert r.status_code == 200, r.text
    tasks = r.json()["summary"]["tasks"]
    assert len(tasks) == 4
    assert client.get(f"{API}/tasks", headers=headers).json()["tasks"] == [], "nothing is added by itself"

    anna = next(t for t in tasks if t["owner"] == "Anna")
    check = next(t for t in tasks if t["text"] == "Check the translations")
    tom = next(t for t in tasks if t["owner"] == "Tom")
    r = client.post(f"{API}/{m_id}/tasks/{anna['index']}", json={"action": "add"}, headers=headers)
    assert r.status_code == 200 and r.json()["task"]["status"] == "added"
    assert client.post(f"{API}/{m_id}/tasks/{anna['index']}", json={"action": "add"}, headers=headers).status_code == 409
    # the user names who does it: that is the user's own entry
    client.post(f"{API}/{m_id}/tasks/{check['index']}", json={"action": "add", "owner": "Lena", "due_date": "2026-12-04"}, headers=headers)
    client.post(f"{API}/{m_id}/tasks/{tom['index']}", json={"action": "skip"}, headers=headers)

    listed = client.get(f"{API}/tasks", headers=headers).json()["tasks"]
    assert [(t["text"], t["owner"], t["due_date"], t["time"]) for t in listed] == [
        ("Check the translations", "Lena", "2026-12-04", "00:02:05"),
        ("Send the final texts to the agency", "Anna", "2026-12-09", "00:01:20"),
    ]
    assert listed[1]["due_text"] == "by 9 December" and listed[1]["document_id"] == doc_id and listed[1]["workspace_id"] == ws_id
    stored = client.get(f"{API}/{m_id}/summary", headers=headers).json()["summary"]
    assert {t["index"]: t["status"] for t in stored["tasks"]}[tom["index"]] == "skipped"

    # a new summary keeps what the user decided
    again = client.post(f"{API}/{m_id}/summary", headers=headers).json()["summary"]["tasks"]
    assert next(t for t in again if t["owner"] == "Anna")["status"] == "added"

    # done, and removed again: the proposal can be added once more
    task_id = listed[1]["id"]
    assert client.put(f"{API}/tasks/{task_id}", json={"done": True}, headers=headers).json()["done"] is True
    assert client.delete(f"{API}/tasks/{task_id}", headers=headers).status_code == 200
    stored = client.get(f"{API}/{m_id}/summary", headers=headers).json()["summary"]
    assert next(t for t in stored["tasks"] if t["owner"] == "Anna")["status"] == "proposed"
    (_, other) = _user()
    assert client.post(f"{API}/{m_id}/tasks/0", json={"action": "add"}, headers=other).status_code == 404
    assert client.get(f"{API}/tasks", headers=other).json()["tasks"] == []


def test_deleting_the_document_removes_the_meeting_its_tasks_and_audio(uploads, monkeypatch):
    (user_id, ws_id), headers = _user()
    m_id, doc_id, audio, _ = _meeting(user_id, ws_id, EN, uploads)
    monkeypatch.setattr(meetings, "_ask_model", _fake(EN_ANSWER))
    client.post(f"{API}/{m_id}/summary", headers=headers)
    client.post(f"{API}/{m_id}/tasks/0", json={"action": "add"}, headers=headers)
    db = SessionLocal()
    try:
        db.delete(db.get(models.Document, doc_id))
        db.commit()
        assert db.get(models.MeetingRecording, m_id) is None
        assert db.query(models.MeetingTask).filter(models.MeetingTask.meeting_id == m_id).count() == 0
    finally:
        db.close()
    assert not os.path.exists(audio)


# ------------------------------------------------------------------------------------------------ privacy

def test_with_protection_parts_audio_and_text_are_encrypted_at_rest(uploads, protected):
    secret = b"RIFF voice of the meeting: budget 4200 EUR"
    sid = meetings.start_session(7, 3, "audio/wav")
    meetings.save_part(sid, 0, secret[:20])
    meetings.save_part(sid, 1, secret[20:])
    folder = os.path.join(meetings.meetings_dir(), sid)
    for name in ("meta.json", "part-000000.part", "part-000001.part"):
        raw = open(os.path.join(folder, name), "rb").read()
        assert vault.is_protected(os.path.join(folder, name)), name
        assert b"budget" not in raw and b"user_id" not in raw
    dest = os.path.join(meetings.meetings_dir(), "m.wav")
    meetings.assemble(sid, dest)
    assert vault.is_protected(dest) and b"budget" not in open(dest, "rb").read()
    assert vault.read_bytes(dest) == secret
    with vault.plain_path(dest) as readable:  # what Whisper reads: a decrypted copy, removed afterwards
        assert open(readable, "rb").read() == secret
    assert not os.path.exists(readable)
    text = os.path.join(settings.UPLOAD_DIR, "t.txt")
    vault.write_text(text, EN)
    assert vault.is_protected(text) and b"Anna" not in open(text, "rb").read()


def test_the_audio_can_be_deleted_and_the_text_stays(uploads, monkeypatch):
    (user_id, ws_id), headers = _user()
    m_id, doc_id, audio, text_path = _meeting(user_id, ws_id, EN, uploads)
    assert client.get(f"{API}/{m_id}/audio", headers=headers).content == b"OggS fake audio"
    r = client.delete(f"{API}/{m_id}/audio", headers=headers)
    assert r.status_code == 200 and r.json()["has_audio"] is False
    assert not os.path.exists(audio) and vault.read_text(text_path) == EN
    assert client.get(f"{API}/{m_id}/audio", headers=headers).status_code == 404
    listed = client.get(API, params={"workspace_id": ws_id}, headers=headers).json()["meetings"]
    assert [(x["id"], x["document_id"], x["has_audio"]) for x in listed] == [(m_id, doc_id, False)]
    monkeypatch.setattr(meetings, "_ask_model", _fake(EN_ANSWER))
    assert client.post(f"{API}/{m_id}/summary", headers=headers).status_code == 200, "the summary works from the text"


def test_nothing_here_opens_a_connection():
    import inspect
    src = inspect.getsource(meetings) + inspect.getsource(__import__("app.api.meetings", fromlist=["x"]))
    for word in ("requests.", "netguard.", "urllib", "http://", "https://"):
        assert word not in src, word
