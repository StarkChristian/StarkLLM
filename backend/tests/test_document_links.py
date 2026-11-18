"""What the user decided about a document is deleted with it, so a new document with the same id does not inherit
it (MSI night test of 2.3.0, N38: a new bill arrived "done", under the deleted letter's title and case)."""
import uuid

from app.db import models
from app.db.session import SessionLocal
from app.main import app  # noqa: F401  (creates the database, as in the other API tests)


def _user_and_workspace(db):
    user = models.User(username=f"links-{uuid.uuid4().hex[:8]}", hashed_password="x")
    db.add(user)
    db.commit()
    ws = models.Workspace(name="Links", user_id=user.id)
    db.add(ws)
    db.commit()
    return user, ws


def _decide(db, user_id, doc_id, scope="ws"):
    db.add(models.DocumentReview(user_id=user_id, scope=scope, document_id=doc_id, status="done", title="OLD", case_key="old case"))
    db.add(models.DateChoice(user_id=user_id, scope=scope, document_id=doc_id, literal="03/04/2026", reading="dmy"))
    db.add(models.DeadlineReminder(user_id=user_id, scope=scope, document_id=doc_id, due_date="2026-12-20", kind="payment", days_before=3))
    db.add(models.DeadlineDone(user_id=user_id, scope=scope, document_id=doc_id, due_date="2026-12-20", kind="payment"))
    db.commit()


def _left(db, doc_id, scope="ws"):
    return sum(db.query(m).filter(m.scope == scope, m.document_id == doc_id).count() for m in models.DOCUMENT_LINKED)


def test_deleting_a_document_deletes_the_decisions_about_it():
    db = SessionLocal()
    try:
        user, ws = _user_and_workspace(db)
        doc = models.Document(filename="contract.pdf", filepath="/nowhere/contract.pdf", workspace_id=ws.id, status="indexed")
        db.add(doc)
        db.commit()
        doc_id = doc.id
        _decide(db, user.id, doc_id)
        assert _left(db, doc_id) == 4
        db.delete(doc)
        db.commit()
        assert _left(db, doc_id) == 0
    finally:
        db.close()


def test_rows_of_documents_deleted_by_older_versions_are_removed_at_start():
    db = SessionLocal()
    try:
        user, _ = _user_and_workspace(db)
        missing = 10_000_000 + int(uuid.uuid4().int % 1000)
        _decide(db, user.id, missing)
        _decide(db, user.id, missing, scope="kb")
        assert models.forget_orphans(db) >= 8
        assert _left(db, missing) == 0 and _left(db, missing, "kb") == 0
    finally:
        db.close()
