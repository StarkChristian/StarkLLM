"""Six-language test of 2.3.0 (N50/N51): "What do I have to pay by the end of the year?" over five letters got four
passages; in Spanish and French a real bill was missing and the scam letter took its place, in Italian a deadline twelve
days ahead was called expired. Such a question now gets every letter with its amount, date, status counted by the
engine and scam flag, in front of the passages, and those letters become sources of the answer.

20 Nov 2026: answers in it/fr copied "(today + 12 days)" and ISO dates, tr/fr answers wrote "scam", and a day count was
one day off just after midnight. Dates are now written in the answer language's format, the status is data
(days_left=12), the fraud is named in the answer language, and the PC's local date is used for every count."""
import uuid
from datetime import date, timedelta

import app.main  # noqa: F401  (creates the tables)
from app.api.auth import get_password_hash
from app.api.chat import _dates_section, _letter_evidence, answer_language_code, local_today
from app.db import models
from app.db.session import SessionLocal
from app.services.payments_overview import (
    format_date, is_payment_question, letter_rows, named_letters, overview_block, relative_time, status_data,
)
from app.services.rag_service import rag_service

# ---------------------------------------------------------------- intent

PAY_QUESTIONS = {
    "en": ["What do I have to pay by the end of the year?", "What is due this week?", "Which bills to pay this month?",
           "How much do I have to pay in December?", "Do I have any upcoming payments?", "Show my deadlines"],
    "de": ["Was muss ich bis Jahresende bezahlen?", "Welche Fristen habe ich in den nächsten zwei Wochen?",
           "Was ist noch offen?", "Wie viel muss ich im Dezember zahlen?", "Welche Termine stehen an?"],
    "es": ["¿Qué tengo que pagar antes de fin de año?", "¿Qué plazos tengo en diciembre?", "¿Cuánto tengo que pagar este mes?",
           "¿Tengo pagos pendientes?"],
    "fr": ["Que dois-je payer d'ici la fin de l'année ?", "Quelles sont mes échéances en décembre ?",
           "Combien dois-je payer ce mois-ci ?", "Qu'est-ce que je dois payer ?"],
    "it": ["Cosa devo pagare entro fine anno?", "Quali scadenze ho a dicembre?", "Quanto devo pagare questo mese?",
           "Ho bollette da pagare?"],
    "tr": ["Yıl sonuna kadar ne ödemem gerekiyor?", "Bu ay hangi ödemeler var?", "Ödenecek faturalarım neler?",
           "Son ödeme tarihleri ne zaman?"],
}
OTHER_QUESTIONS = {
    "en": ["Is the parcel letter genuine?", "Until when can I cancel the car insurance?", "Summarize the electricity bill",
           "Can I pay with PayPal?", "Hello, who are you?"],
    "de": ["Ist der Paketbrief echt?", "Bis wann kann ich die Kfz-Versicherung kündigen?", "Fasse die Stromrechnung zusammen",
           "Darf ich eine Katze halten?"],
    "es": ["¿Es auténtica la carta del paquete?", "¿Hasta cuándo puedo cancelar el seguro del coche?", "Resume la factura de la luz"],
    "fr": ["La lettre du colis est-elle authentique ?", "Jusqu'à quand puis-je résilier l'assurance auto ?",
           "Résume la facture d'électricité"],
    "it": ["La lettera del pacco è autentica?", "Entro quando posso disdire l'assicurazione auto?", "Riassumi la bolletta della luce"],
    "tr": ["Kargo mektubu gerçek mi?", "Kasko sigortasını en geç ne zaman iptal edebilirim?", "Elektrik faturasını özetle"],
}


def test_questions_about_what_to_pay_are_recognised_in_six_languages():
    for lang, questions in PAY_QUESTIONS.items():
        for q in questions:
            assert is_payment_question(q), (lang, q)


def test_other_questions_about_letters_are_not_payment_questions():
    for lang, questions in OTHER_QUESTIONS.items():
        for q in questions:
            assert not is_payment_question(q), (lang, q)


LETTERS = [{"filename": "Stadtwerke-Rechnung.pdf", "sender": "Stadtwerke Musterstadt"},
           {"filename": "Car-insurance.pdf", "sender": "Harbour Mutual"},
           {"filename": "IBI-Ayuntamiento.pdf", "sender": "Ayuntamiento de Villanueva del Río"},
           {"filename": "Taxe-fonciere.pdf", "sender": "Commune de Valmont-sur-Lys"},
           {"filename": "Tasa-aduana-paquete.pdf", "sender": "Aduanas Paquetería"}]


