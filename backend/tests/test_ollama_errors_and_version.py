"""S13 - what the user sees when Ollama cannot answer, and the version /health reports.

Found by the scenario test: when the host ran out of memory the chat showed
"Error generating response: 500 Server Error: Internal Server Error for url: http://host.docker.internal:11434/api/chat"
after 5 minutes, and /health still said version 1.0.0 for the 2.0.0 release.
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest
import requests

# (markers are not used in this test folder)

BACKEND_DIR = Path(__file__).resolve().parents[1]

from app.core.config import settings  # noqa: E402
from app.services import llm_service as L  # noqa: E402


class FakeResponse:
    def __init__(self, status=200, body=None, text=None, lines=None):
        self.status_code = status
        self._body = body
        self.text = text if text is not None else (json.dumps(body) if body is not None else "")
        self._lines = lines or []

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body

    def iter_lines(self):
        return iter(self._lines)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _svc():
    return L.LLMService()


def _chat(monkeypatch, response=None, exc=None, stream=False):
    def post(url, **kw):
        if exc:
            raise exc
        return response
    monkeypatch.setattr(requests, "post", post)
    out = _svc().generate_chat("qwen2.5vl:7b", [{"role": "user", "content": "hi"}], stream=stream)
    return list(out) if stream else out


def _assert_friendly(msg):
    assert "host.docker.internal" not in msg and "Server Error" not in msg and "api/chat" not in msg, msg


def test_out_of_memory_500_is_explained(monkeypatch):
    r = FakeResponse(500, {"error": "model requires more system memory (6.0 GiB) than is available (1.1 GiB)"})
    with pytest.raises(L.LLMBackendError) as e:
        _chat(monkeypatch, r)
    assert e.value.kind == "out_of_memory" and e.value.http_status == 503
    assert "qwen2.5vl:7b" in str(e.value) and "smaller model" in str(e.value)
    _assert_friendly(str(e.value))


def test_killed_runner_is_treated_as_out_of_memory(monkeypatch):
    r = FakeResponse(500, {"error": "llama runner process has terminated: signal: killed"})
    with pytest.raises(L.LLMBackendError) as e:
        _chat(monkeypatch, r)
    assert e.value.kind == "out_of_memory"


def test_other_500_shows_ollamas_own_text_but_no_internal_url(monkeypatch):
    r = FakeResponse(500, {"error": "something odd happened"})
    with pytest.raises(L.LLMBackendError) as e:
        _chat(monkeypatch, r)
    assert e.value.kind == "server_error" and "something odd happened" in str(e.value) and "HTTP 500" in str(e.value)
    _assert_friendly(str(e.value))


def test_timeout_and_unreachable_are_explained(monkeypatch):
    with pytest.raises(L.LLMBackendError) as e:
        _chat(monkeypatch, exc=requests.exceptions.ReadTimeout("read timed out"))
    assert e.value.kind == "timeout" and e.value.http_status == 504 and "smaller model" in str(e.value)
    with pytest.raises(L.LLMBackendError) as e:
        _chat(monkeypatch, exc=requests.exceptions.ConnectionError("refused http://host.docker.internal:11434"))
    assert e.value.kind == "unreachable" and "Ollama" in str(e.value)
    _assert_friendly(str(e.value))


def test_missing_model_is_unchanged(monkeypatch):
    with pytest.raises(L.ModelNotFoundError) as e:
        _chat(monkeypatch, FakeResponse(404, {"error": "model not found"}))
    assert "ollama pull qwen2.5vl:7b" in str(e.value)


def test_error_line_inside_a_200_stream_is_not_swallowed(monkeypatch):
    lines = [json.dumps({"message": {"content": "Die "}}).encode(), json.dumps({"error": "llama runner process has terminated: signal: killed"}).encode()]

    def post(url, **kw):
        return FakeResponse(200, lines=lines)
    monkeypatch.setattr(requests, "post", post)
    got = []
    with pytest.raises(L.LLMBackendError) as e:
        for chunk in _svc().generate_chat("qwen2.5vl:7b", [{"role": "user", "content": "hi"}], stream=True):
            got.append(chunk)
    assert got == ["Die "] and e.value.kind == "out_of_memory"


def test_http_error_before_the_stream_starts_is_explained(monkeypatch):
    with pytest.raises(L.LLMBackendError) as e:
        _chat(monkeypatch, FakeResponse(500, {"error": "unable to allocate CPU buffer"}), stream=True)
    assert e.value.kind == "out_of_memory"


def test_health_reports_the_real_version(tmp_path):
    assert re.fullmatch(r"\d+\.\d+\.\d+", settings.VERSION)
    assert settings.VERSION != "1.0.0"
    pytest.importorskip("httpx")
    # app.main opens its SQLite file at import time (relative path), so ask it in a private process and directory
    (tmp_path / "data").mkdir()
    code = ("from fastapi.testclient import TestClient; from app.main import app; "
            "import json; r = TestClient(app).get('/health'); print(json.dumps([r.status_code, r.json()]))")
    env = dict(os.environ, PYTHONPATH=str(BACKEND_DIR), ANONYMIZED_TELEMETRY="False")
    out = subprocess.run([sys.executable, "-c", code], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr[-500:]
    status, body = json.loads(out.stdout.strip().splitlines()[-1])
    assert status == 200 and body["version"] == settings.VERSION


def test_openai_compatible_errors_are_explained_without_leaking_the_key():
    class R:
        status_code = 401
    e = requests.exceptions.HTTPError("401 Client Error: Unauthorized for url: https://api.example.com/v1/chat/completions", response=R())
    err = L._openai_compatible_error(e)
    assert err.kind == "auth" and "API key" in str(err) and "example.com" not in str(err)
    assert L._openai_compatible_error(requests.exceptions.ConnectTimeout("x")).kind == "timeout"
    assert L._openai_compatible_error(requests.exceptions.ConnectionError("x")).kind == "unreachable"


def test_a_missing_model_in_a_stream_raises_instead_of_producing_answer_text(monkeypatch):
    monkeypatch.setattr(requests, "post", lambda url, **kw: FakeResponse(404, {"error": "model not found"}))
    with pytest.raises(L.ModelNotFoundError):
        list(_svc().generate_chat("nope:1b", [{"role": "user", "content": "hi"}], stream=True))
