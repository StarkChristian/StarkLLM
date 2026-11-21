"""A web task done in the desktop app's browser window is kept in the chat history (docs/web-tasks.md)."""
import uuid

from fastapi.testclient import TestClient

from app.api.auth import create_access_token, get_password_hash
from app.db import models
from app.db.session import SessionLocal
from app.main import app

client = TestClient(app)


def _user(name_prefix="webtask"):
    name = f"{name_prefix}_{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        user = models.User(username=name, hashed_password=get_password_hash("x" * 12))
        db.add(user)
        db.commit()
        ws = models.Workspace(name="Web", user_id=user.id)
        db.add(ws)
        db.commit()
        return ws.id, {"Authorization": f"Bearer {create_access_token({'sub': name})}"}
    finally:
        db.close()


def test_a_web_task_starts_a_chat_with_the_task_and_the_answer_and_its_page():
    ws_id, headers = _user()
    r = client.post("/api/v1/chat/web-task", headers=headers, json={
        "workspace_id": ws_id, "task": "Cheapest flight Berlin to Rome on 12 December?",
        "answer": "easyJet, 71 EUR.", "url": "https://flights.example/results?from=Berlin", "title": "Flights [cheap] (all)"})
    assert r.status_code == 200, r.text
    chat_id = r.json()["chat_id"]
    msgs = client.get(f"/api/v1/chat/session/{chat_id}", headers=headers).json()
    contents = [m["content"] for m in (msgs.get("messages", msgs) if isinstance(msgs, dict) else msgs)]
    assert contents[0] == "Cheapest flight Berlin to Rome on 12 December?"
    assert contents[1] == "easyJet, 71 EUR.\n\n[Flights cheap all](https://flights.example/results?from=Berlin)"


def test_only_web_addresses_become_links():
    ws_id, headers = _user()
    r = client.post("/api/v1/chat/web-task", headers=headers, json={
        "workspace_id": ws_id, "task": "x", "answer": "y", "url": "javascript:alert(1)"})
    chat_id = r.json()["chat_id"]
    msgs = client.get(f"/api/v1/chat/session/{chat_id}", headers=headers).json()
    contents = [m["content"] for m in (msgs.get("messages", msgs) if isinstance(msgs, dict) else msgs)]
    assert contents[1] == "y"


def test_another_users_workspace_or_chat_is_refused():
    ws_a, headers_a = _user()
    _ws_b, headers_b = _user()
    assert client.post("/api/v1/chat/web-task", headers=headers_b, json={"workspace_id": ws_a, "task": "x", "answer": "y"}).status_code == 404
    chat_a = client.post("/api/v1/chat/web-task", headers=headers_a, json={"workspace_id": ws_a, "task": "x", "answer": "y"}).json()["chat_id"]
    ws_b2, headers_b2 = _user()
    r = client.post("/api/v1/chat/web-task", headers=headers_b2, json={"workspace_id": ws_b2, "chat_id": chat_a, "task": "x", "answer": "y"})
    assert r.status_code == 404
