"""Found on Windows (8 Nov 2026): the desktop app never installed the vision model, so every image failed to index."""
import pytest

from app.services import llm_service as L
from app.services import vision_service as V


@pytest.fixture
def image(tmp_path):
    p = tmp_path / "sign.png"
    p.write_bytes(b"\x89PNG")
    return str(p)


@pytest.fixture
def svc():
    return V.VisionService()


def test_a_missing_vision_model_is_downloaded_once_and_the_image_described(monkeypatch, svc, image):
    installed, pulls = [], []

    def chat(model, messages, stream=False):
        if model not in installed:
            raise L.ModelNotFoundError(f"Model '{model}' not found in Ollama.")
        return {"message": {"content": "Visitor parking: level P2"}}

    monkeypatch.setattr(V.llm_service, "generate_chat", chat)
    monkeypatch.setattr(V.llm_service, "get_available_models", lambda: list(installed))
    monkeypatch.setattr(V.llm_service, "pull_model", lambda name: (pulls.append(name), installed.append(name)))
    assert svc.generate_image_description(image) == "Visitor parking: level P2"
    assert svc.generate_image_description(image) == "Visitor parking: level P2"
    assert pulls == [svc.vision_model]


def test_a_failed_download_gives_a_clear_message_and_is_not_repeated_for_every_image(monkeypatch, svc, image):
    pulls = []

    def chat(model, messages, stream=False):
        raise L.ModelNotFoundError("not found")

    def pull(name):
        pulls.append(name)
        raise RuntimeError("no internet")

    monkeypatch.setattr(V.llm_service, "generate_chat", chat)
    monkeypatch.setattr(V.llm_service, "get_available_models", lambda: [])
    monkeypatch.setattr(V.llm_service, "pull_model", pull)
    for _ in range(3):
        with pytest.raises(L.ModelNotFoundError, match="ollama pull"):
            svc.generate_image_description(image)
    assert len(pulls) == 1

    monkeypatch.setattr(V, "PULL_RETRY_SECONDS", 0)
    with pytest.raises(L.ModelNotFoundError):
        svc.generate_image_description(image)
    assert len(pulls) == 2


def test_pull_model_reports_an_ollama_error(monkeypatch):
    monkeypatch.setattr(L.llm_service, "pull_model_stream", lambda name: iter(['{"status":"pulling manifest"}\n', '{"error":"pull model manifest: file does not exist"}\n']))
    with pytest.raises(RuntimeError, match="file does not exist"):
        L.llm_service.pull_model("nope")


def test_pull_model_succeeds_on_the_final_success_line(monkeypatch):
    monkeypatch.setattr(L.llm_service, "pull_model_stream", lambda name: iter(['{"status":"downloading"}\n', '{"status":"success"}\n']))
    L.llm_service.pull_model("llava")
