"""A document whose indexing was cut off by closing the app is indexed again at the next start (N40)."""
import uuid

from app.api import documents as D
from app.db import models
from app.db.session import SessionLocal
from app.main import app  # noqa: F401  (creates the database, as in the other API tests)


def test_interrupted_documents_are_indexed_again_and_a_missing_file_fails_with_advice(tmp_path, monkeypatch):
    db = SessionLocal()
    try:
        user = models.User(username=f"resume-{uuid.uuid4().hex[:8]}", hashed_password="x")
        db.add(user)
        db.commit()
        ws = models.Workspace(name="Night", user_id=user.id)
        db.add(ws)
        db.commit()
        book = tmp_path / "moby-dick.pdf"
        book.write_bytes(b"%PDF-1.4")
        stuck = models.Document(filename="moby-dick.pdf", filepath=str(book), workspace_id=ws.id, status="embedding")
        gone = models.Document(filename="gone.pdf", filepath=str(tmp_path / "gone.pdf"), workspace_id=ws.id, status="extracting")
        fine = models.Document(filename="fine.pdf", filepath=str(book), workspace_id=ws.id, status="indexed")
        db.add_all([stuck, gone, fine])
        db.commit()
        ids = (stuck.id, gone.id, fine.id)
    finally:
        db.close()

    indexed = []
    monkeypatch.setattr(D, "_index_document_background", lambda doc_id, ws_id, user_id, path: indexed.append(doc_id))

    class Col:
        def delete(self, where=None):
            pass
    monkeypatch.setattr(D.rag_service, "get_or_create_collection", lambda ws_id, user_id: Col())
    D.resume_interrupted_indexing()

    assert ids[0] in indexed and ids[2] not in indexed and ids[1] not in indexed
    db = SessionLocal()
    try:
        failed = db.query(models.Document).filter(models.Document.id == ids[1]).first()
        assert failed.status == "failed" and "upload the file again" in failed.error_message
    finally:
        db.close()
