"""A document that cannot be embedded must say what to do, not show a raw connection error."""
import os
import sys

import requests

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.services.llm_service import describe_indexing_error


def test_unreachable_ollama_is_explained():
    msg = describe_indexing_error(requests.exceptions.ConnectionError("HTTPConnectionPool(host='x', port=9): Max retries"))
    assert "Ollama" in msg and "HTTPConnectionPool" not in msg and "nomic-embed-text" in msg


def test_timeout_is_explained():
    assert "too long" in describe_indexing_error(requests.exceptions.ReadTimeout("read timed out"))


def test_missing_embedding_model_is_explained():
    resp = requests.Response()
    resp.status_code = 404
    msg = describe_indexing_error(requests.exceptions.HTTPError("404", response=resp))
    assert "ollama pull" in msg


def test_other_errors_keep_their_text_but_are_capped():
    assert describe_indexing_error(ValueError("No text content could be extracted")) == "No text content could be extracted"
    assert len(describe_indexing_error(ValueError("x" * 2000))) == 500


def test_unreachable_ollama_fails_the_document_at_once_instead_of_once_per_passage(monkeypatch):
    # seen in a scenario test: with Ollama unreachable, every passage was retried alone and the document stayed at
    # "embedding" for hours; now the first failed connection ends it, and every call has a timeout
    from app.services import llm_service as mod

    calls = []

    def post(url, json=None, timeout=None, **kw):
        calls.append(timeout)
        raise requests.exceptions.ConnectTimeout("connect timed out")

    monkeypatch.setattr(mod.requests, "post", post)
    try:
        mod.llm_service.generate_embeddings_batch("nomic-embed-text", ["a", "b", "c"])
        raise AssertionError("expected a connection error")
    except requests.exceptions.ConnectTimeout as e:
        assert "too long" in describe_indexing_error(e) or "not reachable" in describe_indexing_error(e)
    assert len(calls) == 1 and calls[0] is not None
