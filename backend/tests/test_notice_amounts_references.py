"""MSI test of 2.0.16 (real Windows PC): P4 amounts in GBP, £, CHF and other currencies, P7 one reference listed twice,
P3 notice periods of contracts ("at least 30 days before 31 March 2027": the last day to give notice is 1 March 2027)."""
import pytest
from datetime import date, timedelta

from app.api.dashboard import dates_calendar, document_dates, document_inbox
from app.services.dates_service import find_dates, minus_period
from app.services.facts_service import document_facts
from test_document_inbox import _user

F = lambda text: [(f.date, f.kind, f.amount, f.notice and f.notice["base"]) for f in find_dates(text)]


# ---- P4: currencies ---------------------------------------------------------------------------------------------

INVOICE = ("Harbour Services Ltd\nDate: {written}\nInvoice number: INV-2026-0042\nInvoice\n"
           "Total due: GBP 148.90\nPlease pay by {due}.\n")


def test_gbp_on_an_english_invoice_is_an_amount_in_the_facts_the_deadline_and_the_calendar(tmp_path):
    due = date.today() + timedelta(days=20)
    text = INVOICE.format(written=date.today().strftime("%d %B %Y"), due=due.strftime("%d %B %Y"))
    facts = document_facts({1: text})
    assert [(a["value"], a["number"], a["currency"]) for a in facts["amounts"]] == [("148.90 GBP", "148.90", "GBP")]
    assert [(d["value"], d["amount"]) for d in facts["dates"]] == [(due.isoformat(), "148.90 GBP")]
    (user_id, _), _, _ = _user(tmp_path, [("invoice.pdf", text)])
    from app.db.session import SessionLocal
    db = SessionLocal()
    try:
        (doc,) = document_inbox(db, user_id)["documents"]  # the inbox
        assert [a["value"] for a in doc["facts"]["amounts"]] == ["148.90 GBP"]
        assert doc["next"]["amount"] == "148.90 GBP"
        _, _, dates = document_dates(db, user_id, past_days=0)  # the start page
        assert [(d["date"], d["amount"]) for d in dates] == [(due.isoformat(), "148.90 GBP")]
        assert "(148.90 GBP)" in dates_calendar(date.today(), dates, "20260101T000000Z")  # the calendar entry
    finally:
        db.close()


@pytest.mark.parametrize("written,shown,code", [
    ("GBP 148.90", "148.90 GBP", "GBP"), ("£148.90", "148.90 GBP", "GBP"), ("£ 1,148.90", "1,148.90 GBP", "GBP"),
    ("148.90 GBP", "148.90 GBP", "GBP"), ("148.90 £", "148.90 GBP", "GBP"), ("148,90 £", "148,90 GBP", "GBP"),
    ("CHF 148.90", "148.90 CHF", "CHF"), ("CHF 1'148.90", "1'148.90 CHF", "CHF"), ("148.90 CHF", "148.90 CHF", "CHF"),
    ("Fr. 148.90", "148.90 CHF", "CHF"), ("SFr. 148.90", "148.90 CHF", "CHF"), ("CHF 148.-", "148.- CHF", "CHF"),
    ("USD 148.90", "148.90 USD", "USD"), ("$148.90", "148.90 USD", "USD"), ("$ 1,148.90", "1,148.90 USD", "USD"),
    ("148.90 USD", "148.90 USD", "USD"), ("US$ 148.90", "148.90 USD", "USD"),
    ("EUR 148.90", "148.90 EUR", "EUR"), ("€148,90", "148,90 EUR", "EUR"), ("€ 1.148,90", "1.148,90 EUR", "EUR"),
    ("148,90 €", "148,90 EUR", "EUR"), ("1 148,90 €", "1 148,90 EUR", "EUR"), ("148,90 Euro", "148,90 EUR", "EUR"),
    ("148,90 EUR", "148,90 EUR", "EUR"),
    ("TRY 148.90", "148.90 TRY", "TRY"), ("148,90 TL", "148,90 TRY", "TRY"), ("₺148,90", "148,90 TRY", "TRY"),
    ("SEK 148.90", "148.90 SEK", "SEK"), ("NOK 148.90", "148.90 NOK", "NOK"), ("DKK 148.90", "148.90 DKK", "DKK"),
    ("PLN 148.90", "148.90 PLN", "PLN"), ("148,90 zł", "148,90 PLN", "PLN"), ("CZK 148.90", "148.90 CZK", "CZK"),
    ("CAD 148.90", "148.90 CAD", "CAD"), ("AUD 148.90", "148.90 AUD", "AUD"), ("JPY 14890", "14890 JPY", "JPY"),
    ("INR 148.90", "148.90 INR", "INR"), ("₹148.90", "148.90 INR", "INR"),
])
def test_amounts_in_common_currencies_with_the_symbol_before_or_after(written, shown, code):
    facts = document_facts({1: f"Muster Ltd\nInvoice\nThe total is {written} for the services.\n"})
    assert [(a["value"], a["currency"]) for a in facts["amounts"]] == [(shown, code)], written


