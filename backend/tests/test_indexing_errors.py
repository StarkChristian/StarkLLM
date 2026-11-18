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


def test_every_ollama_chat_asks_for_a_context_window_that_holds_the_prompt(monkeypatch):
    # scenario test: Ollama cut a 4263-token prompt to 2050 tokens from the front, so the retrieved passages were lost
    from app.services import llm_service as mod

    sent = []

    class Answer:
        status_code = 200

        def raise_for_status(self):
            pass

        def json(self):
            return {"message": {"content": "ok"}}

    def post(url, json=None, timeout=None, **kw):
        sent.append(json)
        return Answer()

    monkeypatch.setattr(mod.requests, "post", post)
    mod._context_used.clear()
    short = [{"role": "user", "content": "Hallo"}]
    long = [{"role": "system", "content": "x" * 15000}, {"role": "user", "content": "Frage"}]
    mod.llm_service.generate_chat("m1", short)
    mod.llm_service.generate_chat("m1", long)
    mod.llm_service.generate_chat("m1", short)
    sizes = [p["options"]["num_ctx"] for p in sent]
    assert sizes == [4096, 8192, 8192]  # grows to fit, then stays (no model reload for every message)
    mod.llm_service.generate_chat("m2", short, options={"num_ctx": 2048})
    assert sent[-1]["options"]["num_ctx"] == 2048  # a setting from the user wins
    assert mod.context_window([{"content": "x" * 200000}]) == mod.CONTEXT_MAX


def test_a_file_renamed_to_pdf_gets_a_clear_message_without_the_internal_path():
    # N39 (MSI night test of 2.3.0): a text file named .pdf
    msg = describe_indexing_error(RuntimeError("Failed to open file 'data/uploads\\426583b5_fake-night.pdf' as type pdf."))
    assert msg.startswith("This file could not be opened as PDF") and "renamed to .pdf" in msg and "uploads" not in msg
    other = describe_indexing_error(ValueError("No text in C:\\Users\\x\\data\\uploads\\0123abcd_letter.pdf"))
    assert "uploads" not in other and "letter.pdf" in other
def _answer(status, embeddings=None, text=""):
    resp = requests.Response()
    resp.status_code = status
    resp._content = (text or "").encode()

    class A:
        status_code = status

        def raise_for_status(self):
            if status >= 400:
                raise requests.exceptions.HTTPError(f"{status}", response=resp)

        def json(self):
            return {"embeddings": embeddings}
    return A()


def test_embeddings_go_in_batches_and_a_refused_batch_is_split_not_sent_one_by_one(monkeypatch):
    # N27: a whole book went to Ollama in one request; a 400 then sent every passage of the book alone
    from app.services import llm_service as mod

    batches, singles = [], []

    def post(url, json=None, timeout=None, **kw):
        if url.endswith("/api/embeddings"):
            singles.append(json["prompt"])
            return type("S", (), {"raise_for_status": lambda self: None, "json": lambda self: {"embedding": [9.0]}})()
        batch = json["input"]
        batches.append(len(batch))
        if "bad" in batch:
            return _answer(400, text='{"error":"input rejected"}')
        return _answer(200, [[float(len(x))] for x in batch])

    monkeypatch.setattr(mod.requests, "post", post)
    prompts = [f"p{i}" for i in range(150)]
    prompts[70] = "bad"
    out = mod.llm_service.generate_embeddings_batch("nomic-embed-text", prompts)
    assert len(out) == 150 and out[70] == [9.0] and out[0] == [2.0] and out[149] == [4.0]
    assert singles == ["bad"]                       # only the refused passage goes alone
    assert batches[:3] == [64, 64, 22] or batches[0] == 64
    assert max(batches) <= mod.EMBED_BATCH and len(batches) < 20


def test_a_missing_embedding_model_is_not_retried_passage_by_passage(monkeypatch):
    from app.services import llm_service as mod

    calls = []

    def post(url, json=None, timeout=None, **kw):
        calls.append(url)
        return _answer(404, text='{"error":"model not found"}')

    monkeypatch.setattr(mod.requests, "post", post)
    try:
        mod.llm_service.generate_embeddings_batch("nomic-embed-text", ["a", "b", "c"])
        raise AssertionError("expected the 404")
    except requests.exceptions.HTTPError as e:
        assert "ollama pull" in describe_indexing_error(e)
    assert len(calls) == 1
