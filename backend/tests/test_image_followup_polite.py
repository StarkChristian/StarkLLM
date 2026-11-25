"""2.5.0 acceptance test: a German answer about an image said "du"; a second question about an image was answered from
a web page saved in the workspace. Answers about images use the polite form, and a follow-up question about the same
image goes to the vision model with the image and the question and answer before it."""
import io
import uuid

from PIL import Image

from app.services import image_question as iq


def _png():
    buf = io.BytesIO()
    Image.new("RGB", (20, 20), (10, 120, 200)).save(buf, format="PNG")
    return buf.getvalue()


def test_the_polite_form_is_in_the_image_prompt_in_every_language():
    for lang, form in [("German", "Sie"), ("French", "vous"), ("Spanish", "usted"), ("Italian", "Lei"), ("Turkish", "siz")]:
        msgs = iq.messages_for("?", "AAAA", lang)
        assert f'"{form}"' in msgs[0]["content"] and f'"{form}"' in msgs[-1]["content"]
        assert "familiar form" in msgs[-1]["content"]
    # a language without a fixed form still gets the rule
    assert "familiar form" in iq.messages_for("?", "AAAA", "the language of the question")[0]["content"]


def test_a_follow_up_sees_the_question_and_answer_before_and_the_image_again():
    msgs = iq.messages_for("Und das Datum?", "BBBB", "German", ("Was ist zu zahlen?", "84 EUR."))
    assert [m["role"] for m in msgs] == ["system", "user", "assistant", "user"]
    assert msgs[1]["content"] == "Was ist zu zahlen?" and "images" not in msgs[1]
    assert msgs[2]["content"] == "84 EUR."
    assert msgs[3]["images"] == ["BBBB"] and msgs[3]["content"].startswith("Und das Datum?")
    # half a pair is left out
    assert len(iq.messages_for("x", "C", "German", ("frage", " "))) == 2


def test_the_route_passes_the_previous_turn_and_the_polite_rule(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    from app.api import chat as chat_api
    from app.api.auth import create_access_token, get_password_hash
    from app.db import models
    from app.db.session import SessionLocal
    name = f"imgf_{uuid.uuid4().hex[:8]}"
    db = SessionLocal()
    try:
        user = models.User(username=name, hashed_password=get_password_hash("x" * 12))
        db.add(user)
        db.commit()
        ws = models.Workspace(name="Img", user_id=user.id)
        db.add(ws)
        db.commit()
        ws_id = ws.id
    finally:
        db.close()
    headers = {"Authorization": f"Bearer {create_access_token({'sub': name})}"}
    sent = {}
    monkeypatch.setattr(chat_api.llm_service, "get_available_models", lambda: ["llava:latest"])
    monkeypatch.setattr(chat_api, "_ollama_show", lambda m: {"capabilities": ["vision"]})

    def fake_chat(model, messages, stream=False, options=None, **kw):
        sent["messages"] = messages
        yield "Das Datum ist der 3. Mai."
    monkeypatch.setattr(chat_api.llm_service, "generate_chat", fake_chat)
    iq._capabilities.clear()
    r = TestClient(app).post("/api/v1/chat/image", headers=headers,
                             data={"workspace_id": str(ws_id), "message": "Und das Datum?", "language": "de",
                                   "previous_question": "Was ist zu zahlen?", "previous_answer": "84 EUR."},
                             files={"image": ("rechnung.png", _png(), "image/png")})
    assert r.status_code == 200, r.text
    roles = [m["role"] for m in sent["messages"]]
    assert roles == ["system", "user", "assistant", "user"]
    assert sent["messages"][-1]["images"]
    assert '"Sie"' in sent["messages"][0]["content"]
