"""Found in the pre-release check of v2.0.4 (8 November 2026)."""
from app.services import llm_service as L
from app.services import vision_service as V
from app.services.rag_service import rag_service


def _cand(cid, source, file_name=None):
    meta = {"source": source}
    if file_name:
        meta["file_name"] = file_name
    return {"id": cid, "content": cid, "metadata": meta}


def test_a_question_naming_an_uploaded_file_boosts_that_file(monkeypatch):
    # Uploads are stored as '<8 hex>_<name>'; the boost compared the question with that disk name.
    other = _cand("other", "/app/data/uploads/1/11111111_Notes.md", "Notes.md")
    card = _cand("card", "/app/data/uploads/1/529bb309_Project card.md", "Project card.md")
    monkeypatch.setattr(rag_service, "_raw_query", lambda *a, **k: [other, card])
    monkeypatch.setattr(rag_service, "_keyword_query", lambda *a, **k: [other, card])
    out = rag_service._hybrid_query(None, "What budget does Project card.md give?", 5)
    assert out[0]["id"] == "card"


def test_older_chunks_without_file_name_still_get_the_boost(monkeypatch):
    other = _cand("other", "/app/data/uploads/1/11111111_Notes.md")
    card = _cand("card", "/app/data/uploads/1/529bb309_Project card.md")
    monkeypatch.setattr(rag_service, "_raw_query", lambda *a, **k: [other, card])
    monkeypatch.setattr(rag_service, "_keyword_query", lambda *a, **k: [other, card])
    out = rag_service._hybrid_query(None, "What budget does Project card.md give?", 5)
    assert out[0]["id"] == "card"


def test_an_empty_image_description_means_nothing_to_describe(monkeypatch, tmp_path):
    img = tmp_path / "blank.png"
    img.write_bytes(b"\x89PNG")

    def empty(*a, **k):
        raise L.empty_answer_error("llava", False)

    monkeypatch.setattr(V.llm_service, "generate_chat", empty)
    assert V.VisionService().generate_image_description(str(img)) == ""


def test_other_vision_errors_still_raise(monkeypatch, tmp_path):
    img = tmp_path / "x.png"
    img.write_bytes(b"\x89PNG")

    def boom(*a, **k):
        raise L.LLMBackendError("model gone", kind="unreachable", http_status=503)

    monkeypatch.setattr(V.llm_service, "generate_chat", boom)
    try:
        V.VisionService().generate_image_description(str(img))
    except L.LLMBackendError as e:
        assert e.kind == "unreachable"
    else:
        raise AssertionError("expected the error to propagate")
