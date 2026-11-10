"""Scenario test finding: with English instructions and German or English letters, a small model answered German
questions in English. The language of the message is detected and named at the end of the prompt."""
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
