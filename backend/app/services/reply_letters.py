"""Reply letters from the inbox (plan for 2.8, option 10): a cancellation, an objection, a request for more time to
pay, a request to correct an invoice or the revocation of a SEPA direct-debit mandate, drafted from a letter's facts.

What comes from where:
* the recipient (sender of the letter, with its address), the reference numbers, the letter date, the amount and the
  deadlines are the letter's facts (facts_service): fixed rules, every value is text on a page of the letter;
* the user's name and address come from the letter profile in Settings (models.LetterProfile, protected at rest);
* the layout (address blocks, date, subject, salutation, closing) is fixed here per language and country: German
  DIN 5008, French "Objet :", Spanish "Asunto:", Italian "Oggetto:", Turkish "Konu:", English "Re:";
* only the body paragraphs are written by the local model. Every sentence of it is checked: a sentence with a date,
  a time limit or a number that is not in the letter or the profile is removed, so no deadline is ever invented.
  Without a model (or when too little of its text passes the check) a fixed body of the same kind is used.

Deadlines are never made up: the draft view lists the deadlines printed in the letter, each with its sentence and
page. A letter without one gets "Please check the deadline". Nothing is ever sent: there is no mail, fax or post.
A letter with signs of a scam gets no reply letter at all (the caller refuses it).
"""
import re
from datetime import date
from typing import Dict, List, Optional

from app.services import locale_rules

KINDS = ("cancel", "objection", "deferral", "correction", "sepa_revoke")
LANGS = ("de", "en", "fr", "es", "it", "tr")

# ---------------------------------------------------------------------------------------------------------------
# Words of the layout, per language

MONTHS = {
    "en": ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
           "November", "December"],
    "fr": ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre",
           "décembre"],
    "es": ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre",
           "noviembre", "diciembre"],
    "it": ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre",
           "novembre", "dicembre"],
}

LAYOUT = {
    # subject: the word before the subject line ("" in DIN 5008: the subject stands without "Betreff")
    "de": {"subject": "", "salutation": "Sehr geehrte Damen und Herren,", "closing": "Mit freundlichen Grüßen",
           "gap": 2, "recipient_prefix": ""},
    "en": {"subject": "Re: ", "salutation": "Dear Sir or Madam,", "closing": "Yours faithfully,", "gap": 1,
           "recipient_prefix": ""},
    "fr": {"subject": "Objet : ", "salutation": "Madame, Monsieur,",
           "closing": "Je vous prie d'agréer, Madame, Monsieur, l'expression de mes salutations distinguées.", "gap": 1,
           "recipient_prefix": ""},
    "es": {"subject": "Asunto: ", "salutation": "Estimados señores:", "closing": "Atentamente,", "gap": 1,
           "recipient_prefix": ""},
    "it": {"subject": "Oggetto: ", "salutation": "Gentili Signori,", "closing": "Distinti saluti", "gap": 1,
           "recipient_prefix": "Spett.le "},
    "tr": {"subject": "Konu: ", "salutation": "Sayın Yetkili,", "closing": "Saygılarımla,", "gap": 1,
           "recipient_prefix": ""},
}
US_LAYOUT = {**LAYOUT["en"], "salutation": "Dear Sir or Madam:", "closing": "Sincerely,"}

REFERENCE_WORDS = {
    "customer_number": {"de": "Kundennummer", "en": "Customer number", "fr": "Numéro de client",
                        "es": "Número de cliente", "it": "Numero cliente", "tr": "Müşteri numarası"},
    "invoice_number": {"de": "Rechnungsnummer", "en": "Invoice number", "fr": "Numéro de facture",
                       "es": "Número de factura", "it": "Numero fattura", "tr": "Fatura numarası"},
    "contract_number": {"de": "Vertragsnummer", "en": "Contract number", "fr": "Numéro de contrat",
                        "es": "Número de contrato", "it": "Numero contratto", "tr": "Sözleşme numarası"},
    "policy_number": {"de": "Versicherungsnummer", "en": "Policy number", "fr": "Numéro de police",
                      "es": "Número de póliza", "it": "Numero di polizza", "tr": "Poliçe numarası"},
    "tax_number": {"de": "Steuernummer", "en": "Tax number", "fr": "Numéro fiscal", "es": "Número fiscal",
                   "it": "Codice fiscale", "tr": "Vergi numarası"},
    "file_number": {"de": "Aktenzeichen", "en": "File number", "fr": "Numéro de dossier",
                    "es": "Número de expediente", "it": "Numero di pratica", "tr": "Dosya numarası"},
    "member_number": {"de": "Mitgliedsnummer", "en": "Membership number", "fr": "Numéro d'adhérent",
                      "es": "Número de socio", "it": "Numero di socio", "tr": "Üye numarası"},
    "employee_number": {"de": "Personalnummer", "en": "Employee number", "fr": "Matricule",
                        "es": "Número de empleado", "it": "Numero di matricola", "tr": "Sicil numarası"},
    "mandate_reference": {"de": "Mandatsreferenz", "en": "Mandate reference", "fr": "Référence du mandat",
                          "es": "Referencia del mandato", "it": "Riferimento del mandato", "tr": "Talimat referansı"},
    "reference": {"de": "Zeichen", "en": "Reference", "fr": "Référence", "es": "Referencia", "it": "Riferimento",
                  "tr": "Referans"},
}

