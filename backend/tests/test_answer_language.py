"""Scenario test finding: with English instructions and German or English letters, a small model answered German
questions in English. The language of the message is detected and named at the end of the prompt."""
import app.main  # noqa: F401  (creates the tables)
from app.api.chat import DATE_QUESTION, language_of


def test_the_language_of_typical_questions():
    assert language_of("Wie viel muss ich ans Finanzamt nachzahlen und bis wann?") == "German"
    assert language_of("Hallo! Wer bist du?") == "German"
    assert language_of("When is my appointment at the employment agency and what do I have to bring?") == "English"
    assert language_of("Agentur für Arbeit'teki randevum ne zaman ve gitmezsem ne olur?") == "Turkish"
    assert language_of("Quand dois-je payer la facture ?") == "French"


def test_unclear_messages_get_no_language():
    assert language_of("ok") is None
    assert language_of("") is None


def test_date_questions_are_recognised_in_several_languages():
    for q in ("Welche Fristen habe ich in den nächsten zwei Wochen?", "Was muss ich bis Ende des Jahres bezahlen?",
              "Wie hoch ist mein Beitrag?", "What is due this week?", "Randevum ne zaman?"):
        assert DATE_QUESTION.search(q), q
    for q in ("Darf ich eine Katze halten?", "Hallo! Wer bist du?"):
        assert not DATE_QUESTION.search(q), q


def test_words_in_no_document_are_named_but_compounds_of_known_words_are_not(tmp_path):
    # "Mietkaution" is in no document, but "Miete" and "Kaution" are: telling the model it is missing made it refuse
    import uuid
    from app.api.chat import _terms_missing
    from app.db import models
    from app.db.session import SessionLocal
    from app.services.rag_service import rag_service
    db = SessionLocal()
    try:
        user = models.User(username=f"terms_{uuid.uuid4().hex[:8]}", hashed_password="x")
        db.add(user)
        db.commit()
        ws = models.Workspace(name="Post", user_id=user.id)
        db.add(ws)
        db.commit()
        user_id, ws_id = user.id, ws.id
    finally:
        db.close()
    col = rag_service.get_or_create_collection(ws_id, user_id)
    try:
        col.add(ids=["a", "b"], embeddings=[[1.0, 0.0], [0.0, 1.0]], metadatas=[{"source": "/a"}, {"source": "/b"}],
                documents=["Die Miete beträgt 890 EUR. Die Kaution beträgt 2.670 EUR. Kündigung mit einer Frist von drei Monaten.",
                           "Kfz-Versicherung: Beitrag 687,12 EUR."])
        assert _terms_missing("Wie hoch war meine Mietkaution?", ws_id, user_id, False) == []
        assert _terms_missing("Wie lange ist meine Kündigungsfrist?", ws_id, user_id, False) == []
        assert _terms_missing("Wie hoch ist meine Hausratversicherung?", ws_id, user_id, False) == ["Hausratversicherung"]
        assert _terms_missing("Wann ist mein Zahnarzttermin?", ws_id, user_id, False) == ["Zahnarzttermin"]
        # everyday word for what the letter calls otherwise: the car insurer writes "Kfz-Versicherung"
        assert _terms_missing("Was kostet meine Autoversicherung?", ws_id, user_id, False) == []
    finally:
        rag_service.chroma_client.delete_collection(f"user_{user_id}_workspace_{ws_id}")
