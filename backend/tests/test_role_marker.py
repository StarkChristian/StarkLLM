"""A chat template that leaks its role header: llama3.1 through Ollama began the second answer in "Compare models"
with a line that only said "assistant" (2.6.0, test laptop). The marker is taken off every answer, streamed or not,
and a real first word stays."""
import json

import pytest
import requests

from app.core import netguard
from app.services import llm_service as L


@pytest.mark.parametrize("text, want", [
    ("assistant\nThe bill is due on 12 December.", "The bill is due on 12 December."),
    ("Assistant\n\nThe bill is due.", "The bill is due."),
    ("  assistant  \r\nHello", "Hello"),
    ("assistant:\nHello", "Hello"),
    ("Assistant:\nHello", "Hello"),
    ("**Assistant:**\nHello", "Hello"),
    ("<|assistant|>\nHello", "Hello"),
    ("<|assistant|>Hello", "Hello"),
    ("<|im_start|>assistant\nHello", "Hello"),
    ("<|start_header_id|>assistant<|end_header_id|>\n\nHello", "Hello"),
    ("<|im_start|>assistant\nassistant\nHello", "Hello"),
])
def test_a_leading_role_marker_is_removed(text, want):
    assert L.strip_role_marker(text) == want


@pytest.mark.parametrize("text", [
    "Assistant managers should approve the invoice first.",
    "Assistant: the word is used here as a label in the answer itself",
    "The assistant said nothing.\nassistant\n",
    "Assistant",
    "Hello",
    "",
])
def test_a_real_first_word_stays(text):
    assert L.strip_role_marker(text) == text


def _stream(chunks):
    return "".join(L.strip_role_marker_stream(iter(chunks)))


def test_the_marker_is_removed_from_a_stream_also_when_it_arrives_split():
    assert _stream(["assis", "tant", "\n", "The total is 63.40 GBP."]) == "The total is 63.40 GBP."
    assert _stream(["assistant", "\n\nThe total", " is 63.40 GBP."]) == "The total is 63.40 GBP."
    assert _stream(["<|start_header_id|>assis", "tant<|end_header_id|>", "\n\n", "Hello"]) == "Hello"
    assert _stream(["<|im_start|>", "assistant\nHello", " there"]) == "Hello there"
    assert _stream(["\n", "Assistant:", "\n", "Hello"]) == "Hello"


def test_a_stream_keeps_a_real_first_word_and_every_chunk_after_it():
    assert _stream(["Assis", "tant managers", " should approve it."]) == "Assistant managers should approve it."
    assert _stream(["Hello", "\nassistant\n", "world"]) == "Hello\nassistant\nworld"
    assert _stream(["Assistant"]) == "Assistant"
    chunks = list(L.strip_role_marker_stream(iter(["The", " total", " is", " due."])))
    assert chunks == ["The", " total", " is", " due."]  # nothing held back once the start is no marker


class _Response:
    status_code = 200

    def __init__(self, body=None, lines=None):
        self._body = body
        self.text = json.dumps(body) if body is not None else ""
        self._lines = lines or []

    def json(self):
        return self._body

    def raise_for_status(self):
        return None

    def iter_lines(self):
        return iter(self._lines)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_ollama_answers_streamed_and_not_streamed_lose_the_marker(monkeypatch):
    lines = [json.dumps({"message": {"content": c}}).encode() for c in ["assist", "ant", "\n", "Pay 63.40 GBP."]]
    monkeypatch.setattr(netguard, "post", lambda url, **kw: _Response(lines=lines))
    assert "".join(L.llm_service.generate_chat("llama3.1", [{"role": "user", "content": "?"}], stream=True)) == "Pay 63.40 GBP."

    body = {"message": {"role": "assistant", "content": "assistant\nPay 63.40 GBP."}}
    monkeypatch.setattr(netguard, "post", lambda url, **kw: _Response(body=body))
    out = L.llm_service.generate_chat("llama3.1", [{"role": "user", "content": "?"}], stream=False)
    assert out["message"]["content"] == "Pay 63.40 GBP."


def test_openai_compatible_answers_lose_the_marker(monkeypatch):
    lines = [("data: " + json.dumps({"choices": [{"delta": {"content": c}}]})).encode()
             for c in ["<|im_start|>assistant", "\n", "Hello"]] + [b"data: [DONE]"]
    monkeypatch.setattr(netguard, "post", lambda url, **kw: _Response(lines=lines))
    got = L.llm_service.generate_chat("m", [{"role": "user", "content": "?"}], stream=True, provider="openai",
                                      base_url="http://127.0.0.1:1234/v1")
    assert "".join(got) == "Hello"

    body = {"choices": [{"message": {"content": "Assistant:\nHello"}}]}
    monkeypatch.setattr(netguard, "post", lambda url, **kw: _Response(body=body))
    got = L.llm_service.generate_chat("m", [{"role": "user", "content": "?"}], stream=False, provider="openai",
                                      base_url="http://127.0.0.1:1234/v1")
    assert got["message"]["content"] == "Hello"