SUBJECTS = {
    "cancel": {"de": "Kündigung", "en": "Cancellation", "fr": "Résiliation", "es": "Solicitud de baja",
               "it": "Disdetta", "tr": "Fesih bildirimi"},
    "objection": {"de": "Widerspruch", "en": "Objection", "fr": "Contestation", "es": "Reclamación",
                  "it": "Contestazione", "tr": "İtiraz"},
    "deferral": {"de": "Antrag auf Stundung oder Ratenzahlung", "en": "Request for more time to pay",
                 "fr": "Demande de délai de paiement", "es": "Solicitud de aplazamiento de pago",
                 "it": "Richiesta di dilazione di pagamento", "tr": "Ödeme erteleme talebi"},
    "correction": {"de": "Bitte um Berichtigung der Rechnung", "en": "Request to correct the invoice",
                   "fr": "Demande de rectification de facture", "es": "Solicitud de rectificación de factura",
                   "it": "Richiesta di rettifica della fattura", "tr": "Fatura düzeltme talebi"},
    "sepa_revoke": {"de": "Widerruf des SEPA-Lastschriftmandats", "en": "Revocation of the SEPA direct debit mandate",
                    "fr": "Révocation du mandat de prélèvement SEPA",
                    "es": "Revocación de la orden de domiciliación SEPA",
                    "it": "Revoca del mandato di addebito diretto SEPA", "tr": "SEPA otomatik ödeme talimatının iptali"},
}
# German: "Einspruch" against a tax assessment or a fine, "Widerspruch" against anything else
EINSPRUCH_TYPES = ("tax_notice", "fine")
NOTICE_TYPES = ("tax_notice", "fine", "notice")
BILL_TYPES = ("invoice", "reminder", "debt_collection", "statement", "payment_notice", "price_change")

# what the letter is, as the reply names it ("your notice", "Ihre Rechnung"); German in the accusative and dative
NOUNS = {
    "notice": {"de": ("Ihren Bescheid", "Ihrem Bescheid"), "en": "your notice", "fr": "votre avis",
               "es": "su resolución", "it": "il Vostro avviso", "tr": "tebligatınız"},
    "bill": {"de": ("Ihre Rechnung", "Ihrer Rechnung"), "en": "your invoice", "fr": "votre facture",
             "es": "su factura", "it": "la Vostra fattura", "tr": "faturanız"},
    "letter": {"de": ("Ihr Schreiben", "Ihrem Schreiben"), "en": "your letter", "fr": "votre courrier",
               "es": "su escrito", "it": "la Vostra comunicazione", "tr": "yazınız"},
}