# ---- P7: one reference, once ---------------------------------------------------------------------------------------

def test_a_reference_with_a_full_stop_behind_it_is_listed_once():
    text = ("Harbour Services Ltd\nInvoice number: INV-2026-0042\nPlease quote the reference INV-2026-0042.\n"
            "Our reference: INV-2026-0042, thank you; (ref. INV-2026-0042)\n")
    facts = document_facts({1: text})
    assert [(r["kind"], r["value"]) for r in facts["references"]] == [("invoice_number", "INV-2026-0042")]
    only = document_facts({1: "Harbour Ltd\nInvoice\nPlease quote the reference INV-2026-0042.\n"})
    assert [(r["kind"], r["value"]) for r in only["references"]] == [("reference", "INV-2026-0042")]


def test_different_references_stay_different():
    facts = document_facts({1: "Muster AG\nRechnung\nKundennummer: 4400-118\nRechnungsnummer: RE-2026-1\nReferenz: RE-2026-2.\n"})
    assert [(r["kind"], r["value"]) for r in facts["references"]] == [
        ("customer_number", "4400-118"), ("invoice_number", "RE-2026-1"), ("reference", "RE-2026-2")]


# ---- P3: notice periods ------------------------------------------------------------------------------------------------

def test_counting_back_a_period():
    assert minus_period(date(2027, 3, 31), 30, "days") == date(2027, 3, 1)
    assert minus_period(date(2027, 3, 31), 4, "weeks") == date(2027, 3, 3)
    assert minus_period(date(2026, 12, 31), 3, "months") == date(2026, 9, 30)
    assert minus_period(date(2027, 3, 31), 1, "months") == date(2027, 2, 28)  # no 31 February
    assert minus_period(date(2027, 1, 15), 2, "months") == date(2026, 11, 15)  # across the new year
    assert minus_period(date(2028, 3, 31), 1, "months") == date(2028, 2, 29)


NOTICE = [
    ("en", "Date: 3 November 2026\nYou may cancel the contract. Notice must be given at least 30 days before 31 March 2027.", "2027-03-01", "2027-03-31"),
    ("en", "Date: 3 November 2026\nTo terminate this agreement, write to us no later than 2 months before 31 December 2027.", "2027-10-31", "2027-12-31"),
    ("en", "Date: 3 November 2026\nWe need 4 weeks' notice before 31 March 2027 if you want to cancel.", "2027-03-03", "2027-03-31"),
    ("de", "Datum: 03.11.2026\nDie Kündigung muss mindestens 30 Tage vor dem 31.03.2027 bei uns eingehen.", "2027-03-01", "2027-03-31"),
    ("de", "Datum: 03.11.2026\nSie können kündigen, drei Monate vor Vertragsende am 31.12.2026.", "2026-09-30", "2026-12-31"),
    ("de", "Datum: 03.11.2026\nKündigung bitte spätestens 4 Wochen vor dem 31. März 2027.", "2027-03-03", "2027-03-31"),
    ("fr", "Paris, le 3 novembre 2026\nLe préavis doit être donné au moins 2 mois avant le 31 mars 2027.", "2027-01-31", "2027-03-31"),
    ("fr", "Paris, le 3 novembre 2026\nPour résilier le contrat, prévenez-nous 30 jours avant le 31/03/2027.", "2027-03-01", "2027-03-31"),
    ("es", "Madrid, 3 de noviembre de 2026\nPara rescindir el contrato debe avisar al menos 30 días antes del 31 de marzo de 2027.", "2027-03-01", "2027-03-31"),
    ("es", "Madrid, 3 de noviembre de 2026\nEl preaviso de baja es de tres meses antes del 31 de diciembre de 2026.", "2026-09-30", "2026-12-31"),
    ("it", "Roma, 3 novembre 2026\nLa disdetta va inviata almeno 30 giorni prima del 31 marzo 2027.", "2027-03-01", "2027-03-31"),
    ("it", "Roma, 3 novembre 2026\nPer recedere dal contratto serve un preavviso di 2 mesi prima del 31/12/2026.", "2026-10-31", "2026-12-31"),
    ("tr", "Ankara, 3 Kasım 2026\nSözleşmeyi feshetmek için 31 Mart 2027 tarihinden en az 30 gün önce bildirim yapmalısınız.", "2027-03-01", "2027-03-31"),
    ("tr", "Ankara, 3 Kasım 2026\nİptal bildirimi 31.12.2026 tarihinden 2 ay önce verilmelidir.", "2026-10-31", "2026-12-31"),
]


