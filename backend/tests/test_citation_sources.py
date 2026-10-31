"""Source chips: the uploaded name, not the file on disk, and they survive reopening the chat.

Found on a real PC (26 October 2026): the chip said "529bb309_Project card.md (Chunk 1)" and was gone after the
chat was opened again, because sources only travelled in the live response headers.
"""
from app.api.chat import _build_citation_label
from app.db import models
from app.services.rag_service import rag_service


def test_label_uses_the_stored_upload_name():
    _, ui = _build_citation_label({"metadata": {"file_name": "Project card.md", "source": "/app/data/uploads/1/529bb309_Project card.md", "locator": "Chunk 1"}})
    assert ui == "Project card.md (Chunk 1)"


def test_label_of_older_chunks_drops_the_upload_prefix():
    _, ui = _build_citation_label({"metadata": {"source": "/app/data/uploads/1/529bb309_Project card.md", "locator": "Chunk 1"}})
    assert ui == "Project card.md (Chunk 1)"


def test_label_keeps_names_that_only_look_similar():
    _, ui = _build_citation_label({"metadata": {"source": "/x/report_2026.md", "locator": "Chunk 2"}})
    assert ui == "report_2026.md (Chunk 2)"


def test_add_document_stores_the_display_name(monkeypatch, tmp_path):
    f = tmp_path / "529bb309_Project card.csv"
    f.write_text("item,code\nLamp,L-1\n", encoding="utf-8")
    stored = {}
    monkeypatch.setattr(rag_service, "get_or_create_collection", lambda *a: type("C", (), {"name": "c"})())
    monkeypatch.setattr(rag_service, "_embed_and_store", lambda col, chunks, metas, ids, label: stored.update(metas=metas))
    rag_service.add_document(1, 1, str(f), display_name="Project card.csv")
    assert stored["metas"] and all(m["file_name"] == "Project card.csv" for m in stored["metas"])


def test_messages_have_a_sources_column():
    assert "sources" in models.Message.__table__.columns