# the bracketed parts are for the user to fill in
BODIES = {
    "cancel": {
        "de": "hiermit kündige ich den oben genannten Vertrag fristgerecht zum nächstmöglichen Zeitpunkt.\n\n"
              "Bitte bestätigen Sie mir die Kündigung und das Datum, zu dem der Vertrag endet, schriftlich.",
        "en": "I hereby give notice to cancel the contract referred to above at the earliest possible date.\n\n"
              "Please confirm the cancellation and the date on which the contract ends in writing.",
        "fr": "Par la présente, je vous informe de ma décision de résilier le contrat mentionné en objet à la "
              "première date possible.\n\nJe vous remercie de bien vouloir me confirmer par écrit cette résiliation "
              "ainsi que la date de fin du contrat.",
        "es": "Por medio de la presente les comunico mi decisión de dar de baja el contrato arriba indicado en la "
              "fecha más próxima posible.\n\nLes ruego que me confirmen por escrito la baja y la fecha en que "
              "finaliza el contrato.",
        "it": "con la presente comunico la disdetta del contratto sopra indicato alla prima data utile.\n\n"
              "Vi prego di confermarmi per iscritto la disdetta e la data di cessazione del contratto.",
        "tr": "Yukarıda belirtilen sözleşmemi mümkün olan en erken tarih itibarıyla feshettiğimi bildiririm.\n\n"
              "Fesih işleminin ve sözleşmenin sona erdiği tarihin tarafıma yazılı olarak onaylanmasını rica ederim.",
    },
    "objection": {
        "de": "gegen {noun_acc}{of_date}{amount} lege ich hiermit {objection_word} ein.\n\n"
              "Begründung: [Bitte tragen Sie hier Ihre Gründe ein.]\n\n"
              "Bitte bestätigen Sie mir den Eingang dieses Schreibens.",
        "en": "I hereby object to {noun}{of_date}{amount}.\n\n"
              "My reasons: [Please enter your reasons here.]\n\n"
              "Please confirm that you have received this letter.",
        "fr": "Par la présente, je conteste {noun}{of_date}{amount}.\n\n"
              "Motifs : [Veuillez indiquer ici vos motifs.]\n\n"
              "Je vous remercie de bien vouloir m'accuser réception de ce courrier.",
        "es": "Por medio de la presente presento reclamación contra {noun}{of_date}{amount}.\n\n"
              "Motivos: [Indique aquí sus motivos.]\n\n"
              "Les ruego que me confirmen la recepción de este escrito.",
        "it": "con la presente contesto formalmente {noun}{of_date}{amount}.\n\n"
              "Motivi: [Indichi qui i Suoi motivi.]\n\n"
              "Vi prego di confermarmi il ricevimento della presente.",
        "tr": "{of_date}{amount}{noun_dat} itiraz ediyorum.\n\n"
              "Gerekçe: [Lütfen gerekçelerinizi buraya yazınız.]\n\n"
              "Bu yazının tarafınıza ulaştığını onaylamanızı rica ederim.",
    },
    "deferral": {
        "de": "zu {noun_dat}{of_date}: Den geforderten Betrag{amount} kann ich derzeit nicht in einer Summe zahlen.\n\n"
              "Ich bitte Sie daher um eine Stundung bis zum [Datum] oder um eine Ratenzahlung in monatlichen Raten "
              "von je [Betrag].\n\nGrund: [Bitte tragen Sie hier Ihren Grund ein.]\n\n"
              "Bitte bestätigen Sie mir die Vereinbarung schriftlich.",
        "en": "With reference to {noun}{of_date}: I am currently unable to pay the amount due{amount} in one sum.\n\n"
              "I therefore ask you to allow me to pay by [date], or in monthly instalments of [amount].\n\n"
              "Reason: [Please enter your reason here.]\n\nPlease confirm the arrangement in writing.",
        "fr": "Suite à {noun}{of_date}, je ne suis actuellement pas en mesure de régler en une seule fois la somme "
              "due{amount}.\n\nJe vous demande donc de m'accorder un délai de paiement jusqu'au [date] ou un "
              "échelonnement en mensualités de [montant].\n\nMotif : [Veuillez indiquer ici votre motif.]\n\n"
              "Je vous remercie de bien vouloir me confirmer cet accord par écrit.",
        "es": "En relación con {noun}{of_date}, actualmente no me es posible abonar en un solo pago el importe "
              "adeudado{amount}.\n\nPor ello les solicito un aplazamiento del pago hasta el [fecha] o el pago en "
              "cuotas mensuales de [importe].\n\nMotivo: [Indique aquí su motivo.]\n\n"
              "Les ruego que me confirmen el acuerdo por escrito.",
        "it": "in riferimento {noun_rif}{of_date}, al momento non sono in grado di pagare in un'unica soluzione "
              "l'importo dovuto{amount}.\n\nVi chiedo pertanto una dilazione del pagamento fino al [data] oppure un "
              "pagamento in rate mensili di [importo].\n\nMotivo: [Indichi qui il Suo motivo.]\n\n"
              "Vi prego di confermarmi l'accordo per iscritto.",
        "tr": "{of_date}{noun_dat} ilişkin olarak{amount} borcu şu anda tek seferde ödeyemiyorum.\n\n"
              "Bu nedenle ödemenin [tarih] tarihine kadar ertelenmesini veya aylık [tutar] taksitlerle ödenmesini "
              "rica ediyorum.\n\nGerekçe: [Lütfen gerekçenizi buraya yazınız.]\n\n"
              "Varılan anlaşmayı yazılı olarak onaylamanızı rica ederim.",
    },
    "correction": {
        "de": "in {bill_dat}{of_date}{amount} ist mir ein Fehler aufgefallen: [Bitte beschreiben Sie hier, was nicht "
              "stimmt.]\n\nBitte prüfen Sie die Rechnung und senden Sie mir eine berichtigte Rechnung zu.",
        "en": "I have found an error in {bill}{of_date}{amount}: [Please describe here what is wrong.]\n\n"
              "Please check the invoice and send me a corrected invoice.",
        "fr": "J'ai constaté une erreur dans {bill}{of_date}{amount} : [Veuillez décrire ici ce qui est inexact.]\n\n"
              "Je vous remercie de bien vouloir vérifier cette facture et de m'adresser une facture rectifiée.",
        "es": "He detectado un error en {bill}{of_date}{amount}: [Describa aquí lo que no es correcto.]\n\n"
              "Les ruego que revisen la factura y me envíen una factura rectificada.",
        "it": "ho riscontrato un errore nella Vostra fattura{of_date}{amount}: [Descriva qui che cosa non è corretto.]\n\n"
              "Vi prego di verificare la fattura e di inviarmi una fattura rettificata.",
        "tr": "{of_date}{amount}faturanızda bir hata tespit ettim: [Lütfen neyin yanlış olduğunu buraya "
              "yazınız.]\n\nFaturayı kontrol ederek tarafıma düzeltilmiş bir fatura göndermenizi rica ederim.",
    },
    "sepa_revoke": {
        "de": "hiermit widerrufe ich das Ihnen erteilte SEPA-Lastschriftmandat{mandate} mit sofortiger Wirkung.\n\n"
              "Bitte ziehen Sie keine Beträge mehr von meinem Konto ein und bestätigen Sie mir den Widerruf "
              "schriftlich.",
        "en": "I hereby revoke the SEPA direct debit mandate{mandate} that I gave you, with immediate effect.\n\n"
              "Please do not collect any further amounts from my account, and confirm the revocation in writing.",
        "fr": "Par la présente, je révoque avec effet immédiat le mandat de prélèvement SEPA{mandate} que je vous "
              "avais accordé.\n\nJe vous remercie de ne plus effectuer de prélèvement sur mon compte et de me "
              "confirmer cette révocation par écrit.",
        "es": "Por medio de la presente revoco con efecto inmediato la orden de domiciliación SEPA{mandate} que les "
              "había otorgado.\n\nLes ruego que no realicen más cargos en mi cuenta y que me confirmen la revocación "
              "por escrito.",
        "it": "con la presente revoco con effetto immediato il mandato di addebito diretto SEPA{mandate} a Voi "
              "conferito.\n\nVi prego di non effettuare più addebiti sul mio conto e di confermarmi la revoca per "
              "iscritto.",
        "tr": "Tarafınıza vermiş olduğum SEPA otomatik ödeme talimatını{mandate} derhal geçerli olmak üzere iptal "
              "ediyorum.\n\nHesabımdan başka tahsilat yapmamanızı ve iptali yazılı olarak onaylamanızı rica ederim.",
    },
}

# the user's own details, when the profile is not filled in yet
PROFILE_PLACEHOLDERS = {
    "de": ("[Ihr Name]", "[Straße und Hausnummer]", "[PLZ Ort]"),
    "en": ("[Your name]", "[Street and number]", "[Town and postcode]"),
    "fr": ("[Vos nom et prénom]", "[Adresse]", "[Code postal et ville]"),
    "es": ("[Su nombre]", "[Dirección]", "[Código postal y ciudad]"),
    "it": ("[Nome e cognome]", "[Indirizzo]", "[CAP e città]"),
    "tr": ("[Adınız soyadınız]", "[Adres]", "[Posta kodu ve şehir]"),
}
RECIPIENT_PLACEHOLDER = {"de": "[Anschrift des Empfängers]", "en": "[Address of the recipient]",
                         "fr": "[Adresse du destinataire]", "es": "[Dirección del destinatario]",
                         "it": "[Indirizzo del destinatario]", "tr": "[Alıcının adresi]"}

