"""Facts of a letter found by rules (facts_service, document inbox B3): type, sender, date, reference numbers,
amounts, bank accounts and dates, each with the page and line it stands on."""
from scenarios.letters import SENDERS, generate
from app.services.facts_service import case_key, document_facts

# what each generated letter is (scenarios/letters.py)
KIND_TYPE = {"invoice": "invoice", "invoice_label": "invoice", "reminder": "reminder", "change": "price_change",
             "appointment": "invitation", "cancel_confirm": "termination", "notice": "notice",
             "debit": "payment_notice", "english_invoice": "invoice", "english_appointment": "invitation",
             "no_year": "reminder", "birthday_noise": "insurance"}


def test_300_generated_letters_type_sender_and_customer_number():
    wrong = []
    for letter in generate(300):
        f = document_facts({1: letter["text"]})
        kind = letter["id"].split("-", 1)[1]
        first = letter["text"].splitlines()[0]
        customer = [r["value"] for r in f["references"] if r["kind"] == "customer_number"]
        problems = []
        if not f["type"] or f["type"]["value"] != KIND_TYPE[kind]:
            problems.append(f"type {f['type'] and f['type']['value']}")
        if not f["sender"] or f["sender"]["value"] != first or first not in SENDERS:
            problems.append(f"sender {f['sender'] and f['sender']['value']}")
        if "Kundennummer" in letter["text"] and len(customer) != 1:
            problems.append(f"customer number {customer}")
        if problems:
            wrong.append((letter["id"], problems))
    assert wrong == [], wrong[:5]


def test_every_fact_names_its_page_and_line():
    f = document_facts({1: "Stadtwerke Rheinstadt\nDatum: 06.11.2026\nKundennummer: 4400-118-27\nZahlungserinnerung",
                        2: "Bitte überweisen Sie 96,00 EUR bis zum 20.11.2026 auf IBAN DE89 6705 0505 0000 4400 11."})
    assert f["type"]["value"] == "reminder" and f["type"]["page"] == 1
    assert f["sender"]["value"] == "Stadtwerke Rheinstadt"
    assert f["date"] == {"value": "2026-11-06", "page": 1, "text": "Datum: 06.11.2026"}
    assert f["references"][0]["value"] == "4400-118-27" and f["references"][0]["text"] == "Kundennummer: 4400-118-27"
    assert [(a["value"], a["page"]) for a in f["amounts"]] == [("96,00 EUR", 2)]
    assert f["accounts"][0]["value"] == "DE89 6705 0505 0000 4400 11" and f["accounts"][0]["page"] == 2
    assert [(d["value"], d["kind"], d["amount"], d["page"]) for d in f["dates"]] == [("2026-11-20", "deadline", "96,00 EUR", 2)]
    for fact in [f["type"], f["sender"], f["date"], *f["references"], *f["amounts"], *f["accounts"], *f["dates"]]:
        assert fact["text"], fact  # the line it was read from, so the UI can show and link it


def test_subject_line_beats_letterhead_and_later_words():
    # scenario letter: the insurer's name is on top, "Kündigung: …" comes later; it is an invoice
    f = document_facts({1: "Kurpfalz Direkt Versicherung AG\nAm Hafen 3, 68159 Rheinstadt\nDatum: 02.11.2026\n"
                           "Vertragsnummer: KV-2023-558190\nBeitragsrechnung für das Versicherungsjahr 2027\n"
                           "Ihr Beitrag beträgt 687,12 EUR (bisher 598,40 EUR). Kündigung: …"})
    assert f["type"]["value"] == "invoice"
    assert [(r["kind"], r["value"]) for r in f["references"]] == [("contract_number", "KV-2023-558190")]
    assert [(a["value"], a["role"]) for a in f["amounts"]] == [("687,12 EUR", None), ("598,40 EUR", "old")]


def test_a_contract_title_is_not_its_sender():
    f = document_facts({1: "Wohnraummietvertrag\nzwischen Dieter Brand, vertreten durch die Hausverwaltung Kurpfalz GmbH\n"
                           "und Lena Hoffmann (Mieterin). § 5 Kündigung …"})
    assert f["type"]["value"] == "contract"
    assert f["sender"]["value"] == "Dieter Brand"


def test_a_text_message_screenshot():
    f = document_facts({1: "Nachricht von +44 7700 900123 heute 09:14\nPaketExpress: Ihr Paket konnte nicht zugestellt\n"
                           "werden. Es ist eine Zollgebühr von 1,99 EUR offen. Bitte zahlen Sie innerhalb von 24 Stunden hier:\n"
                           "https://paketexpress-zoll.top/de/z?id=88213"})
    assert f["type"]["value"] == "message"
    assert f["sender"]["value"] == "PaketExpress"
    assert "scam_signs" in f["warnings"]


def test_letters_of_one_sender_are_one_case():
    a = document_facts({1: "Finanzamt Rheinstadt\nDatum: 03.11.2026\nBescheid für 2025 über Einkommensteuer"})
    b = document_facts({1: "Finanzamt Rheinstadt - Vollstreckungsstelle\nDatum: 08.11.2026\nLETZTE MAHNUNG"})
    c = document_facts({1: "Agentur für Arbeit Rheinstadt\nEinladung"})
    assert case_key(a) == case_key(b) == "finanzamt rheinstadt"
    assert a["type"]["value"] == "tax_notice" and b["type"]["value"] == "reminder"
    assert c["case"] == "agentur arbeit"


def test_the_same_letter_as_photo_and_as_pdf_has_one_fingerprint():
    pdf = document_facts({1: "Stadtwerke Rheinstadt\nZahlungserinnerung\nBitte zahlen Sie 96,00 EUR bis zum 20.11.2026."})
    photo = document_facts({1: "Stadtwerke  Rheinstadt\n\nZahlungserinnerung\nBitte zahlen Sie 96,00 EUR bis zum 20.11.2026"})
    assert pdf["fingerprint"] == photo["fingerprint"]
    other = document_facts({1: "Stadtwerke Rheinstadt\nZahlungserinnerung\nBitte zahlen Sie 98,50 EUR bis zum 27.11.2026."})
    assert other["fingerprint"] != pdf["fingerprint"]


def test_empty_document():
    f = document_facts({})
    assert f["type"] is None and f["sender"] is None and f["references"] == [] and f["case"] is None


def test_first_lines_that_are_not_a_sender():
    from app.services.facts_service import _not_a_name
    for line in ["# Project card", "<catalog><product id=\"P-118\">", "Sheet: Inventory", "2026-11-07 02:00:01 INFO backup started",
                 "The image shows a photograph of a meeting room sign.", "Das Bild zeigt einen Brief.",
                 "Office guide The office Wi-Fi network is called Orion-Guest and the reception opens at 8.",
                 "Shift handover note. The night shift supervisor is Karim Nouri.",
                 "Columns: supplier,city,contract_number,annual_volume_eur", '"service": "billing-api",',
                 "The image appears to be a screenshot of a computer screen displaying a web page",
                 "The daily meal allowance for business trips is 42 EUR. Approvals go to Sabine Roth."]:
        assert _not_a_name(line), line
    for line in ["Stadtwerke Rheinstadt", "Finanzamt Rheinstadt - Vollstreckungsstelle", "Kurpfalz Direkt Versicherung AG",
                 "Dr. med. Anna Berger, Fachärztin für Innere Medizin", "Hausverwaltung Müller & Söhne GmbH"]:
        assert not _not_a_name(line), line
