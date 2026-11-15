"""Letters of other countries: English (US and UK), German (also Swiss), French, Spanish, Italian and Turkish.

The same facts as for German letters have to come out by rules alone, each with its page and the line it was read
from: the kind of letter, sender, date, reference numbers, amounts with their currency, bank accounts and the
deadlines. The fixtures are in tests/fixtures/letters/.
"""
import os

import pytest

from app.services.dates_service import (
    date_order, find_dates, letter_date, parse_number, replaced_letters,
)
from app.services.facts_service import document_facts

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures", "letters")

# file -> (kind, sender, letter date, references, amounts [(shown, number, currency, role)], accounts, dates)
EXPECTED = {
    "en_us_invoice.txt": dict(
        type="invoice", sender="Maple Utilities Inc.", date="2026-11-03",
        refs=[("customer_number", "4400-118-27"), ("invoice_number", "INV-2026-4471")],
        amounts=[("1,234.56 USD", "1234.56", "USD", None), ("25.00 USD", "25.00", "USD", "fee")],
        accounts=[("us_routing", "021000021"), ("us_account", "123456789")],
        dates=[("2026-12-15", "deadline", "1,234.56 USD", None)]),
    "en_gb_reminder.txt": dict(
        type="reminder", sender="Riverside Energy Ltd", date="2026-11-03",
        refs=[("reference", "RE-7788-21")],
        amounts=[("1,308.45 GBP", "1308.45", "GBP", None), ("12.00 GBP", "12.00", "GBP", "fee")],
        accounts=[("uk_sort_code", "20-00-00"), ("uk_account", "55779911")],
        dates=[("2026-11-17", "deadline", "1,308.45 GBP", None), ("2026-11-24", "appointment", None, "10:30")]),
    "de_ch_rechnung.txt": dict(
        type="invoice", sender="Stadtwerke Limmattal AG", date="2026-11-03",
        refs=[("customer_number", "4400-118-27"), ("invoice_number", "RE-2026-4471")],
        amounts=[("1'234.50 CHF", "1234.50", "CHF", None), ("20.00 CHF", "20.00", "CHF", "fee")],
        accounts=[("iban", "CH93 0076 2011 6238 5295 7")],
        dates=[("2026-12-15", "deadline", "1'234.50 CHF", None)]),
    "fr_facture.txt": dict(
        type="invoice", sender="Énergie Rivière SA", date="2026-11-03",
        refs=[("customer_number", "4400-118-27"), ("invoice_number", "FA-2026-4471")],
        amounts=[("1 234,56 EUR", "1234.56", "EUR", None), ("10,00 EUR", "10.00", "EUR", "fee")],
        accounts=[("iban", "FR76 3000 6000 0112 3456 7890 189"), ("bic", "AGRIFRPP")],
        dates=[("2026-12-15", "deadline", "1 234,56 EUR", None), ("2026-11-24", "appointment", None, "14:30")]),
    "es_factura.txt": dict(
        type="invoice", sender="Energía del Río S.A.", date="2026-11-03",
        refs=[("customer_number", "4400-118-27"), ("invoice_number", "FA-2026-4471")],
        amounts=[("1.234,56 EUR", "1234.56", "EUR", None), ("10,00 EUR", "10.00", "EUR", "fee")],
        accounts=[("iban", "ES91 2100 0418 4502 0005 1332")],
        dates=[("2026-12-15", "deadline", "1.234,56 EUR", None), ("2026-11-24", "appointment", None, "10:30")]),
    "it_fattura.txt": dict(
        type="invoice", sender="Energia del Fiume S.p.A.", date="2026-11-03",
        refs=[("customer_number", "4400-118-27"), ("invoice_number", "FA-2026-4471")],
        amounts=[("1.234,56 EUR", "1234.56", "EUR", None), ("10,00 EUR", "10.00", "EUR", "fee")],
        accounts=[("iban", "IT60 X054 2811 1010 0000 0123 456")],
        dates=[("2026-12-15", "deadline", "1.234,56 EUR", None), ("2026-11-24", "appointment", None, "09:00")]),
    "tr_fatura.txt": dict(
        type="invoice", sender="Nehir Enerji A.Ş.", date="2026-11-03",
        refs=[("customer_number", "4400118"), ("invoice_number", "FT-2026-4471")],
        amounts=[("1.234,56 TRY", "1234.56", "TRY", None), ("10,00 TRY", "10.00", "TRY", "fee")],
        accounts=[("iban", "TR33 0006 1005 1978 6457 8413 26")],
        dates=[("2026-12-15", "deadline", "1.234,56 TRY", None), ("2026-11-24", "appointment", None, "10:30")]),
}