# Careful mode: a letter with a note to AI assistants or with hidden text (but no signs of a scam) is answered, with
# a caution, without bank details, mandate reference or creditor ID, and with every prefilled fact marked to check.
CAREFUL_WARNINGS = frozenset({"ai_instructions", "hidden_text"})
CREDITOR_ID = re.compile(r"^[A-Z]{2}\d{2}[A-Z0-9]{3}[A-Z0-9]{4,28}$")  # SEPA creditor ID: DE98ZZZ09999999999
CAUTION = {
    "ai": {
        "de": "Dieses Schreiben enthält einen Hinweis an KI-Assistenten. Prüfen Sie die Adresse des Empfängers und die "
              "Referenznummern anhand von Angaben, die Sie bereits kennen, bevor Sie diese Antwort abschicken.",
        "en": "This letter contains a note to AI assistants. Check the recipient's address and reference numbers "
              "against details you already know before you send this reply.",
        "fr": "Ce courrier contient une note destinée aux assistants d'IA. Vérifiez l'adresse du destinataire et les "
              "numéros de référence à l'aide d'informations que vous connaissez déjà avant d'envoyer cette réponse.",
        "es": "Esta carta contiene una nota dirigida a asistentes de IA. Compruebe la dirección del destinatario y los "
              "números de referencia con datos que ya conozca antes de enviar esta respuesta.",
        "it": "Questa lettera contiene una nota rivolta agli assistenti IA. Verifichi l'indirizzo del destinatario e i "
              "numeri di riferimento con dati che conosce già prima di inviare questa risposta.",
        "tr": "Bu mektupta yapay zeka asistanlarına yönelik bir not var. Bu yanıtı göndermeden önce alıcının adresini "
              "ve referans numaralarını zaten bildiğiniz bilgilerle karşılaştırın.",
    },
    "hidden": {
        "de": "Dieses Schreiben enthält versteckten Text. Prüfen Sie die Adresse des Empfängers und die "
              "Referenznummern anhand von Angaben, die Sie bereits kennen, bevor Sie diese Antwort abschicken.",
        "en": "This letter contains hidden text. Check the recipient's address and reference numbers against details "
              "you already know before you send this reply.",
        "fr": "Ce courrier contient du texte caché. Vérifiez l'adresse du destinataire et les numéros de référence à "
              "l'aide d'informations que vous connaissez déjà avant d'envoyer cette réponse.",
        "es": "Esta carta contiene texto oculto. Compruebe la dirección del destinatario y los números de referencia "
              "con datos que ya conozca antes de enviar esta respuesta.",
        "it": "Questa lettera contiene testo nascosto. Verifichi l'indirizzo del destinatario e i numeri di "
              "riferimento con dati che conosce già prima di inviare questa risposta.",
        "tr": "Bu mektupta gizli metin var. Bu yanıtı göndermeden önce alıcının adresini ve referans numaralarını "
              "zaten bildiğiniz bilgilerle karşılaştırın.",
    },
}
SEPA_HINT = {
    "de": "Die Gläubiger-ID und die Mandatsreferenz wurden nicht aus dem Schreiben übernommen: Tragen Sie sie aus "
          "Ihren eigenen Unterlagen ein, zum Beispiel aus Ihrem Kontoauszug.",
    "en": "The creditor ID and the mandate reference were not taken from the letter: fill them in from your own "
          "records, for example your bank statement.",
    "fr": "L'identifiant créancier et la référence du mandat n'ont pas été repris du courrier : complétez-les à "
          "partir de vos propres documents, par exemple votre relevé bancaire.",
    "es": "El identificador del acreedor y la referencia del mandato no se han tomado de la carta: complételos con "
          "sus propios documentos, por ejemplo su extracto bancario.",
    "it": "Il codice identificativo del creditore e il riferimento del mandato non sono stati ripresi dalla lettera: "
          "li completi con i Suoi documenti, ad esempio l'estratto conto.",
    "tr": "Alacaklı kimlik numarası ve talimat referansı mektuptan alınmadı: Bunları kendi belgelerinizden, örneğin "
          "hesap özetinizden doldurun.",
}
SEPA_PLACEHOLDERS = {
    "de": " mit der Mandatsreferenz [Mandatsreferenz] (Gläubiger-Identifikationsnummer: [Gläubiger-ID])",
    "en": " with the mandate reference [mandate reference] (creditor ID: [creditor ID])",
    "fr": " portant la référence [référence du mandat] (identifiant créancier SEPA : [identifiant créancier])",
    "es": " con la referencia [referencia del mandato] (identificador del acreedor: [identificador del acreedor])",
    "it": " con riferimento [riferimento del mandato] (codice identificativo del creditore: [codice creditore])",
    "tr": " ([talimat referansı] referanslı, alacaklı kimlik numarası: [alacaklı kimlik numarası])",
}
CHECK_LABEL = {"de": "Bitte prüfen", "en": "Please check", "fr": "À vérifier", "es": "Compruebe, por favor",
               "it": "Da verificare", "tr": "Lütfen kontrol edin"}
AMOUNT_WORD = {"de": "Betrag", "en": "Amount", "fr": "Montant", "es": "Importe", "it": "Importo", "tr": "Tutar"}


# ---------------------------------------------------------------------------------------------------------------
# Dates

def format_date(iso: str, lang: str, us: bool = False) -> str:
    """A date as a letter of that country writes it: 28.11.2026, 28 novembre 2026, 28 de noviembre de 2026, …"""
    d = date.fromisoformat(iso)
    if lang in ("de", "tr"):
        return d.strftime("%d.%m.%Y")
    if lang == "en":
        return f"{MONTHS['en'][d.month - 1]} {d.day}, {d.year}" if us else f"{d.day} {MONTHS['en'][d.month - 1]} {d.year}"
    if lang == "fr":
        return f"{'1er' if d.day == 1 else d.day} {MONTHS['fr'][d.month - 1]} {d.year}"
    if lang == "es":
        return f"{d.day} de {MONTHS['es'][d.month - 1]} de {d.year}"
    if lang == "it":
        return f"{d.day} {MONTHS['it'][d.month - 1]} {d.year}"
    return d.isoformat()


def date_line(today: str, lang: str, city: str, us: bool = False) -> str:
    when = format_date(today, lang, us)
    if not city:
        return when
    if lang == "fr":
        return f"{city}, le {when}"
    if lang == "en":
        return when  # English letters carry no place before the date
    return f"{city}, {when}"


# ---------------------------------------------------------------------------------------------------------------
# The letter's facts

