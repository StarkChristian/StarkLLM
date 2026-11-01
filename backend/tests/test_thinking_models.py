"""Thinking models (qwen3, deepseek-r1, ...) write a hidden draft in Ollama's "thinking" field before the answer.

Found on a real PC: with qwen3.5:4b and max_tokens 40 the whole budget went into thinking, the chat API answered
HTTP 200 with {"response": ""} and the empty answer was stored; the UI then showed the "thinking" dots forever.
"""
import json

import pytest
import requests

from app.core.config import settings
from app.services import llm_service as L


class FakeResponse:
    def __init__(self, body=None, lines=None):
        self.status_code = 200
        self._body = body
        self.text = json.dumps(body) if body is not None else ""
        self._lines = [json.dumps(x).encode() for x in (lines or [])]

    def json(self):
        return self._body

    def iter_lines(self):
        return iter(self._lines)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _chat(monkeypatch, response, stream=False, seen=None):
    def post(url, json=None, **kw):
        if seen is not None:
            seen.append(json)
        return response
    monkeypatch.setattr(requests, "post", post)
    out = L.LLMService().generate_chat("qwen3:0.6b", [{"role": "user", "content": "hi"}], stream=stream, options={"num_predict": 40})
    return list(out) if stream else out


def test_thinking_is_switched_off_by_default(monkeypatch):
    seen = []
    _chat(monkeypatch, FakeResponse({"message": {"content": "PONG"}}), seen=seen)
    assert seen[0]["think"] is False


def test_thinking_can_be_switched_on(monkeypatch):
    monkeypatch.setattr(settings, "OLLAMA_THINK", True)
    seen = []
    _chat(monkeypatch, FakeResponse({"message": {"content": "PONG"}}), seen=seen)
    assert seen[0]["think"] is True


def test_budget_spent_on_thinking_is_an_error_not_an_empty_answer(monkeypatch):
    with pytest.raises(L.LLMBackendError) as e:
        _chat(monkeypatch, FakeResponse({"message": {"content": "", "thinking": "Okay, the user wants..."}}))
    assert e.value.kind == "empty_answer" and e.value.http_status == 502
    assert "token limit" in str(e.value) and "thinking" in str(e.value)


def test_empty_answer_without_thinking_is_an_error_too(monkeypatch):
    with pytest.raises(L.LLMBackendError) as e:
        _chat(monkeypatch, FakeResponse({"message": {"content": "  "}}))
    assert "empty answer" in str(e.value)


def test_stream_that_only_thinks_ends_with_an_error(monkeypatch):
    lines = [{"message": {"content": "", "thinking": "Hmm"}}, {"message": {"content": ""}, "done": True}]
    with pytest.raises(L.LLMBackendError) as e:
        _chat(monkeypatch, FakeResponse(lines=lines), stream=True)
    assert e.value.kind == "empty_answer"


def test_normal_stream_is_unchanged(monkeypatch):
    lines = [{"message": {"content": "PO"}}, {"message": {"content": "NG"}}, {"done": True}]
    assert "".join(_chat(monkeypatch, FakeResponse(lines=lines), stream=True)) == "PONG"
