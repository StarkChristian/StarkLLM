"""Windows test of 2.1.0 (N2): a year right before a currency code was read as the amount. The inbox showed "2026 GBP"
for "Electricity October 2026 GBP 129.40" and "2026 CHF" for "Water Q3 2026 CHF 64.70"; the real amount was lost.
The rule is in app/services/dates_service.py (_year_before_amount)."""
from datetime import date, timedelta

import pytest

from app.services.dates_service import AMOUNT, find_dates
from app.services.facts_service import amounts, document_facts


def values(text):
    return [(a["value"], a["number"], a["currency"]) for a in amounts({1: text})]


@pytest.mark.parametrize("line,expected", [
    ("Electricity October 2026 GBP 129.40", ("129.40 GBP", "129.40", "GBP")),
    ("Water Q3 2026 CHF 64.70", ("64.70 CHF", "64.70", "CHF")),
    ("Abschlag November 2026 EUR 58,10", ("58,10 EUR", "58.10", "EUR")),
    ("Facture octobre 2026 EUR 89,00", ("89,00 EUR", "89.00", "EUR")),
    # the line break of a PDF between the year and the currency changes nothing
    ("Electricity October 2026\nGBP 129.40", ("129.40 GBP", "129.40", "GBP")),
    # the year after a month, a quarter or the word for year, even when the amount has no cents
    ("Abschlag November 2026 EUR 58", ("58 EUR", "58.00", "EUR")),
    ("Beitrag Jahr 2026 EUR 120", ("120 EUR", "120.00", "EUR")),
    ("Steuer 4. Quartal 2026 EUR 30", ("30 EUR", "30.00", "EUR")),
    ("Cuota año 2026 EUR 30,00", ("30,00 EUR", "30.00", "EUR")),
    ("Fattura settembre 2026 EUR 1.234,56", ("1.234,56 EUR", "1234.56", "EUR")),
    ("Elektrik Ekim 2026 TRY 412,50", ("412,50 TRY", "412.50", "TRY")),
])
def test_the_year_of_the_period_is_not_the_amount(line, expected):
    assert values(line) == [expected]


@pytest.mark.parametrize("line,expected", [
    # a real amount of 2026 is still an amount: nothing follows the currency
    ("Total 2026 EUR", [("2026 EUR", "2026.00", "EUR")]),
    ("Rechnungsbetrag: 1999 CHF", [("1999 CHF", "1999.00", "CHF")]),
    # a whole number after the currency and nothing before that makes 1950 a year: 1950 EUR is what is due
    ("Bitte zahlen Sie 1950 EUR 14 Tage nach Erhalt", [("1950 EUR", "1950.00", "EUR")]),
    # not a year at all, or not a plain one: unchanged
    ("Total 2500 EUR 12,00", [("2500 EUR", "2500.00", "EUR")]),
    ("October 2026 2.026,00 EUR", [("2.026,00 EUR", "2026.00", "EUR")]),
])
def test_a_real_four_digit_amount_before_a_currency_still_counts(line, expected):
    assert values(line) == expected


def test_both_amounts_of_a_line_with_two_currencies_stay():
    assert values("Gas Q4 2026 EUR 58,10, previous year EUR 49,90") == [
        ("58,10 EUR", "58.10", "EUR"), ("49,90 EUR", "49.90", "EUR")]


def test_search_follows_the_same_rule():
    m = AMOUNT.search("Electricity October 2026 GBP 129.40")
    assert (m.group("c1"), m.group("n1")) == ("GBP", "129.40")
    assert AMOUNT.search("no amount here") is None


def test_the_deadline_carries_the_right_amount():
    due = date.today() + timedelta(days=14)
    text = (f"City Utilities\nDate: {date.today():%d %B %Y}\nElectricity October 2026 GBP 129.40\n"
            f"Water Q3 2026 CHF 64.70\nPlease pay by {due:%d %B %Y}.\n")
    facts = document_facts({1: text})
    assert [a["value"] for a in facts["amounts"]] == ["129.40 GBP", "64.70 CHF"]
    assert [(d["value"], d["amount"]) for d in facts["dates"]] == [(due.isoformat(), "64.70 CHF")]
    found = find_dates("Abschlag November 2026 EUR 58,10, bitte zahlen Sie bis zum 15.12.2026.")
    assert [(f.date, f.amount) for f in found] == [("2026-12-15", "58,10 EUR")]