_POSTCODE_LINE = re.compile(r"^(?:[A-Z]{1,2}-)?\d{4,5}\s+\S|^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b|,\s*[A-Z]{2}\s+\d{5}", re.I)
_STREET = re.compile(r"\d|\b(str\.|straße|strasse|weg|platz|allee|gasse|rue|avenue|boulevard|calle|avenida|plaza|via|"
                     r"viale|piazza|corso|cadde|caddesi|sokak|sk\.|mahalle|street|road|lane|po box|postfach|bp|cs)\b", re.I)
_US_ZIP = re.compile(r"\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b")


def _split_address(line: str) -> List[str]:
    """"Bahnhofstrasse 12, 8001 Zürich" -> two lines; "Stadtwerke · Hafenstr. 3 · 67000 Rheinstadt" -> three."""
    parts = [p.strip() for p in re.split(r"\s+[·|•]\s+", line) if p.strip()]
    out = []
    for p in parts:
        m = re.match(r"^(.*?\S),\s*((?:[A-Z]{1,2}-)?\d{4,5}\s+\S.*)$", p)
        out += [m.group(1), m.group(2)] if m else [p]
    return out


def sender_address(pages: Dict[int, str], sender: Optional[Dict]) -> List[str]:
    """The address lines below the sender's name on the letterhead, up to the first empty line (the block after it is
    the user's own address). Lines without a street or post code are left out ("Customer Service")."""
    if not pages or not sender:
        return []
    raw = (pages[min(pages)] or "").splitlines()
    start = None
    for i, line in enumerate(raw[:20]):
        if line.strip() and re.sub(r"\s+", " ", line.strip())[:200] == sender["text"]:
            start = i
            break
    if start is None:
        return []
    out: List[str] = []
    head = _split_address(re.sub(r"\s+", " ", raw[start].strip()))
    out += [p for p in head[1:] if _STREET.search(p)]  # "Stadtwerke · Hafenstr. 3 · 67000 Rheinstadt" on one line
    for line in raw[start + 1:start + 5]:
        line = re.sub(r"\s+", " ", line.strip())
        if not line:
            break
        if not _STREET.search(line):
            continue
        if re.search(r"\b(datum|date|fecha|data|tarih)\b|\b\d{1,2}[./]\d{1,2}[./]\d{2,4}\b", line, re.I):
            break
        out += _split_address(line)
        if len(out) >= 3:
            break
    return out[:3]


def letter_language(pages: Dict[int, str], fallback: str = "en") -> str:
    """The language of the letter, by its common words; the UI language when that is unclear."""
    from app.api.chat import language_of
    text = "\n".join((pages or {})[p] or "" for p in sorted(pages or {}))[:6000]
    name = language_of(text)
    for code in LANGS:
        if locale_rules.language_name(code) == name:
            return code
    fb = (fallback or "en").lower()[:2]
    return fb if fb in LANGS else "en"


def is_us_letter(lines: List[str], facts: Dict) -> bool:
    return any(_US_ZIP.search(l) for l in lines) or any((a.get("currency") == "USD") for a in facts.get("amounts", []))


def deadlines_of(facts: Dict, today: str) -> List[Dict]:
    """The deadlines printed in the letter (a deadline, a payment date, the last day to give notice), each with the
    sentence and page it was read from. A date the letter leaves open (03/04/2026) is shown with its words only."""
    out = []
    for d in facts.get("dates", []):
        if d.get("kind") not in ("deadline", "payment"):
            continue
        item = {"date": None if d.get("ambiguous") else d["value"], "kind": d["kind"], "text": d.get("text", ""),
                "page": d.get("page", 1), "notice": bool(d.get("notice")), "ambiguous": bool(d.get("ambiguous")),
                "literal": d.get("literal")}
        item["passed"] = bool(item["date"] and item["date"] < today)
        out.append(item)
    out.sort(key=lambda x: (not x["notice"], x["date"] or "9999"))
    return out


def _main_amount(facts: Dict) -> Optional[Dict]:
    due = [a for a in facts.get("amounts", []) if not a.get("role")]
    return due[0] if due else None


def _noun_kind(doc_type: Optional[str]) -> str:
    if doc_type in NOTICE_TYPES:
        return "notice"
    if doc_type in BILL_TYPES:
        return "bill"
    return "letter"


# ---------------------------------------------------------------------------------------------------------------
# The body without the model

def template_body(kind: str, lang: str, facts: Dict, us: bool = False, careful: bool = False) -> str:
    """The fixed body of a reply of this kind, filled with the letter's facts. Holds no date but the letter's own and
    no time limit, so it never states a deadline."""
    doc_type = (facts.get("type") or {}).get("value")
    noun_kind = _noun_kind(doc_type)
    letter_date = (facts.get("date") or {}).get("value")
    amount = _main_amount(facts)
    amount_text = amount["value"] if amount else ""
    mandate = next((r["value"] for r in facts.get("references", []) if r.get("kind") == "mandate_reference"), "")
    when = format_date(letter_date, lang, us) if letter_date else ""

    of_date = ({"de": f" vom {when}", "en": f" dated {when}", "fr": f" du {when}", "es": f" de fecha {when}",
                "it": f" del {when}", "tr": f"{when} tarihli "}[lang] if when else "")
    if kind == "deferral":  # "the amount due of 96.00 EUR"
        amount_part = {"de": f" von {amount_text}", "en": f" of {amount_text}", "fr": f" de {amount_text}",
                       "es": f" de {amount_text}", "it": f" di {amount_text}",
                       "tr": f" {amount_text} tutarındaki"}[lang] if amount_text else ""
    else:  # "your invoice for 96.00 EUR"
        amount_part = {"de": f" über {amount_text}", "en": f" for {amount_text}",
                       "fr": f" d'un montant de {amount_text}", "es": f" por un importe de {amount_text}",
                       "it": f" dell'importo di {amount_text}", "tr": f"{amount_text} tutarındaki "}[lang] if amount_text else ""
    noun = NOUNS[noun_kind][lang]
    values = {"of_date": of_date, "amount": amount_part, "noun": noun, "bill": NOUNS["bill"][lang], "noun_dat": noun,
              "noun_acc": noun, "bill_dat": "", "noun_rif": "", "objection_word": "Widerspruch", "mandate": ""}
    if lang == "de":
        values.update(noun_acc=noun[0], noun_dat=noun[1], bill_dat=NOUNS["bill"]["de"][1],
                      objection_word="Einspruch" if doc_type in EINSPRUCH_TYPES else "Widerspruch")
    elif lang == "tr":
        values["noun_dat"] = {"notice": "tebligatınıza", "bill": "faturanıza", "letter": "yazınıza"}[noun_kind]
    elif lang == "it":
        values["noun_rif"] = {"notice": "al Vostro avviso", "bill": "alla Vostra fattura",
                              "letter": "alla Vostra comunicazione"}[noun_kind]
    if careful and kind == "sepa_revoke":
        values["mandate"] = SEPA_PLACEHOLDERS[lang]  # never the mandate or creditor of a letter with a note to AIs
    elif mandate:
        values["mandate"] = {"de": f" mit der Mandatsreferenz {mandate}", "en": f" with the reference {mandate}",
                             "fr": f" portant la référence {mandate}", "es": f" con la referencia {mandate}",
                             "it": f" con riferimento {mandate}", "tr": f" ({mandate} referanslı)"}[lang]
    body = BODIES[kind][lang]
    body = body.format(**{k: values[k] for k in re.findall(r"\{(\w+)\}", body)})
    # after "Sehr geehrte Damen und Herren," and "Gentili Signori," the body starts in lower case
    return body if lang in ("de", "it") else body[0].upper() + body[1:]


