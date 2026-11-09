"""Roadmap phase 3: ask StarkLLM from the phone through the user's own Telegram bot.

Telegram is replaced by a stand-in (httpx.MockTransport) that records what the bridge sends.
"""
import json

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.services import telegram_bridge as tb

TOKEN = "123:ABC"


class FakeTelegram:
    def __init__(self):
        self.sent = []          # (chat_id, text)
        self.updates = []
        self.valid_token = TOKEN

    def handler(self, request: httpx.Request):
        token, method = request.url.path.split("/bot", 1)[1].split("/", 1)
        if token != self.valid_token:
            return httpx.Response(401, json={"ok": False, "description": "Unauthorized"})
        body = json.loads(request.content or b"{}")
        if method == "getMe":
            return httpx.Response(200, json={"ok": True, "result": {"id": 1, "username": "my_starkllm_bot"}})
        if method == "sendMessage":
            self.sent.append((body["chat_id"], body["text"]))
        if method == "getUpdates":
            ups, self.updates = self.updates, []
            return httpx.Response(200, json={"ok": True, "result": ups})
        return httpx.Response(200, json={"ok": True, "result": True})

    def client(self):
        return httpx.Client(transport=httpx.MockTransport(self.handler))


def msg(chat_id, text, update_id=1, first_name="Chris"):
    return {"update_id": update_id, "message": {"chat": {"id": chat_id, "first_name": first_name}, "text": text}}


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(tb, "STATE_FILE", str(tmp_path / "telegram.json"))
    tg = FakeTelegram()
    calls = []

    def answer(owner, chat_id, question):
        calls.append((owner, chat_id, question))
        return f"answer to {question}", 77, ["report.pdf, page 3"]

    bridge = tb.TelegramBridge(answer, client=tg.client())
    tb.save_state({"token": TOKEN, "enabled": True, "owner_user_id": 5, "chats": []})
    return bridge, tg, calls


def pair(bridge, chat_id=42):
    state = tb.load_state()
    code = tb.new_pairing_code(state)
    tb.save_state(state)
    bridge.handle(msg(chat_id, f"/start {code}"))
    return code


def test_long_answers_are_split_for_telegram():
    parts = tb.split_message(("word " * 300 + "\n\n") * 5, limit=1000)
    assert all(len(p) <= 1000 for p in parts) and len(parts) > 5
    assert tb.split_message("short") == ["short"]


def test_pairing_code_in_start_or_alone():
    assert tb.code_from("/start 123456") == "123456"
    assert tb.code_from("123456") == "123456"
    assert tb.code_from("hello") is None
    assert tb.code_from("/start") is None


def test_an_unpaired_chat_gets_no_answer_and_is_told_once(setup):
    bridge, tg, calls = setup
    bridge.handle(msg(99, "What is in my contracts?"))
    bridge.handle(msg(99, "Hello?"))
    assert calls == []
    assert len(tg.sent) == 1 and "private" in tg.sent[0][1]


def test_the_code_pairs_the_chat_once(setup):
    bridge, tg, calls = setup
    code = pair(bridge)
    state = tb.load_state()
    assert [c["chat_id"] for c in state["chats"]] == [42] and state["chats"][0]["name"] == "Chris"
    assert "pairing" not in state, "a code works only once"
    bridge.handle(msg(43, f"/start {code}"))
    assert [c["chat_id"] for c in tb.load_state()["chats"]] == [42]


def test_an_expired_or_wrong_code_does_not_pair(setup):
    bridge, tg, calls = setup
    state = tb.load_state()
    code = tb.new_pairing_code(state, now=0)  # expired long ago
    tb.save_state(state)
    bridge.handle(msg(42, code))
    bridge.handle(msg(42, "000000" if code != "000000" else "111111"))
    assert tb.load_state().get("chats") == []
    assert sum("not valid" in t for _, t in tg.sent) == 2


