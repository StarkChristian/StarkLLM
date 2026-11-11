"""The scenario letters and the generated letter benchmark, checked without a language model on every change.

What StarkLLM shows as facts (dates, amounts, warnings) must not get worse silently (docs/RULES.md, R8 and R9).
The language model's answers are measured separately with backend/scenarios/run.py.
"""
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from app.services.dates_service import find_dates  # noqa: E402
from app.services.document_checks import findings, scam_signs, SCAM_THRESHOLD  # noqa: E402
from scenarios.documents import DOCUMENTS  # noqa: E402
from scenarios.letters import generate, score  # noqa: E402
from scenarios.run import EXPECTED_DATES  # noqa: E402

SCAMS = {"Mahnung_Finanzamt_dringend.pdf", "Screenshot_SMS_Paket.png", "Gewinnbenachrichtigung.pdf", "Inkasso_Forderung.pdf"}
TEXT = {d["file"]: d["text"] for d in DOCUMENTS}


def test_every_expected_date_of_the_scenario_letters_is_found():
    for file, when in EXPECTED_DATES:
        assert when in {f.date for f in find_dates(TEXT[file])}, (file, when)


def test_scams_are_recognised_and_genuine_letters_are_not():
    for file, text in TEXT.items():
        points = sum(s["weight"] for s in scam_signs(text))
        if file in SCAMS:
            assert points >= SCAM_THRESHOLD or any(f["kind"] == "ai_instructions" for f in findings([{"file": file, "text": text}])), file
        else:
            assert points < SCAM_THRESHOLD, (file, scam_signs(text))


def test_generated_letters_benchmark():
    # 300 letters in many wordings (dates with and without year, amounts in German and English formats, fees,
    # old amounts, label lines). Thresholds below 100 % leave room for new letter types added to the generator.
    result = score(generate(300), find_dates)
    assert result["recall"] >= 0.97 and result["precision"] >= 0.97, (result["misses"] + result["wrong"])[:10]
    assert result["amount_accuracy"] >= 0.95 and result["kind_accuracy"] >= 0.95, result["wrong"][:10]


def test_wordings_that_were_not_used_to_tune_the_finder():
    def one(text):
        return [(f.date, f.kind, f.amount, f.time) for f in find_dates(text)]
    assert one("Datum: 02.11.2026\nFällig: 15.12.2026\nBetrag: 412,00 EUR") == [("2026-12-15", "deadline", "412,00 EUR", None)]
    assert one("Datum: 02.11.2026\nIhr Termin wurde auf Montag, den 7.12.2026, 9 Uhr verlegt.") == [("2026-12-07", "appointment", None, "09:00")]
    assert one("Datum: 02.11.2026\nDie Abbuchung von 59,00 EUR erfolgt am 15.12.") == [("2026-12-15", "payment", "59,00 EUR", None)]
    assert one("Datum: 20.12.2026\nBitte zahlen Sie bis zum 05.01. den Betrag von 30,00 EUR.") == [("2027-01-05", "deadline", "30,00 EUR", None)]
    assert one("Date: 3 November 2026\nYour subscription renews on 1 December 2026 for EUR 9.99.") == [("2026-12-01", "payment", "9.99 EUR", None)]
    # nothing to do: no date, a relative deadline, a past change, a period
    assert one("Datum: 02.11.2026\nBitte begleichen Sie 120,00 EUR innerhalb von 14 Tagen.") == []
    assert one("Datum: 02.11.2026\nSeit dem 01.10.2026 gilt der neue Tarif.") == []
    assert one("Abrechnungszeitraum 01.01.2025 bis 31.12.2025") == []
    # the old amount is not the one due
    assert one("Ihr Beitrag beträgt 687,12 EUR (bisher 598,40 EUR). Grund ist X. Der Betrag wird am 01.01.2027 abgebucht.")[0][2] == "687,12 EUR"
