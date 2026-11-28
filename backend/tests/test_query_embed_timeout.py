"""MSI §47: the embedding of a question must not wait 600 s for a busy Ollama."""
from app.services import llm_service as ls


def test_one_question_gets_a_short_timeout(monkeypatch):
    seen = {}

    class Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"embedding": [0.1]}

    def post(url, **kw):
        seen["timeout"] = kw["timeout"]
        return Resp()

    monkeypatch.setattr(ls.netguard, "post", post)
    assert ls.llm_service.generate_embeddings("m", "Quanto devo pagare?", timeout=ls.QUERY_EMBED_TIMEOUT) == [0.1]
    assert seen["timeout"] == ls.QUERY_EMBED_TIMEOUT and seen["timeout"][1] <= 90
    ls.llm_service.generate_embeddings("m", "passage")
    assert seen["timeout"] == ls.EMBED_TIMEOUT  # indexing keeps its long timeout
