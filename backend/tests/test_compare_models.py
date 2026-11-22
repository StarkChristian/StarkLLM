"""Two models side by side (R4 of docs/roadmap-2026-12.md): the second model answers the same question without seeing
the first answer, nothing of it is saved, and "Keep this answer" replaces the saved answer."""
import uuid

import pytest


@pytest.fixture
def env(monkeypatch, tmp_path):
    from fastapi.testclient import TestClient
    from app.api import chat as chat_module
    from app.api.auth import create_access_token, get_password_hash
    from app.db import models
    from app.db.session import SessionLocal
    from app.main import app
    from app.services.memory_service import memory_service
    from app.services.rag_service import rag_service
    name = f"cmp_{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        u = models.User(username=name, hashed_password=get_password_hash("x" * 12))
        db.add(u)
        db.commit()
        ws = models.Workspace(name="Compare", user_id=u.id)
        db.add(ws)
        db.commit()
        ws_id = ws.id
    finally:
        db.close()
    monkeypatch.setattr(memory_service, "retrieve_memory_context", lambda *a, **k: "")
    monkeypatch.setattr(rag_service, "query_merged", lambda *a, **k: ([], []))
    seen = []

    def model(model_name, messages, stream=False, options=None, *a, **k):
        seen.append({"model": model_name, "messages": messages})
        return {"message": {"content": f"Answer of {model_name}."}}
    monkeypatch.setattr(chat_module.llm_service, "generate_chat", model)
    client = TestClient(app)
    headers = {"Authorization": f"Bearer {create_access_token({'sub': name})}"}

    def history(chat_id):
        msgs = client.get(f"/api/v1/chat/session/{chat_id}", headers=headers).json()
        msgs = msgs.get("messages", msgs) if isinstance(msgs, dict) else msgs
        return [(m["role"], m["content"]) for m in msgs]
    return client, headers, ws_id, seen, history


def ask(client, headers, ws_id, **kw):
    body = {"workspace_id": ws_id, "message": "What is the capital of Italy?", "stream": False, "model": "model-a"}
    body.update(kw)
    return client.post("/api/v1/chat/", headers=headers, json=body)


def test_the_second_model_answers_without_the_first_answer_and_nothing_is_saved(env):
    client, headers, ws_id, seen, history = env
    first = ask(client, headers, ws_id)
    assert first.status_code == 200, first.text
    chat_id = int(first.headers["X-Chat-ID"])
    second = ask(client, headers, ws_id, chat_id=chat_id, model="model-b", compare=True)
    assert second.status_code == 200, second.text
    assert second.json()["response"] == "Answer of model-b."
    prompt_b = seen[-1]["messages"]
    assert seen[-1]["model"] == "model-b"
    asked = [m for m in prompt_b if m["role"] != "system"]
    assert asked[-1] == {"role": "user", "content": "What is the capital of Italy?"}
    assert prompt_b[-1] == {"role": "system", "content": "Write your answer in English."}  # the answer language, right after the question
    assert not any(m["content"] == "Answer of model-a." for m in prompt_b)
    # the chat has the question once and the first answer only
    assert history(chat_id) == [("user", "What is the capital of Italy?"), ("assistant", "Answer of model-a.")]


def test_keep_this_answer_replaces_the_saved_answer(env):
    client, headers, ws_id, seen, history = env
    chat_id = int(ask(client, headers, ws_id).headers["X-Chat-ID"])
    r = client.post(f"/api/v1/chat/session/{chat_id}/keep-answer", headers=headers, json={"content": "Rome (model-b).", "question": "What is the capital of Italy?"})
    assert r.status_code == 200, r.text
    assert history(chat_id) == [("user", "What is the capital of Italy?"), ("assistant", "Rome (model-b).")]


def test_a_comparison_needs_the_chat_and_the_same_last_question(env):
    client, headers, ws_id, seen, history = env
    assert ask(client, headers, ws_id, compare=True).status_code == 400
    chat_id = int(ask(client, headers, ws_id).headers["X-Chat-ID"])
    r = ask(client, headers, ws_id, chat_id=chat_id, compare=True, message="Another question?")
    assert r.status_code == 409


def test_keep_answer_only_in_ones_own_chat(env):
    client, headers, ws_id, seen, history = env
    chat_id = int(ask(client, headers, ws_id).headers["X-Chat-ID"])
    from app.api.auth import create_access_token, get_password_hash
    from app.db import models
    from app.db.session import SessionLocal
    other = f"cmp_other_{uuid.uuid4().hex[:6]}"
    db = SessionLocal()
    try:
        db.add(models.User(username=other, hashed_password=get_password_hash("y" * 12)))
        db.commit()
    finally:
        db.close()
    r = client.post(f"/api/v1/chat/session/{chat_id}/keep-answer",
                    headers={"Authorization": f"Bearer {create_access_token({'sub': other})}"}, json={"content": "hijacked", "question": "What is the capital of Italy?"})
    assert r.status_code == 404
    assert history(chat_id)[-1] == ("assistant", "Answer of model-a.")


def test_keep_answer_refuses_an_answer_of_an_earlier_question(env):
    client, headers, ws_id, seen, history = env
    chat_id = int(ask(client, headers, ws_id).headers["X-Chat-ID"])
    ask(client, headers, ws_id, chat_id=chat_id, message="And of France?")
    r = client.post(f"/api/v1/chat/session/{chat_id}/keep-answer", headers=headers,
                    json={"content": "Rome (model-b).", "question": "What is the capital of Italy?"})
    assert r.status_code == 409
    assert history(chat_id)[-1] == ("assistant", "Answer of model-a.")