def test_guessing_codes_is_stopped(setup):
    bridge, tg, calls = setup
    state = tb.load_state()
    real = tb.new_pairing_code(state)
    tb.save_state(state)
    wrong = "000001" if real != "000001" else "000002"
    for _ in range(tb.MAX_WRONG_CODES):
        bridge.handle(msg(66, wrong))
    sent_before = len(tg.sent)
    bridge.handle(msg(66, real))  # even the right code after too many guesses
    assert tb.load_state().get("chats") == []
    assert len(tg.sent) == sent_before, "no more answers to a chat that guesses"


def test_questions_are_answered_with_sources_and_continue_the_chat(setup):
    bridge, tg, calls = setup
    pair(bridge)
    tg.sent.clear()
    bridge.handle(msg(42, "Who is the night shift supervisor?"))
    bridge.handle(msg(42, "And until when is FL-07 out?"))
    assert calls[0] == (5, None, "Who is the night shift supervisor?")
    assert calls[1] == (5, 77, "And until when is FL-07 out?"), "the second question continues the StarkLLM chat"
    assert tg.sent[0] == (42, "answer to Who is the night shift supervisor?\n\nSources: report.pdf, page 3")


def test_new_starts_a_new_conversation(setup):
    bridge, tg, calls = setup
    pair(bridge)
    bridge.handle(msg(42, "first"))
    bridge.handle(msg(42, "/new"))
    bridge.handle(msg(42, "second"))
    assert calls[-1] == (5, None, "second")


def test_an_answer_error_is_reported_to_the_phone(setup):
    bridge, tg, calls = setup
    pair(bridge)
    bridge.answer = lambda *a: (_ for _ in ()).throw(RuntimeError("Ollama is not running"))
    bridge.handle(msg(42, "hello"))
    assert "Ollama is not running" in tg.sent[-1][1]


def test_polling_moves_the_offset_and_answers(setup):
    bridge, tg, calls = setup
    pair(bridge)
    tg.updates = [msg(42, "q1", update_id=10), msg(42, "q2", update_id=11)]
    assert bridge.poll_once(timeout=0) == 2
    assert tb.load_state()["offset"] == 12
    assert [c[2] for c in calls] == ["q1", "q2"]


def test_settings_api_checks_the_token_and_pairs(tmp_path, monkeypatch):
    from app.api import telegram as api
    from app.api.auth import get_current_user

    monkeypatch.setattr(tb, "STATE_FILE", str(tmp_path / "telegram.json"))
    tg = FakeTelegram()
    monkeypatch.setattr(api.bridge, "client", tg.client())
    monkeypatch.setattr(api.bridge, "start", lambda: None)
    app = FastAPI()
    app.include_router(api.router, prefix="/telegram")
    user = type("U", (), {"id": 5})()
    app.dependency_overrides[get_current_user] = lambda: user
    c = TestClient(app)

    assert c.get("/telegram").json()["configured"] is False
    assert c.put("/telegram", json={"enabled": True}).status_code == 400, "no token yet"
    r = c.put("/telegram", json={"token": "wrong"})
    assert r.status_code == 400 and "did not accept" in r.json()["detail"]
    r = c.put("/telegram", json={"token": TOKEN, "enabled": True})
    assert r.status_code == 200 and r.json()["bot_username"] == "my_starkllm_bot" and r.json()["enabled"] is True
    code = c.post("/telegram/pairing-code").json()["pairing_code"]
    assert code and len(code) == 6
    assert "token" not in c.get("/telegram").json(), "the token is never sent back"

    # another StarkLLM user of the same PC cannot take over the bridge
    app.dependency_overrides[get_current_user] = lambda: type("U", (), {"id": 9})()
    assert c.get("/telegram").status_code == 403
    assert c.put("/telegram", json={"enabled": False}).status_code == 403
    app.dependency_overrides[get_current_user] = lambda: user

    tb.save_state({**tb.load_state(), "chats": [{"chat_id": 42, "name": "Chris"}]})
    assert c.delete("/telegram/chats/42").json()["chats"] == []
    r = c.put("/telegram", json={"token": ""})
    assert r.json()["configured"] is False and tb.load_state() == {}