# ---------------------------------------------------------------------------------------------------------------
# The body from the model, and the check of every sentence

_PERIOD_UNITS = (r"tage?n?|werktage?n?|kalendertage?n?|wochen?|monate?n?|jahre?n?|stunden?|days?|working days|weeks?|"
                 r"months?|years?|hours?|jours?|semaines?|mois|ans?|heures?|d[ií]as?|semanas?|mes(?:es)?|años?|horas?|"
                 r"giorni|settimane?|mes[ei]|anni|ore|gün|hafta|ay|yıl|saat")
_NUMBER_WORDS = (r"ein(?:e[nm]?)?|zwei|drei|vier|fünf|sechs|sieben|acht|zehn|vierzehn|dreißig|one|two|three|four|five|"
                 r"six|seven|ten|fourteen|thirty|un|une|deux|trois|quatre|cinq|huit|quinze|trente|uno?|una|dos|tres|"
                 r"cuatro|cinco|quince|treinta|due|tre|quattro|cinque|quindici|trenta|bir|iki|üç|dört|beş|on|otuz")
PERIOD = re.compile(rf"(?<![\w-])(?:\d+|{_NUMBER_WORDS})[\s-]*(?:{_PERIOD_UNITS})(?![\w])", re.IGNORECASE)
_MONTH_ALT = locale_rules.MONTH_PATTERN
DATE_LIKE = re.compile(rf"\b\d{{1,2}}[./-]\d{{1,2}}[./-]\d{{2,4}}\b|\b\d{{4}}-\d{{2}}-\d{{2}}\b|"
                       rf"\b\d{{1,2}}(?:\.|er)?\s*(?:de\s+)?(?:{_MONTH_ALT})\b|\b(?:{_MONTH_ALT})\s+\d{{1,2}}\b",
                       re.IGNORECASE)
NUMBER = re.compile(r"\d[\d.,'/\- ]*\d|\d")


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s or "")


def allowed_numbers(facts: Dict, profile: Dict, extra: List[str] = ()) -> List[str]:
    """Every number the letter or the profile holds, as digits only ("1.234,56 EUR" -> "123456")."""
    values = [r["value"] for r in facts.get("references", [])]
    values += [a["value"] for a in facts.get("amounts", [])] + [a.get("number") or "" for a in facts.get("amounts", [])]
    values += [a["value"] for a in facts.get("accounts", [])]
    if facts.get("date"):
        values.append(facts["date"]["value"])
    values += [d["value"] for d in facts.get("dates", []) if d.get("value")]
    values += [v for v in (profile or {}).values() if isinstance(v, str)]
    values += list(extra)
    return [d for d in (_digits(v) for v in values) if d]


def _date_variants(iso: str) -> List[str]:
    d = date.fromisoformat(iso)
    return [f"{d.day:02d}{d.month:02d}{d.year}", f"{d.day}{d.month}{d.year}", f"{d.month:02d}{d.day:02d}{d.year}",
            f"{d.month}{d.day}{d.year}", f"{d.year}{d.month:02d}{d.day:02d}", f"{d.day:02d}{d.month:02d}{d.year % 100:02d}"]


def _sentence_ok(sentence: str, letter_text: str, allowed: List[str], allowed_dates: List[str]) -> bool:
    """False for a sentence that states a time limit or a date the letter does not, or a number that is in neither the
    letter nor the profile: the model must not invent deadlines, amounts or reference numbers."""
    plain_letter = re.sub(r"\s+", " ", letter_text.lower())
    for m in PERIOD.finditer(sentence):
        if m.group(0).lower() not in plain_letter:
            return False
    month_number = locale_rules.month_number
    for m in DATE_LIKE.finditer(sentence):
        text = m.group(0)
        digits = _digits(text)
        if re.search(r"[^\W\d_]", text):  # "15. Dezember", "December 15": the day and month must be a letter's date
            day = re.search(r"\d{1,2}", text).group(0)
            month_word = re.search(rf"(?:{_MONTH_ALT})", text, re.IGNORECASE).group(0)
            month = month_number(month_word.lower())
            if not any(date.fromisoformat(iso).day == int(day) and date.fromisoformat(iso).month == month
                       for iso in allowed_dates):
                return False
        elif not any(digits in _date_variants(iso) for iso in allowed_dates):
            return False
    rest = DATE_LIKE.sub(" ", sentence)  # the dates are checked above
    for m in NUMBER.finditer(rest):
        digits = _digits(m.group(0))
        if len(digits) <= 2:
            continue  # "2 Raten", a day; a number with a unit of time was checked above
        if len(digits) == 4 and any(iso.startswith(digits) for iso in allowed_dates):
            continue  # the year of a checked date
        if not any(digits in a for a in allowed):
            return False
    return True