@pytest.mark.parametrize("lang,text,last_day,base", NOTICE, ids=[f"{n[0]}-{i}" for i, n in enumerate(NOTICE)])
def test_the_last_day_to_give_notice_is_counted_back_from_the_end_date(lang, text, last_day, base):
    # one date, the last day to give notice; the end of the contract is not the deadline
    assert F(text) == [(last_day, "deadline", None, base)]


def test_the_notice_date_carries_its_sentence_page_and_line():
    pages = {1: "Harbour Services Ltd\nDate: 3 November 2026\nContract C-77", 2: "Terms\nNotice must be given at least 30 days before 31 March 2027.\nThank you"}
    facts = document_facts(pages)
    (d,) = [x for x in facts["dates"] if x["kind"] == "deadline"]
    assert d["value"] == "2027-03-01" and d["page"] == 2
    assert d["notice"] == {"date": "2027-03-01", "base": "2027-03-31", "count": 30, "unit": "days"}
    assert "Notice must be given at least 30 days before 31 March 2027" in d["text"]


def test_a_notice_that_goes_into_the_calendar_says_what_it_is(tmp_path):
    base = date.today() + timedelta(days=200)
    text = f"Harbour Ltd\nDate: {date.today():%d %B %Y}\nTenancy agreement\nNotice must be given at least 30 days before {base:%d %B %Y}.\n"
    (user_id, _), _, _ = _user(tmp_path, [("lease.pdf", text)])
    from app.db.session import SessionLocal
    db = SessionLocal()
    try:
        _, _, dates = document_dates(db, user_id, past_days=0)
        (d,) = dates
        assert d["date"] == (base - timedelta(days=30)).isoformat() and d["notice"]["base"] == base.isoformat()
        ics = dates_calendar(date.today(), dates, "20260101T000000Z")
        assert "SUMMARY:Last day to give notice: lease.pdf" in ics
        assert f"DTSTART;VALUE=DATE:{(base - timedelta(days=30)):%Y%m%d}" in ics and f"DTSTART;VALUE=DATE:{base:%Y%m%d}" not in ics
    finally:
        db.close()


def test_a_plain_deadline_is_still_a_deadline():
    # "30 days before" without a notice word is not a notice period; a date after "cancel" without a period stays as it was
    assert F("Date: 3 November 2026\nPlease cancel by 31 March 2027.") == [("2027-03-31", "deadline", None, None)]
    assert F("Datum: 03.11.2026\nSie können bis zum 31.03.2027 kündigen.") == [("2027-03-31", "deadline", None, None)]


# ---- the start of a contract is no deadline -------------------------------------------------------------------------------

@pytest.mark.parametrize("text", [
    "Date: 3 November 2026\nThe contract starts on 1 April 2026.",
    "Date: 3 November 2026\nThis tenancy agreement commences on 1 April 2026 and runs for two years.",
    "Datum: 03.11.2026\nVertragsbeginn: 01.04.2026",
    "Datum: 03.11.2026\nDer Vertrag beginnt am 01.04.2026. Der Beitrag beträgt 59,00 EUR.",
    "Paris, le 3 novembre 2026\nLe contrat commence le 1er avril 2026.",
    "Madrid, 3 de noviembre de 2026\nFecha de inicio: 01/04/2026",
    "Roma, 3 novembre 2026\nIl contratto inizia il 1 aprile 2026.",
    "Ankara, 3 Kasım 2026\nSözleşme başlangıç tarihi: 01.04.2026",
])
def test_the_start_of_a_contract_is_not_a_deadline(text):
    assert F(text) == [], text


def test_the_end_and_the_notice_stay_when_the_start_is_in_the_same_sentence():
    text = "Datum: 03.11.2026\nDer Vertrag beginnt am 01.04.2026 und kann bis zum 31.03.2027 gekündigt werden."
    assert F(text) == [("2027-03-31", "deadline", None, None)]