def test_question_words_never_name_a_letter():
    # "antes" and "payer" stood in letters and narrowed the dates list to them (N50)
    for questions in PAY_QUESTIONS.values():
        for q in questions:
            assert named_letters(q, LETTERS) == [], q


def test_a_sender_or_file_word_names_its_letter():
    assert named_letters("Was muss ich an die Stadtwerke zahlen?", LETTERS) == ["Stadtwerke-Rechnung.pdf"]
    assert named_letters("What do I have to pay for the car insurance?", LETTERS) == ["Car-insurance.pdf"]
    assert named_letters("¿Cuánto tengo que pagar al Ayuntamiento?", LETTERS) == ["IBI-Ayuntamiento.pdf"]


# ---------------------------------------------------------------- the list of all letters

TODAY = date(2026, 11, 19)


def _row(filename, sender, kind, dates, scam=False, asked=None):
    return {"filename": filename, "sender": sender, "kind": kind, "scam": scam, "asked_amount": asked, "page": 1,
            "scope": "ws", "document_id": 1, "dates": dates}


ROWS = [
    _row("TARI-Comune.pdf", "Comune di Borgonuovo", "tax_notice",
         [{"date": "2026-12-01", "kind": "deadline", "amount": "142,00 EUR", "text": "2ª rata, scadenza 1° dicembre 2026", "page": 1}]),
    _row("Vecchia.pdf", "Comune", None, [{"date": "2026-11-16", "kind": "payment", "amount": "10,00 EUR", "text": "pagare entro il 16/11/2026"}]),
    _row("Oggi.pdf", "Comune", None, [{"date": "2026-11-19", "kind": "deadline", "text": "entro oggi"}]),
    _row("Polizza.pdf", "Assicurazioni", "contract", [{"date": "2026-12-31", "kind": "deadline", "text": "disdetta",
                                                      "notice": {"count": 3, "unit": "months", "base": "2027-03-31"}}]),
    _row("Dogana-pacco.pdf", "Dogana Pacchi Express", "reminder", [], scam=True, asked="2,99 EUR"),
]


def test_every_item_has_its_status_counted_by_the_engine():
    block = overview_block(TODAY, ROWS, "it")
    # N51: 1 Dec 2026 seen on 19 Nov 2026 is ahead, not "già scaduta"
    assert ("file=TARI-Comune.pdf | sender=Comune di Borgonuovo | type=tax_notice | item=deadline | amount=142,00 EUR | "
            "date=01/12/2026 | days_left=12 | quote=") in block
    assert "date=16/11/2026 | overdue_days=3" in block
    assert "date=19/11/2026 | due_today=yes" in block
    assert "item=notice_deadline | notice_period=3 months | contract_end=31/03/2027" in block
    assert ("file=Dogana-pacco.pdf | sender=Dogana Pacchi Express | type=reminder | LIKELY FRAUD, DO NOT PAY | "
            "asks_for=2,99 EUR") in block
    assert ("current_date=19/11/2026 | month_end=30/11/2026 (days_left=11) | year_end=31/12/2026 (days_left=42)"
            in block)
    assert "never compare dates or count days yourself" in block and "is never a payment" in block
    assert "PASSED" not in block


def test_the_block_has_no_iso_dates_and_no_english_status_words_to_copy():
    # it/fr answers copied "(today + 12 days)" and 2026-12-01 (20 Nov 2026)
    import re
    for lang in ("it", "fr", "es", "de", "tr"):
        block = overview_block(TODAY, ROWS, lang)
        data = block.split("\nThis question is about all letters")[0]
        assert not re.search(r"\d{4}-\d{2}-\d{2}", data), lang
        for words in ("in 12 days", "still ahead", "overdue by", "(Tue)", "today,", "scam"):
            assert words not in data, (lang, words)
        rule = block.split("\nThis question is about all letters")[1]
        assert "Never copy field names" in rule and "ISO dates" in rule and "the way the user writes dates" in rule


def test_dates_in_the_format_of_the_answer_language():
    d = date(2026, 12, 1)
    assert format_date(d, "de") == "01.12.2026" and format_date(d, "tr") == "01.12.2026"
    assert format_date(d, "es") == format_date(d, "fr") == format_date(d, "it") == "01/12/2026"
    assert format_date(d, "en") == "1 December 2026" and format_date(d, None) == "1 December 2026"
    assert "date=01.12.2026 | days_left=12" in overview_block(TODAY, ROWS, "de")
    assert "date=1 December 2026 | days_left=12" in overview_block(TODAY, ROWS, "en")