def _sentences(paragraph: str) -> List[str]:
    return [s for s in re.split(r"(?<=[.!?])\s+(?=[A-ZÄÖÜÉÈÀÂÇÎÔŞİĞÜÖ¿¡\[])", paragraph.strip()) if s.strip()]


def check_body(body: str, lang: str, letter_text: str, allowed: List[str], allowed_dates: List[str],
               profile_name: str = "") -> Dict:
    """The model's body without what it must not write: a salutation, closing, signature or address block it added
    anyway, and every sentence with an invented date, time limit or number. -> {"text", "removed"}"""
    layout = LAYOUT[lang]
    drop_lines = {x.lower().rstrip(",:") for x in (layout["salutation"], layout["closing"], US_LAYOUT["salutation"])}
    paragraphs, removed = [], 0
    for para in re.split(r"\n\s*\n", (body or "").strip()):
        lines = [l for l in para.splitlines() if l.strip()]
        lines = [l for l in lines if l.strip().lower().rstrip(",:") not in drop_lines
                 and not (profile_name and l.strip() == profile_name)
                 and not re.match(r"^\s*(betreff|subject|re|objet|asunto|oggetto|konu)\s*:", l, re.I)]
        if not lines:
            continue
        kept = []
        for s in _sentences(" ".join(l.strip() for l in lines)):
            if _sentence_ok(s, letter_text, allowed, allowed_dates):
                kept.append(s)
            else:
                removed += 1
        if kept:
            paragraphs.append(" ".join(kept))
    text = "\n\n".join(paragraphs).strip().strip("*").strip()
    return {"text": text, "removed": removed}


def model_messages(kind: str, lang: str, facts: Dict, template: str) -> List[Dict]:
    language = locale_rules.language_name(lang) or "English"
    lines = []
    if facts.get("sender"):
        lines.append(f"Recipient: {facts['sender']['value']}")
    if facts.get("type"):
        lines.append(f"Kind of letter received: {facts['type']['value']}")
    if facts.get("date"):
        lines.append(f"Date of the letter received: {format_date(facts['date']['value'], lang)}")
    for r in facts.get("references", [])[:6]:
        lines.append(f"{REFERENCE_WORDS.get(r['kind'], REFERENCE_WORDS['reference'])['en']}: {r['value']}")
    amount = _main_amount(facts)
    if amount:
        lines.append(f"Amount in the letter: {amount['value']}")
    purpose = {
        "cancel": "cancel the contract or subscription",
        "objection": "object to the notice, assessment, fine or demand in the letter",
        "deferral": "ask for more time to pay, or to pay in instalments",
        "correction": "ask for the invoice to be corrected",
        "sepa_revoke": "revoke the SEPA direct debit mandate",
    }[kind]
    system = (
        f"You write the body of a formal reply letter in {language}, in the polite form of address. The purpose: "
        f"{purpose}. Write only the body paragraphs: no address, no date, no subject line, no salutation, no closing "
        "and no signature; the letter is laid out around your text. Use only the facts given. Never state a date, "
        "a deadline, a time limit or a legal period, and never cite a law: the user checks these. Never write a "
        "number that is not in the facts. Keep the parts in square brackets for the user to fill in. Plain text, "
        "no Markdown, at most 120 words."
    )
    user = ("Facts of the letter received:\n" + "\n".join(lines) +
            f"\n\nA plain version of the body, to improve in wording only:\n{template}\n\nWrite the body now.")
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def local_model(name: Optional[str]) -> Optional[str]:
    """The model to write with, only when it runs on this PC (a ":cloud" model would send the letter away)."""
    name = (name or "").strip()
    if not name or name.endswith(":cloud") or name.endswith("-cloud"):
        return None
    return name


def model_body(kind: str, lang: str, facts: Dict, template: str, letter_text: str, profile: Dict, model: str,
               generate) -> Optional[Dict]:
    """The body written by the local model and checked sentence by sentence; None when the model is not there or too
    little of its text passes the check."""
    try:
        result = generate(model=model, messages=model_messages(kind, lang, facts, template), stream=False,
                          options={"temperature": 0.2})
        text = ((result or {}).get("message") or {}).get("content") or ""
    except Exception:
        return None
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    allowed_dates = [d for d in [(facts.get("date") or {}).get("value")] +
                     [d.get("value") for d in facts.get("dates", []) if not d.get("ambiguous")] if d]
    checked = check_body(text, lang, letter_text, allowed_numbers(facts, profile), allowed_dates,
                         (profile or {}).get("full_name", ""))
    if len(checked["text"]) < 40 or checked["removed"] > 2:
        return None
    # the bracketed parts for the user must stay: a body without the reasons to fill in reads as finished
    if "[" in template and "[" not in checked["text"]:
        return None
    return checked


# ---------------------------------------------------------------------------------------------------------------
# The whole letter

def profile_lines(profile: Dict, lang: str) -> List[str]:
    p = profile or {}
    name_ph, street_ph, city_ph = PROFILE_PLACEHOLDERS[lang]
    town = " ".join(x for x in [p.get("postal_code", ""), p.get("city", "")] if x).strip()
    if lang == "en" and p.get("postal_code") and p.get("city"):
        town = f"{p['city']} {p['postal_code']}"
    lines = [p.get("full_name") or name_ph, p.get("street") or street_ph, town or city_ph]
    if p.get("country"):
        lines.append(p["country"])
    return lines


def subject_line(kind: str, lang: str, facts: Dict, us: bool = False) -> str:
    subject = SUBJECTS[kind][lang]
    if kind == "objection" and lang == "de" and (facts.get("type") or {}).get("value") in EINSPRUCH_TYPES:
        subject = "Einspruch"
    if kind in ("objection", "deferral", "correction") and facts.get("date"):
        when = format_date(facts["date"]["value"], lang, us)
        subject += {"de": f" – Ihr Schreiben vom {when}", "en": f" – your letter dated {when}",
                    "fr": f" – votre courrier du {when}", "es": f" – su escrito de fecha {when}",
                    "it": f" – Vostra comunicazione del {when}", "tr": f" – {when} tarihli yazınız"}[lang]
    return subject


