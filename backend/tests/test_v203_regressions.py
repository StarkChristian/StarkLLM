"""v2.0.3 - defects found by testing v2.0.2 on a PC with only a thinking model (qwen3.5:4b) installed.

1. A thinking model spent the whole token limit on its 'thinking' field; the chat saved and returned an empty answer.
2. Source chips showed the upload name on disk ('529bb309_Project card.md') and vanished when the chat was reopened.
3. A CSV saved on Windows with a UTF-8 byte-order mark kept the mark in its first column name.
"""
import json
import os
import sys
from datetime import datetime

import pytest
import requests

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.api import chat as chat_api
from app.core.config import settings
from app.db import models
from app.services import llm_service as L
from app.services import vision_service as V
from app.services.rag_service import rag_service, source_display_name


class FakeResponse:
    def __init__(self, status=200, body=None, lines=None):
        self.status_code = status
        self._body = body
        self.text = json.dumps(body) if body is not None else ""
        self._lines = lines or []

    def json(self):
        return self._body

    def iter_lines(self):
        return iter(self._lines)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _post_returning(monkeypatch, response, sent=None):
    def post(url, json=None, **kw):
        if sent is not None:
            sent.append(json)
        return response
    monkeypatch.setattr(requests, "post", post)


# ---------------------------------------------------------------- 1. thinking models

def test_ollama_is_asked_not_to_think(monkeypatch):
    sent = []
    _post_returning(monkeypatch, FakeResponse(200, {"message": {"content": "PONG"}, "done": True}), sent)
    out = L.LLMService().generate_chat("qwen3.5:4b", [{"role": "user", "content": "ping"}], options={"num_predict": 40})
    assert out["message"]["content"] == "PONG"
    assert sent[0]["think"] is False


def test_an_answer_lost_to_thinking_raises_instead_of_returning_empty(monkeypatch):
    body = {"message": {"role": "assistant", "content": "", "thinking": "Let me consider..."}, "done": True, "done_reason": "length"}
    _post_returning(monkeypatch, FakeResponse(200, body))
    with pytest.raises(L.LLMBackendError) as e:
        L.LLMService().generate_chat("qwen3.5:4b", [{"role": "user", "content": "ping"}])
    assert e.value.kind == "empty_answer" and "Max tokens" in str(e.value) and "qwen3.5:4b" in str(e.value)


def test_a_stream_without_answer_text_raises(monkeypatch):
    lines = [json.dumps({"message": {"content": "", "thinking": "hmm"}}).encode(),
             json.dumps({"message": {"content": ""}, "done": True, "done_reason": "length"}).encode()]
    _post_returning(monkeypatch, FakeResponse(200, lines=lines))
    with pytest.raises(L.LLMBackendError) as e:
        list(L.LLMService().generate_chat("qwen3.5:4b", [{"role": "user", "content": "ping"}], stream=True))
    assert e.value.kind == "empty_answer" and "Max tokens" in str(e.value)


def test_a_normal_stream_is_unchanged(monkeypatch):
    lines = [json.dumps({"message": {"content": "Hal"}}).encode(), json.dumps({"message": {"content": "lo"}, "done": True}).encode()]
    _post_returning(monkeypatch, FakeResponse(200, lines=lines))
    assert list(L.LLMService().generate_chat("qwen2.5:7b", [{"role": "user", "content": "hi"}], stream=True)) == ["Hal", "lo"]


def test_an_empty_image_description_does_not_stop_indexing(monkeypatch, tmp_path):
    img = tmp_path / "blank.png"
    img.write_bytes(b"\x89PNG")
    _post_returning(monkeypatch, FakeResponse(200, {"message": {"content": ""}, "done": True}))
    assert V.VisionService().generate_image_description(str(img)) == ""


# ---------------------------------------------------------------- 2. citations

def test_source_chip_uses_the_original_upload_name():
    upload = os.path.join(settings.UPLOAD_DIR, "529bb309_Project card.md")
    assert source_display_name({"source": upload}) == "Project card.md"
    _, label = chat_api._build_citation_label({"metadata": {"source": upload, "chunk": 1}})
    assert label == "Project card.md (Chunk 1)"


def test_display_name_keeps_kb_names_and_files_outside_the_upload_folder():
    assert source_display_name({"source": "knowledge_base", "file_name": "Notes.md"}) == "Notes.md"
    assert source_display_name({"source": "/kb_data/deadbeef_report.md"}) == "deadbeef_report.md"
    assert source_display_name({"source": os.path.join(settings.UPLOAD_DIR, "report.md")}) == "report.md"


def test_sources_are_stored_with_the_answer_and_come_back_on_reopen():
    stored = chat_api._sources_json(True, ["Notes.md (Chunk 2)"], ["Project card.md (Chunk 1)"], ["Example"], ["https://example.com"])
    msg = models.Message(id=7, role="assistant", content="LANTERN-OAK-2026", sources=stored, created_at=datetime(2026, 10, 26))
    out = chat_api._message_out(msg)
    assert out["wsSources"] == ["Project card.md (Chunk 1)"] and out["kbSources"] == ["Notes.md (Chunk 2)"]
    assert out["kbUsed"] is True and out["webSources"] == [{"title": "Example", "url": "https://example.com"}]
    assert chat_api._sources_json(False, [], [], [], []) is None


def test_messages_table_has_a_sources_column():
    assert "sources" in models.Message.__table__.columns


def test_an_old_empty_answer_is_not_shown_as_still_loading():
    msg = models.Message(id=1, role="assistant", content="", created_at=datetime(2026, 10, 26))
    assert chat_api._message_out(msg)["content"] == "*[No answer was generated]*"


# ---------------------------------------------------------------- 3. CSV byte-order mark

def test_csv_with_a_byte_order_mark_has_a_clean_header(tmp_path):
    f = tmp_path / "colors.csv"
    f.write_bytes("item,color,code\nCrate,blue,CRATE-77-BLUE\n".encode("utf-8-sig"))
    chunks, _, _ = rag_service._process_file_to_chunks(str(f))
    text = "\n".join(chunks)
    assert "﻿" not in text and "ï»¿" not in text
    assert "item,color,code" in text and "CRATE-77-BLUE" in text