def test_the_fraud_is_named_in_the_answer_language():
    # tr/fr answers wrote the English word "scam"
    assert 'call it "muhtemelen dolandırıcılık"' in overview_block(TODAY, ROWS, "tr")
    assert 'call it "fraude probable"' in overview_block(TODAY, ROWS, "fr")
    assert 'call it "probabile truffa"' in overview_block(TODAY, ROWS, "it")
    for lang in ("tr", "fr", "en"):
        assert 'never write the English word "scam"' in overview_block(TODAY, ROWS, lang)


def test_status_words():
    assert status_data(date(2026, 12, 1), TODAY) == "days_left=12"
    assert status_data(date(2026, 11, 20), TODAY) == "days_left=1"
    assert status_data(date(2026, 11, 19), TODAY) == "due_today=yes"
    assert status_data(date(2026, 11, 16), TODAY) == "overdue_days=3"
    assert relative_time(date(2026, 11, 18), TODAY) == "overdue by 1 days"


def test_the_pcs_local_date_is_used_after_midnight():
    # the engine's date and the PC's may differ by a day around midnight: the PC's date counts
    engine = date.today()
    assert local_today((engine + timedelta(days=1)).isoformat()) == engine + timedelta(days=1)
    assert local_today((engine - timedelta(days=1)).isoformat()) == engine - timedelta(days=1)
    # a missing, broken or far-off date falls back to the engine's date
    assert local_today(None) == engine and local_today("not a date") == engine
    assert local_today((engine + timedelta(days=40)).isoformat()) == engine


def test_the_answer_language_is_the_message_language_else_the_interface_language():
    assert answer_language_code("Quando devo pagare la fattura e quanto?", "de") == "it"
    assert answer_language_code("Quand dois-je payer la facture ?", None) == "fr"
    assert answer_language_code("ok", "tr") == "tr"
    assert answer_language_code("ok", None) is None


def test_rows_leave_out_replaced_copies_and_non_letters_and_put_scams_last():
    items = [{"scope": "ws", "id": 1, "filename": "Scam.pdf", "is_letter": True, "suspicious": True, "sender": "X"},
             {"scope": "ws", "id": 2, "filename": "Bill.pdf", "is_letter": True, "sender": "Energy"},
             {"scope": "ws", "id": 3, "filename": "Old.pdf", "is_letter": True, "replaced": True},
             {"scope": "ws", "id": 4, "filename": "Copy.pdf", "is_letter": True, "duplicate": True},
             {"scope": "ws", "id": 5, "filename": "notes.md"},
             {"scope": "ws", "id": 6, "filename": "Letter.pdf", "is_letter": True, "sender": "Office"}]
    dates = [{"scope": "ws", "document_id": 2, "date": "2026-12-15", "kind": "deadline", "filename": "Bill.pdf"}]
    rows = letter_rows(items, dates)
    assert [r["filename"] for r in rows] == ["Bill.pdf", "Letter.pdf", "Scam.pdf"]
    assert rows[-1]["scam"] and not rows[0]["scam"]


# ---------------------------------------------------------------- the chat's section from indexed letters

def _when(days):
    return (date.today() + timedelta(days=days)).strftime("%d/%m/%Y")


def _letters():
    ibi = (f"Ayuntamiento de Villanueva del Río\nServicio de Recaudación\nSra. Lucía García\nFecha 15/10/2026\nReferencia IBI-2026-55102\n"
           f"Impuesto sobre Bienes Inmuebles (IBI) 2026 – 2.º plazo\nEstimada Sra. García:\n"
           f"Por favor, pague 142,00 € antes del {_when(12)} indicando la referencia.\nIBAN ES00 0000 0000 0000 0000 0002")
    derrama = (f"Comunidad de Propietarios Calle Mayor 12\nSra. Lucía García\nFecha 28/10/2026\nReferencia CP-2026-0147\n"
               f"Derrama extraordinaria – reparación de la cubierta\nEstimada propietaria:\n"
               f"Le rogamos que ingrese 96,50 € antes del {_when(21)} en la cuenta de la comunidad.\n"
               f"IBAN ES00 0000 0000 0000 0000 0003")
    scam = ("Aduanas Paquetería\nDespacho internacional\nACTÚE EN UN PLAZO DE 48 HORAS\nSra. Lucía García\n"
            "ÚLTIMO AVISO – su paquete está retenido en aduanas\nEstimado cliente:\n"
            "Su paquete no se ha podido entregar porque hay una tasa de aduanas pendiente de 2,99 €.\n"
            "Pague la tasa en un plazo de 48 horas en https://parcel-fee.example/pago?id=LG48291;\n"
            "de lo contrario, el paquete se devolverá al remitente y será destruido.\n"
            "Alternativa: también puede pagar con una tarjeta regalo. Compre una tarjeta regalo de\n"
            "10,00 € y envíe el código a aduanas@parcel-fee.example.\n"
            "O transfiera la tasa a nuestra cuenta asociada en el extranjero.\nIBAN LT00 0000 0000 0000 0000")
    return [("IBI-Ayuntamiento.pdf", ibi), ("Derrama-comunidad.pdf", derrama), ("Tasa-aduana-paquete.pdf", scam)]