def reference_lines(facts: Dict, lang: str) -> List[str]:
    out = []
    for r in facts.get("references", [])[:4]:
        word = REFERENCE_WORDS.get(r.get("kind"), REFERENCE_WORDS["reference"])[lang]
        out.append(f"{word}{' : ' if lang == 'fr' else ': '}{r['value']}")
    return out


def compose(kind: str, lang: str, facts: Dict, recipient: List[str], profile: Dict, body: str, today: str,
            us: bool = False) -> str:
    """The letter as plain text, laid out the way the country writes it."""
    layout = US_LAYOUT if (lang == "en" and us) else LAYOUT[lang]
    own = profile_lines(profile, lang)
    to = [layout["recipient_prefix"] + recipient[0]] + recipient[1:] if recipient else [RECIPIENT_PLACEHOLDER[lang]]
    when = date_line(today, lang, (profile or {}).get("city", ""), us)
    subject = layout["subject"] + subject_line(kind, lang, facts, us)
    refs = reference_lines(facts, lang)
    blocks = []
    if lang == "de":
        # DIN 5008: own address, the recipient's address field, the date (right), the subject without "Betreff",
        # the salutation, the body, "Mit freundlichen Grüßen" without a comma, room for the signature, the name
        blocks += ["\n".join(own), "\n".join(to), when, "\n".join([subject] + refs)]
    elif lang == "en":
        blocks += ["\n".join(own), when, "\n".join(to), "\n".join([subject] + refs)]
    elif lang == "tr":
        blocks += [when, "\n".join(own), "\n".join(to), "\n".join([subject] + refs)]
    else:  # French, Spanish, Italian: own address, recipient, place and date, the subject with its word
        blocks += ["\n".join(own), "\n".join(to), when, "\n".join([subject] + refs)]
    blocks += [layout["salutation"], body.strip(), layout["closing"] + "\n" * layout["gap"] + "\n" + own[0]]
    return "\n\n".join(b for b in blocks if b) + "\n"


def careful_facts(facts: Dict) -> Dict:
    """The facts of a letter with a note to AI assistants or hidden text, without anything that would move money:
    no bank account, no mandate reference, no creditor ID. The user fills these in from their own records."""
    refs = [r for r in facts.get("references", []) if r.get("kind") != "mandate_reference"
            and not CREDITOR_ID.search(re.sub(r"\s", "", r.get("value", "")))]
    return {**facts, "references": refs, "accounts": []}


def caution_of(kind: str, lang: str, warnings, recipient: List[str], facts: Dict, us: bool = False) -> Dict:
    """The calm caution shown above the draft of a letter with a note to AI assistants or hidden text, in the letter's
    language, with the prefilled facts to check against details the user already knows."""
    what = "ai" if "ai_instructions" in warnings else "hidden"
    lines = [CAUTION[what][lang]]
    if kind == "sepa_revoke":
        lines.append(SEPA_HINT[lang])
    items = []
    if recipient:
        items.append(", ".join(recipient))
    items += reference_lines(facts, lang)
    amount = _main_amount(facts)
    if amount:
        items.append(f"{AMOUNT_WORD[lang]}{' : ' if lang == 'fr' else ': '}{amount['value']}")
    return {"warnings": sorted(warnings), "text": " ".join(lines), "label": CHECK_LABEL[lang], "items": items}


def draft(kind: str, facts: Dict, pages: Dict[int, str], profile: Dict, today: str, ui_language: str = "en",
          model: Optional[str] = None, generate=None, language: Optional[str] = None, warnings=()) -> Dict:
    """A reply letter for one letter: the text to edit, its parts and where each fact was read.

    warnings: the letter's checks (facts_service). A letter with signs of a scam is never answered (the caller refuses
    it). A letter with a note to AI assistants or with hidden text is drafted in careful mode: a caution in the letter's
    language, no bank details, mandate reference or creditor ID, the fixed body (the model reads nothing of such a
    letter), and every prefilled fact marked to be checked."""
    if kind not in KINDS:
        raise ValueError(kind)
    if "scam_signs" in (warnings or ()):
        raise ValueError("scam")
    careful_warnings = sorted(set(warnings or ()) & CAREFUL_WARNINGS)
    careful = bool(careful_warnings)
    if careful:
        facts = careful_facts(facts)
    lang = language if language in LANGS else letter_language(pages, ui_language)
    recipient_name = (facts.get("sender") or {}).get("value")
    address = sender_address(pages, facts.get("sender"))
    recipient = [recipient_name] + address if recipient_name else []
    us = lang == "en" and is_us_letter(address, facts)
    template = template_body(kind, lang, facts, us, careful)
    letter_text = "\n".join((pages or {})[p] or "" for p in sorted(pages or {}))
    body, source, used_model = template, "template", None
    chosen = None if careful else local_model(model)
    if chosen and generate:
        written = model_body(kind, lang, facts, template, letter_text, profile, chosen, generate)
        if written:
            body, source, used_model = written["text"], "model", chosen
    text = compose(kind, lang, facts, recipient, profile, body, today, us)
    deadlines = deadlines_of(facts, today)
    amount = _main_amount(facts)
    p = profile or {}
    return {
        "kind": kind, "language": lang, "us": us, "text": text, "subject": subject_line(kind, lang, facts, us),
        "body_source": source, "model": used_model,
        "recipient": {"lines": recipient, "page": (facts.get("sender") or {}).get("page"),
                      "text": (facts.get("sender") or {}).get("text"), "check": careful},
        "references": [{"kind": r["kind"], "value": r["value"], "page": r["page"], "text": r["text"], "check": careful}
                       for r in facts.get("references", [])[:4]],
        "letter_date": facts.get("date"),
        "amount": {**amount, "check": careful} if amount else None,
        "deadlines": deadlines,
        "deadline_missing": not deadlines,
        "profile_complete": bool(p.get("full_name") and p.get("street") and p.get("city")),
        "careful": careful,
        "caution": caution_of(kind, lang, careful_warnings, recipient, facts, us) if careful else None,
    }
