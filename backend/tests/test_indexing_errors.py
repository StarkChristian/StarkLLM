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