def _workspace(tmp_path):
    db = SessionLocal()
    try:
        user = models.User(username=f"pay_{uuid.uuid4().hex[:8]}", hashed_password=get_password_hash("x" * 12))
        db.add(user)
        db.commit()
        ws = models.Workspace(name="Cartas", user_id=user.id)
        db.add(ws)
        db.commit()
        docs = []
        for fname, text in _letters():
            path = tmp_path / fname
            path.write_bytes(b"%PDF")
            doc = models.Document(workspace_id=ws.id, filename=fname, filepath=str(path), file_type="pdf", status="indexed")
            db.add(doc)
            db.commit()
            docs.append((str(path), text))
        ids = (user.id, ws.id)
    finally:
        db.close()
    col = rag_service.get_or_create_collection(ids[1], ids[0])
    for path, text in docs:
        col.add(ids=[uuid.uuid4().hex], documents=[text], metadatas=[{"source": path, "page": 0, "chunk": 0}],
                embeddings=[[1.0, 0.0]])
    return ids


def test_a_payment_question_gets_every_letter_with_status_and_the_scam_flag(tmp_path):
    user_id, ws_id = _workspace(tmp_path)
    db = SessionLocal()
    try:
        block, rows = _dates_section(db, user_id, ws_id, False, "¿Qué tengo que pagar antes de fin de año?", True,
                                     lang="es")
        pc_block, _ = _dates_section(db, user_id, ws_id, False, "¿Qué tengo que pagar antes de fin de año?", True,
                                     date.today() + timedelta(days=1), "es")
        named_block, named_rows = _dates_section(db, user_id, ws_id, False, "¿Cuánto tengo que pagar al Ayuntamiento?", True)
        other_block, other_rows = _dates_section(db, user_id, ws_id, False, "¿Cuándo vence el IBI?", False)
    finally:
        db.close()
        rag_service.chroma_client.delete_collection(f"user_{user_id}_workspace_{ws_id}")
    assert "ALL LETTERS OF THIS WORKSPACE" in block
    assert "file=IBI-Ayuntamiento.pdf | sender=Ayuntamiento de Villanueva del Río" in block and "142,00 EUR" in block
    assert "Derrama-comunidad.pdf" in block and "96,50 EUR" in block
    assert "days_left=12" in block and "days_left=21" in block
    assert "file=Tasa-aduana-paquete.pdf | sender=Aduanas Paquetería" in block and "LIKELY FRAUD, DO NOT PAY" in block
    assert f"date={_when(12)} | days_left=12" in block  # Spanish: dd/mm/yyyy
    # just after midnight the PC is a day ahead of the engine: the counts follow the PC's date
    assert "days_left=11" in pc_block and "days_left=20" in pc_block and "days_left=12" not in pc_block
    assert [r["filename"] for r in rows] == ["IBI-Ayuntamiento.pdf", "Derrama-comunidad.pdf", "Tasa-aduana-paquete.pdf"]
    evidence = _letter_evidence(rows)
    assert [e["label"] for e in evidence] == ["IBI-Ayuntamiento.pdf (Page 1)", "Derrama-comunidad.pdf (Page 1)",
                                              "Tasa-aduana-paquete.pdf (Page 1)"]
    assert all(e["document_id"] and e["passages"] for e in evidence)
    assert "142,00" in evidence[0]["passages"][0]
    # a question that names one letter keeps the short dates list of that letter
    assert named_rows == [] and "IBI-Ayuntamiento.pdf" in named_block and "Derrama-comunidad.pdf" not in named_block
    # any other date question keeps the dates list (no scam letter in it)
    assert other_rows == [] and "DATES IN THE USER'S LETTERS" in other_block and "Tasa-aduana" not in other_block