def _facts(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as f:
        text = f.read()
    return text, document_facts({1: text})


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_a_letter_gives_the_same_facts_in_every_language(name):
    want = EXPECTED[name]
    text, facts = _facts(name)
    assert facts["letter"] is True
    assert facts["type"]["value"] == want["type"]
    assert facts["sender"]["value"] == want["sender"]
    assert facts["date"]["value"] == want["date"]
    assert [(r["kind"], r["value"]) for r in facts["references"]] == want["refs"]
    assert [(a["value"], a["number"], a["currency"], a["role"]) for a in facts["amounts"]] == want["amounts"]
    assert [(a["kind"], a["value"]) for a in facts["accounts"]] == want["accounts"]
    assert [(d["value"], d["kind"], d["amount"], d["time"]) for d in facts["dates"]] == want["dates"]
    assert facts["warnings"] == []


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_every_fact_carries_its_page_and_a_line_of_the_document(name):
    text, facts = _facts(name)
    flat = " ".join(text.split())
    seen = [facts["type"], facts["sender"], facts["date"], *facts["references"], *facts["amounts"], *facts["accounts"],
            *facts["dates"]]
    for fact in seen:
        assert fact["page"] == 1
        # the line (or sentence) shown for a value is text of the document, and the value is in it
        assert " ".join(fact["text"].replace("…", "").split()).strip() in flat, fact
    for a in facts["amounts"]:
        assert a["number"].replace(".", "")[:2] in fact_digits(a["text"]), a
    for a in facts["accounts"]:
        assert a["value"].replace(" ", "").replace("-", "") in flat.replace(" ", "").replace("-", "")


def fact_digits(line):
    return "".join(c for c in line if c.isdigit())


def test_the_case_of_a_foreign_letter_is_its_sender():
    _, a = _facts("fr_facture.txt")
    _, b = _facts("fr_facture.txt")
    assert a["case"] == b["case"] == "énergie rivière"


# ---- amounts: number and currency formats

@pytest.mark.parametrize("written,number", [
    ("1.234,56", "1234.56"), ("1,234.56", "1234.56"), ("1 234,56", "1234.56"), ("1 234,56", "1234.56"),
    ("1 234,56", "1234.56"), ("1'234.50", "1234.50"), ("1’234.50", "1234.50"), ("412,00", "412.00"),
    ("412.00", "412.00"), ("412,-", "412.00"), ("500", "500.00"), ("1.234", "1234.00"), ("1,234", "1234.00"),
    ("12.345.678,90", "12345678.90"), ("0,50", "0.50"), ("0.5", "0.50"),
])
def test_numbers_are_read_in_every_format(written, number):
    assert parse_number(written) == number


@pytest.mark.parametrize("text,shown,code", [
    ("Total: €1,234.56", "1,234.56 EUR", "EUR"), ("Total: 1.234,56 €", "1.234,56 EUR", "EUR"),
    ("Total: EUR 99.00", "99.00 EUR", "EUR"), ("Total: 99,00 Euro", "99,00 EUR", "EUR"),
    ("Total: $1,234.56", "1,234.56 USD", "USD"), ("Total: US$ 50", "50 USD", "USD"), ("Total: 1,000 USD", "1,000 USD", "USD"),
    ("Total: £1,308.45", "1,308.45 GBP", "GBP"), ("Total: 45 GBP", "45 GBP", "GBP"),
    ("Total: CHF 1'234.50", "1'234.50 CHF", "CHF"), ("Total: Fr. 120.50", "120.50 CHF", "CHF"),
    ("Total: 1.234,56 TL", "1.234,56 TRY", "TRY"), ("Total: ₺1.234,56", "1.234,56 TRY", "TRY"),
    ("Total: 250 zł", "250 PLN", "PLN"), ("Total: ₹1,250.00", "1,250.00 INR", "INR"),
    ("Total: 412,- €", "412,- EUR", "EUR"),
])
def test_amounts_in_every_currency_are_found(text, shown, code):
    facts = document_facts({1: f"Muster AG\nRechnung\n{text}\n"})
    assert [(a["value"], a["currency"]) for a in facts["amounts"]] == [(shown, code)]


def test_a_year_or_a_phone_number_is_not_an_amount():
    facts = document_facts({1: "Muster AG\nRechnung 2026\nTel. 0151 1234567\nIBAN DE41 6005 0000 0001 2345 67\n"})
    assert facts["amounts"] == []


# ---- dates: formats and words

D = lambda text, ref=None: [(f.date, f.kind) for f in find_dates(text, ref)]


@pytest.mark.parametrize("text,when", [
    ("Datum: 02.11.2026\nBitte zahlen Sie bis zum 15.12.2026.", "2026-12-15"),
    ("Datum: 02.11.2026\nBitte zahlen Sie bis spätestens 15. Dezember 2026.", "2026-12-15"),
    ("Date: 15/11/2026\nPlease pay by 15/12/2026.", "2026-12-15"),
    ("Date: November 2, 2026\nPlease pay by December 15, 2026.", "2026-12-15"),
    ("Date: 2 November 2026\nPayment is due on 15th December 2026.", "2026-12-15"),
    ("Date: 2026-11-02\nPay no later than 2026-12-15.", "2026-12-15"),
    ("Date: 02.11.2026\nPay before 15-12-2026.", "2026-12-15"),
    ("Paris, le 2 novembre 2026\nÀ payer avant le 15 décembre 2026.", "2026-12-15"),
    ("Paris, le 2 novembre 2026\nLe paiement doit nous parvenir au plus tard le 15/12/2026.", "2026-12-15"),
    ("Paris, le 2 novembre 2026\nPayable jusqu'au 1er décembre 2026.", "2026-12-01"),
    ("Madrid, 2 de noviembre de 2026\nEl pago vence el 15 de diciembre de 2026.", "2026-12-15"),
    ("Madrid, 2 de noviembre de 2026\nDebe pagar hasta el 15/12/2026.", "2026-12-15"),
    ("Roma, 2 novembre 2026\nPagamento da effettuare entro il 15 dicembre 2026.", "2026-12-15"),
    ("Roma, 2 novembre 2026\nLa scadenza è fissata al 15/12/2026.", "2026-12-15"),
    ("Ankara, 2 Kasım 2026\nSon ödeme tarihi 15 Aralık 2026.", "2026-12-15"),
    ("Ankara, 2 Kasım 2026\nÖdemenizi 15.12.2026 tarihine kadar yapınız.", "2026-12-15"),
    ("Ankara, 2 KASIM 2026\nSon ödeme tarihi: 15 ARALIK 2026", "2026-12-15"),
])
def test_deadlines_in_every_language_and_date_format(text, when):
    assert D(text) == [(when, "deadline")]


def test_a_date_without_year_takes_the_year_of_the_letter():
    assert D("Datum: 03.11.2026\nBitte zahlen Sie bis zum 15. Dezember.") == [("2026-12-15", "deadline")]
    assert D("Paris, le 3 novembre 2026\nÀ payer avant le 15 décembre.") == [("2026-12-15", "deadline")]
    assert D("Madrid, 3 de noviembre de 2026\nPague antes del 15 de diciembre.") == [("2026-12-15", "deadline")]
    assert D("Roma, 3 novembre 2026\nPagare entro il 15 dicembre.") == [("2026-12-15", "deadline")]
    assert D("Ankara, 3 Kasım 2026\n15 Aralık tarihine kadar ödeyiniz.") == [("2026-12-15", "deadline")]
    assert D("Datum: 20.12.2026\nBitte zahlen Sie bis zum 5. Januar.") == [("2027-01-05", "deadline")]


def test_accents_lost_in_a_scan_do_not_matter():
    assert D("Paris, le 2 novembre 2026\nA payer avant le 15 decembre 2026.") == [("2026-12-15", "deadline")]
    assert D("Roma, 2 novembre 2026\nPagare entro il 15 dicembre 2026.") == [("2026-12-15", "deadline")]


def test_a_slash_date_is_day_first_or_month_first_as_the_letter_shows():
    # 12/15/2026 can only be month first, 15/12/2026 only day first; 03/04/2026 follows the rest of the letter
    assert date_order("Due 12/15/2026, issued 11/03/2026") == "mdy"
    assert date_order("Due 15/12/2026, issued 03/11/2026") == "dmy"
    assert date_order("Please pay $50 by 03/04/2026 to the account of your provider and") == "mdy"
    assert date_order("Bitte zahlen Sie bis 03/04/2026") == "dmy"
    assert D("Date: 11/03/2026\nPlease pay by 12/15/2026.") == [("2026-12-15", "deadline")]
    assert letter_date("Date: 11/03/2026\nPlease pay by 12/15/2026.") == "2026-11-03"
    assert letter_date("Date: 03/11/2026\nPlease pay by 15/12/2026.") == "2026-11-03"


def test_due_date_is_a_deadline_but_the_letter_date_is_not():
    assert D("Invoice date: 03.11.2026\nDue date: 15.12.2026\nTotal 12.00 EUR") == [("2026-12-15", "deadline")]
    assert D("Fecha: 03/11/2026\nFecha de vencimiento: 15/12/2026\nImporte 12,00 €") == [("2026-12-15", "deadline")]
    assert D("Date: 03/11/2026\nDate d'échéance : 15/12/2026\nMontant 12,00 €") == [("2026-12-15", "deadline")]
    assert D("Data: 03/11/2026\nData di scadenza: 15/12/2026\nImporto 12,00 €") == [("2026-12-15", "deadline")]
    assert D("Tarih: 03.11.2026\nSon ödeme tarihi: 15.12.2026\nTutar 12,00 TL") == [("2026-12-15", "deadline")]


def test_a_period_is_not_a_deadline_in_any_language():
    assert D("Datum: 03.11.2026\nAbrechnungszeitraum 01.01.2026 bis 31.12.2026, zahlbar bis 15.12.2026") == [("2026-12-15", "deadline")]
    assert D("Paris, le 3 novembre 2026\nPériode du 01/01/2026 au 31/12/2026, à payer avant le 15/12/2026") == [("2026-12-15", "deadline")]
    assert D("Date: 3 November 2026\nBilling period 1 January 2026 to 31 December 2026, pay by 15 December 2026") == [("2026-12-15", "deadline")]


def test_appointments_and_changes_in_every_language():
    assert D("Date: 3 November 2026\nYour appointment is on 24 November 2026 at 3:30 pm.") == [("2026-11-24", "appointment")]
    assert [f.time for f in find_dates("Date: 3 November 2026\nYour appointment is on 24 November 2026 at 3:30 pm.")] == ["15:30"]
    assert [f.time for f in find_dates("Paris, le 3 novembre 2026\nVotre rendez-vous est le 24/11/2026 à 9h.")] == ["09:00"]
    assert D("Madrid, 3 de noviembre de 2026\nSu cita es el 24 de noviembre de 2026 a las 10:30.") == [("2026-11-24", "appointment")]
    assert D("Roma, 3 novembre 2026\nIl suo appuntamento è il 24 novembre 2026 alle 10:30.") == [("2026-11-24", "appointment")]
    assert D("Ankara, 3 Kasım 2026\nRandevunuz 24 Kasım 2026 saat 10:30'dur.") == [("2026-11-24", "appointment")]
    assert D("Paris, le 3 novembre 2026\nÀ partir du 1er février 2027, votre cotisation est de 6,90 €.") == [("2027-02-01", "change")]
    assert D("Madrid, 3 de noviembre de 2026\nA partir del 1 de febrero de 2027 su cuota será de 6,90 €.") == [("2027-02-01", "change")]
    assert D("Roma, 3 novembre 2026\nA partire dal 1 febbraio 2027 il premio sarà di 6,90 €.") == [("2027-02-01", "change")]
    assert D("Ankara, 3 Kasım 2026\n1 Şubat 2027 tarihinden itibaren primi 6,90 TL olacaktır.") == [("2027-02-01", "change")]
    assert D("Date: 3 November 2026\nEffective 1 February 2027 your premium is $6.90.") == [("2027-02-01", "change")]


def test_fees_and_old_amounts_are_not_what_is_due_in_every_language():
    cases = [
        ("Paris, le 3 novembre 2026\nDes frais de retard de 10,00 € s'appliquent. Veuillez régler 98,50 € avant le 15/12/2026.", "98,50 EUR"),
        ("Madrid, 3 de noviembre de 2026\nRecargo de 10,00 €. Debe abonar 98,50 € antes del 15/12/2026.", "98,50 EUR"),
        ("Roma, 3 novembre 2026\nSpese di mora di 10,00 €. Pagare 98,50 € entro il 15/12/2026.", "98,50 EUR"),
        ("Ankara, 3 Kasım 2026\nGecikme faizi 10,00 TL. 98,50 TL tutarı 15.12.2026 tarihine kadar ödeyiniz.", "98,50 TRY"),
        ("Date: 3 November 2026\nA late fee of £10.00 applies. Please pay £98.50 by 15 December 2026.", "98.50 GBP"),
    ]
    for text, amount in cases:
        found = find_dates(text)
        assert [(f.kind, f.amount) for f in found] == [("deadline", amount)], text
    old = document_facts({1: "Muster SA\nFacture\nVotre cotisation est de 6,90 € au lieu de 4,90 €.\n"})
    assert [(a["value"], a["role"]) for a in old["amounts"]] == [("6,90 EUR", None), ("4,90 EUR", "old")]


def test_a_corrected_letter_names_the_one_it_replaces_in_every_language():
    assert replaced_letters("Cette facture remplace la facture du 20/10/2026.") == ["2026-10-20"]
    assert replaced_letters("Esta factura sustituye a la factura del 20/10/2026.") == ["2026-10-20"]
    assert replaced_letters("Questa fattura sostituisce la fattura del 20/10/2026.") == ["2026-10-20"]
    assert replaced_letters("This invoice replaces our letter of 20 October 2026.") == ["2026-10-20"]
    assert replaced_letters("Diese Abrechnung ersetzt die Abrechnung vom 20.10.2026.") == ["2026-10-20"]


# ---- kinds of letters in the heading

@pytest.mark.parametrize("heading,kind", [
    ("Mahnung", "reminder"), ("Payment reminder", "reminder"), ("Relance de paiement", "reminder"),
    ("Mise en demeure", "reminder"), ("Recordatorio de pago", "reminder"), ("Sollecito di pagamento", "reminder"),
    ("Ödeme hatırlatması", "reminder"),
    ("Steuerbescheid 2025", "tax_notice"), ("Avis d'imposition 2026", "tax_notice"), ("Cartella esattoriale", "tax_notice"),
    ("Vergi tebligatı", "tax_notice"),
    ("Kündigungsbestätigung", "termination"), ("Confirmation de résiliation", "termination"),
    ("Confirmación de baja", "termination"), ("Conferma di disdetta", "termination"), ("Abonelik iptali", "termination"),
    ("Bulletin de paie", "payslip"), ("Nómina de octubre", "payslip"), ("Busta paga", "payslip"), ("Maaş bordrosu", "payslip"),
    ("Avis de contravention", "fine"), ("Multa de tráfico", "fine"), ("Verbale di contestazione", "fine"),
    ("Trafik cezası", "fine"),
    ("Contrat de location", "contract"), ("Contrato de alquiler", "contract"), ("Contratto di locazione", "contract"),
    ("Kira sözleşmesi", "contract"),
    ("Convocation à un entretien", "invitation"), ("Citación judicial", "invitation"), ("Convocazione", "invitation"),
    ("Randevu bildirimi", "invitation"),
    ("Modification tarifaire", "price_change"), ("Cambio de precio", "price_change"), ("Variazione tariffaria", "price_change"),
    ("Tarife değişikliği", "price_change"), ("Price increase notice", "price_change"),
    ("Avis de prélèvement", "payment_notice"), ("Aviso de cargo", "payment_notice"), ("Preavviso di addebito", "payment_notice"),
])
def test_the_kind_of_a_letter_is_read_from_its_heading_in_every_language(heading, kind):
    facts = document_facts({1: f"Muster Gruppe\n{heading}\nAnna Beispiel\n"})
    assert facts["type"]["value"] == kind, heading


@pytest.mark.parametrize("line,kind,value", [
    ("Numéro de client : 4400-118-27", "customer_number", "4400-118-27"),
    ("N° de facture : FA-2026-4471", "invoice_number", "FA-2026-4471"),
    ("Votre référence : DOS-77/26", "reference", "DOS-77/26"),
    ("Número de póliza: AB-1234-56", "policy_number", "AB-1234-56"),
    ("Número de expediente: 2026/00417", "file_number", "2026/00417"),
    ("Numero polizza: 99887766", "policy_number", "99887766"),
    ("Numero pratica: 2026-0417", "file_number", "2026-0417"),
    ("Codice fiscale: RSSMRA80A01H501U", "tax_number", "RSSMRA80A01H501U"),
    ("Poliçe numarası: 1234567", "policy_number", "1234567"),
    ("Dosya numarası: 2026/417", "file_number", "2026/417"),
    ("Case number: 3-22-CV-0417", "file_number", "3-22-CV-0417"),
    ("Policy number: AB-1234", "policy_number", "AB-1234"),
])
def test_reference_numbers_in_every_language(line, kind, value):
    facts = document_facts({1: f"Muster Gruppe\nBrief an Kunden\n{line}\n"})
    assert (kind, value) in [(r["kind"], r["value"]) for r in facts["references"]], line


def test_a_word_that_only_starts_like_a_label_is_not_a_reference():
    facts = document_facts({1: "Muster Gruppe\nRechnung\nrefund 12 requested\n"})
    assert facts["references"] == []


# ---- the same letter as a photo and as a PDF

def test_a_photo_without_accents_has_the_fingerprint_of_the_pdf():
    text, facts = _facts("fr_facture.txt")
    plain = text.translate(str.maketrans("éÉèàç", "eEeac"))
    assert plain != text
    assert document_facts({1: plain})["fingerprint"] == facts["fingerprint"] is not None


def test_other_languages_photo_descriptions_are_not_senders():
    for line in ("L'image montre une photographie de la mer", "La imagen muestra una fotografía del mar",
                 "L'immagine mostra una fotografia del mare", "Bu resim denizin bir fotoğrafını gösteriyor",
                 "Feuille : Inventaire", "Hoja: Inventario", "Foglio: Inventario", "Sayfa: Envanter"):
        assert document_facts({1: f"{line}\nweitere Zeile ohne Brief\n"})["sender"] is None, line
