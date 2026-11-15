"""Language of answers and speech: English is the fallback, the answer follows the question, any language can be named,
voices and speech recognition are not tied to German and English."""
import app.main  # noqa: F401  (creates the tables)
from app.api.chat import DATE_QUESTION, ChatRequest, language_of
from app.api.studio import HEADINGS, _ground_rules, _localized
from app.services import voice_service as V
from app.services.locale_rules import language_name


def test_languages_are_named_from_any_code():
    assert language_name("de") == "German" and language_name("de-AT") == "German" and language_name("PT_br") == "Portuguese"
    assert language_name("tr") == "Turkish" and language_name("xx") is None and language_name(None) is None


def test_the_language_of_a_question_in_more_languages():
    assert language_of("Quando devo pagare la fattura e quanto?") == "Italian"
    assert language_of("¿Cuándo tengo que pagar la factura y cuánto es?") == "Spanish"
    assert language_of("Quando é que eu tenho de pagar a fatura? Não sei.") == "Portuguese"
    assert language_of("Когда мне нужно оплатить счёт, и сколько это стоит?") == "Russian"
    assert language_of("What do I have to pay by Friday?") == "English"


def test_date_questions_in_more_languages_get_the_dates_of_the_letters():
    for q in ("Quand dois-je payer la facture ?", "¿Cuándo vence el pago?", "Qual è la scadenza della fattura?",
              "Fatura son ödeme tarihi ne zaman?", "What is due this week?", "Welche Fristen habe ich?"):
        assert DATE_QUESTION.search(q), q


def test_the_ui_language_is_a_hint_for_short_questions():
    assert ChatRequest(workspace_id=1, message="ok", language="fr").language == "fr"
    assert ChatRequest(workspace_id=1, message="ok").language is None


def test_studio_writes_in_the_language_of_the_interface_whatever_it_is():
    for code, name in (("de", "German"), ("fr", "French"), ("tr", "Turkish"), ("en", "English")):
        assert f"in {name}" in _ground_rules(code)
    assert "language of the documents" in _ground_rules(None)
    assert "language of the documents" in _ground_rules("xx")
    prompt = "# Executive Summary\n## Risk Assessment & Critical Assumptions"
    assert _localized(prompt, "de") == "# Zusammenfassung\n## Risiken und Annahmen"
    assert _localized(prompt, "fr") == "# Synthèse\n## Risques et hypothèses"
    assert _localized(prompt, "tr") == prompt and _localized(prompt, None) == prompt  # the model translates the headings
    assert {"de", "fr"} <= set(HEADINGS)


def test_more_voices_are_offered_for_their_language(tmp_path, monkeypatch):
    monkeypatch.setattr(V, "VOICES_DIR", str(tmp_path))
    (tmp_path / "fr_FR-siwis-medium.onnx").write_bytes(b"x")
    (tmp_path / "fr_FR-siwis-medium.onnx.json").write_text("{}")
    (tmp_path / "tr_TR-dfki-medium.onnx").write_bytes(b"x")  # without its .json: not usable
    (tmp_path / "evil name.onnx").write_bytes(b"x")
    (tmp_path / "evil name.onnx.json").write_text("{}")
    models = V.voice_models()
    assert "fr_FR-siwis-medium" in models and "tr_TR-dfki-medium" not in models and "evil name" not in models
    assert set(V.VOICE_MODELS) <= set(models)  # the built-in voices stay
    assert V.voice_for_language("fr") == "fr_FR-siwis-medium" and V.voice_for_language("FR-ca") == "fr_FR-siwis-medium"
    assert V.voice_for_language("ja") == V.DEFAULT_VOICE and V.voice_for_language(None) == V.DEFAULT_VOICE


def test_the_voice_list_names_the_language_of_each_voice(tmp_path, monkeypatch):
    monkeypatch.setattr(V, "VOICES_DIR", str(tmp_path))
    monkeypatch.setattr(V, "VOICE_MODELS", {"en_US-lessac-medium": str(tmp_path / "en.onnx"), "de_DE-thorsten-medium": str(tmp_path / "missing.onnx")})
    (tmp_path / "en.onnx").write_bytes(b"x")
    assert V.available_voices() == [{"id": "en_US-lessac-medium", "language": "en"}]


def test_speech_recognition_takes_a_language_hint(monkeypatch):
    seen = {}

    class Model:
        def transcribe(self, path, beam_size, language):
            seen["language"] = language
            return [], None

    svc = V.VoiceService()
    svc._model = Model()
    svc.transcribe("x.webm")
    assert seen["language"] is None  # found by the model
    svc.transcribe("x.webm", "tr-TR")
    assert seen["language"] == "tr"
