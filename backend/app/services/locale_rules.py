"""Words and formats of letters in several languages, in one place.

The rule-based reading of letters (dates, amounts, kinds of letters, reference numbers, signs of a scam) works on
English, German, French, Spanish, Italian and Turkish text. Each rule is a regular expression fragment per language
code, so supporting a language means adding its fragments here, nothing else (docs/adding-a-language.md).

    RULES["deadline"]["fr"]  ->  "échéance|date limite|..."
    rule("deadline")         ->  the fragments of all languages joined with "|"

The rules never decide anything alone; dates_service, facts_service and document_checks combine them. All of them
are matched with re.IGNORECASE, and accents are optional where a scan or a photo often loses them.
"""
import re
import unicodedata
from typing import Dict, Iterable, Optional

LANGUAGES = ("en", "de", "fr", "es", "it", "tr")  # the languages letters are read in

_A = "['’]"  # apostrophe, straight or typographic

# English names of languages by ISO 639-1 code: prompts name the language the answer is written in ("Write in French").
# Any language of the UI or of a question can be named here; the rules below only matter for reading letters.
LANGUAGE_NAMES = {
    "en": "English", "de": "German", "fr": "French", "es": "Spanish", "it": "Italian", "tr": "Turkish", "pt": "Portuguese",
    "nl": "Dutch", "pl": "Polish", "ru": "Russian", "uk": "Ukrainian", "cs": "Czech", "sk": "Slovak", "hu": "Hungarian",
    "ro": "Romanian", "bg": "Bulgarian", "el": "Greek", "sv": "Swedish", "da": "Danish", "no": "Norwegian", "nb": "Norwegian",
    "fi": "Finnish", "hr": "Croatian", "sr": "Serbian", "sl": "Slovenian", "ca": "Catalan", "ar": "Arabic", "fa": "Persian",
    "he": "Hebrew", "hi": "Hindi", "bn": "Bengali", "ur": "Urdu", "id": "Indonesian", "ms": "Malay", "vi": "Vietnamese",
    "th": "Thai", "ja": "Japanese", "ko": "Korean", "zh": "Chinese", "sq": "Albanian", "lt": "Lithuanian", "lv": "Latvian",
    "et": "Estonian",
}


def language_name(code: Optional[str]) -> Optional[str]:
    """"de" / "de-AT" / "DE" -> "German"; None for a code that is not known."""
    return LANGUAGE_NAMES.get((code or "").lower().replace("_", "-").split("-")[0])

# ---------------------------------------------------------------------------------------------------------------
# Months. Names without accents are added automatically (a scan often loses them: "decembre").
MONTH_NAMES: Dict[str, Dict[str, int]] = {
    "en": {"january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6, "july": 7, "august": 8,
           "september": 9, "october": 10, "november": 11, "december": 12, "sept": 9},
    "de": {"januar": 1, "jänner": 1, "februar": 2, "märz": 3, "maerz": 3, "april": 4, "mai": 5, "juni": 6, "juli": 7,
           "august": 8, "september": 9, "oktober": 10, "november": 11, "dezember": 12},
    "fr": {"janvier": 1, "février": 2, "mars": 3, "avril": 4, "mai": 5, "juin": 6, "juillet": 7, "août": 8,
           "septembre": 9, "octobre": 10, "novembre": 11, "décembre": 12},
    "es": {"enero": 1, "febrero": 2, "marzo": 3, "abril": 4, "mayo": 5, "junio": 6, "julio": 7, "agosto": 8,
           "septiembre": 9, "setiembre": 9, "octubre": 10, "noviembre": 11, "diciembre": 12},
    "it": {"gennaio": 1, "febbraio": 2, "marzo": 3, "aprile": 4, "maggio": 5, "giugno": 6, "luglio": 7, "agosto": 8,
           "settembre": 9, "ottobre": 10, "novembre": 11, "dicembre": 12},
    "tr": {"ocak": 1, "şubat": 2, "mart": 3, "nisan": 4, "mayıs": 5, "haziran": 6, "temmuz": 7, "ağustos": 8,
           "eylül": 9, "ekim": 10, "kasım": 11, "aralık": 12},
}


def strip_accents(text: str) -> str:
    """Lower case without accents ("Décembre" -> "decembre", "Aralık" -> "aralik")."""
    text = text.replace("ı", "i").replace("İ", "i").lower()
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


def _month_table() -> Dict[str, int]:
    table: Dict[str, int] = {}
    for names in MONTH_NAMES.values():
        for name, number in names.items():
            table[name] = number
            table.setdefault(strip_accents(name), number)
    return table


MONTHS = _month_table()
MONTH_PATTERN = "|".join(sorted(MONTHS, key=len, reverse=True))


def month_number(name: str) -> Optional[int]:
    name = name.lower().rstrip(".")
    return MONTHS.get(name) or MONTHS.get(strip_accents(name))


# ---------------------------------------------------------------------------------------------------------------
# Currencies: what is written next to a number -> ISO code. "$" is US dollars unless the text says CAD, AUD, ...
CURRENCY_WORDS = {
    "EUR": r"EUR|euros?|€", "USD": r"USD|US ?\$|dollars?|\$", "GBP": r"GBP|£", "CHF": r"CHF|SFr\.?|Fr\.",
    "TRY": r"TRY|TL|₺|lira|liras", "JPY": r"JPY|¥", "CAD": r"CAD|CA ?\$|C\$", "AUD": r"AUD|AU ?\$|A\$",
    "NZD": r"NZD|NZ ?\$", "SEK": r"SEK", "NOK": r"NOK", "DKK": r"DKK", "PLN": r"PLN|zł", "CZK": r"CZK|Kč",
    "HUF": r"HUF", "INR": r"INR|₹|Rs\.?", "CNY": r"CNY|RMB", "BRL": r"BRL|R\$", "MXN": r"MXN",
}
# longer spellings first, so "US$" is not read as "$"
_CURRENCY_ALT = "|".join(sorted((w for ws in CURRENCY_WORDS.values() for w in ws.split("|")), key=len, reverse=True))
CURRENCY = rf"(?<![A-Za-z])(?:{_CURRENCY_ALT})(?![A-Za-z])|[€$£₺¥₹]"
_CODE_BY_WORD = {}
for _code, _words in CURRENCY_WORDS.items():
    for _w in _words.split("|"):
        _CODE_BY_WORD[re.sub(r"[\\ ?]", "", _w).lower().replace(".", "")] = _code


def currency_code(written: str) -> str:
    """ISO code for what was written ("€" -> "EUR", "US$" -> "USD", "TL" -> "TRY")."""
    word = re.sub(r"[\\ ?.]", "", written or "").lower()
    return _CODE_BY_WORD.get(word) or _CODE_BY_WORD.get(word + "s") or (written or "").upper()


# ---------------------------------------------------------------------------------------------------------------
# Words by purpose and language. A fragment is a regular expression; \w* covers endings.
RULES: Dict[str, Dict[str, str]] = {
    # a word that makes a date a deadline
    "deadline": {
        "de": r"frist|fristen|bis zum|bis spätestens|spätestens|fällig|fälligkeit|zahlungsziel|zahlbar|kündigungsfrist|kündig|"
              r"einspruch|widerspruch|widersprechen|ablauf|endet|gültig bis",
        "en": r"due|deadline|no later than|by|until|expires|expiry|cancel|objection|payable|overdue|expiration|valid until",
        "fr": rf"[ée]ch[ée]ance|date limite|d[ée]lai|avant le|au plus tard|jusqu{_A}au|d{_A}ici le|payable|exigible|expire\w*|"
              r"valable jusqu\w*|dernier délai|contestation|recours|opposition",
        "es": r"vencimiento|vence|fecha límite|plazo|antes del|hasta el|a más tardar|como máximo|pagadero|abonar antes|"
              r"válido hasta|caduca|recurso|alegaciones|reclamación",
        "it": r"scadenza|scade|entro il|entro e non oltre|non oltre il|pagabile|da pagare entro|fino al|valido fino|"
              r"ricorso|opposizione|disdetta entro",
        "tr": r"son ödeme|son tarih|vade\w*|en geç|kadar ödeyiniz|itiraz\w*|ödenmelidir|ödeme tarihi|son gün|geçerlilik",
    },
    "payment": {
        "de": r"überweis\w*|zahlung\w*|zahlen|bezahlen|lastschrift|eingezogen|abgebucht|betrag|beitrag|rechnung\w*|"
              r"nachzahlung|abbuchung",
        "en": r"payment|pay|paid|debit\w*|amount|invoice|renews|renewal|charged|billed",
        "fr": r"paiement|payer|règlement|régler|facture\w*|montant|prélèvement|prélevé|virement|cotisation|solde",
        "es": r"pago|pagar|abonar|factura\w*|importe|cargo|adeudo|domiciliación|domiciliado|transferencia|cuota|recibo|saldo",
        "it": r"pagamento|pagare|pagherete|fattura\w*|importo|addebito|addebitato|bonifico|rata|saldo|quota",
        "tr": r"ödeme\w*|öde\w*|fatura\w*|tutar\w*|borç\w*|havale\w*|tahsil\w*|aidat\w*|prim",
    },
    # in front of a date: "pay by 15 December", "avant le", "entro il", "hasta el"
    "by_date": {
        "de": r"bis zum|bis spätestens|spätestens (?:am|bis)?|bis|fällig am",
        "en": r"by|until|no later than|before|due on|due",
        "fr": rf"avant le|avant|au plus tard le|au plus tard|jusqu{_A}au|jusqu{_A}à|d{_A}ici le|le plus tard le",
        "es": r"antes del|antes de|hasta el|hasta|a más tardar el|a más tardar|como máximo el|vence el|vencimiento",
        "it": r"entro il|entro e non oltre il|entro|non oltre il|fino al|sino al|scadenza",
        "tr": r"son ödeme tarihi|son tarih|en geç",
    },
    # after a date (Turkish writes the word behind it): "15.12.2026 tarihine kadar"
    "by_date_after": {"tr": rf"tarihine kadar|tarihinde|{_A}?(?:e|a) kadar|e kadar|a kadar|tarihine dek"},
    "appointment": {
        "de": r"termin\w*|einladung|eingeladen|kommen sie|erscheinen|vorsprache|vorstellungsgespräch|sprechstunde",
        "en": r"appointment|interview|meeting|please come|attend",
        "fr": rf"rendez-vous|convocation|convoqué\w*|entretien|veuillez vous présenter|audience|consultation",
        "es": r"cita|citación|entrevista|reunión|comparecer|presentarse|consulta",
        "it": r"appuntamento|convocazione|colloquio|visita|presentarsi|udienza",
        "tr": r"randevu\w*|görüşme\w*|davet\w*|mülakat|duruşma\w*|muayene",
    },
    # the label of the date of a letter: "Datum: 03.11.2026" (never a deadline)
    "letter_date_label": {
        "de": r"datum|ausgestellt am|(?:rechnungs|beleg|ausstellungs|brief|schreib)datum",
        "en": r"date|invoice date|issue date|date of issue|statement date|billing date|bill date",
        "fr": rf"date|date d{_A}(?:émission|édition)|date de (?:la )?factur\w*|établi le|émis le|fait le",
        "es": r"fecha|fecha de (?:emisión|factura|expedición)",
        "it": r"data|data di (?:emissione|fatturazione)|data fattura",
        "tr": r"tarih|(?:fatura|düzenleme|belge) tarihi",
    },
    # in front of the date of an earlier document: "Rechnung vom 20.10.2026", "facture du", "dated"
    "document_date_ref": {
        "de": r"vom",
        "en": r"dated",
        "fr": r"en date du|daté du|datée du|(?:facture|lettre|courrier|avis|relevé|contrat) du",
        "es": r"con fecha|de fecha|fechado el|(?:factura|carta|contrato) del",
        "it": r"in data|con data|datata|(?:fattura|lettera|contratto) del",
        "tr": r"tarihli",
    },
    # fees and charges in front of an amount: the fee is not what is due
    "fee": {
        "de": r"gebühr\w*|mahnkosten|kosten|porto|zinsen",
        "en": r"fee|charge|late fee|penalty|interest|surcharge|shipping|handling",
        "fr": r"frais|pénalités?|majoration|intérêts|indemnité|commission",
        "es": r"gastos|recargo|intereses|comisión|tasa|penalización|costas",
        "it": r"spese|interessi|mora|commissione|penale|costi",
        "tr": r"masraf\w*|faiz\w*|komisyon\w*|gecikme\w*|ceza\w*|harç\w*",
    },
    # an amount that was replaced: "statt bisher 4,90 EUR"
    "old_amount": {
        "de": r"bisher|vorher|statt|anstatt|alt|ehemals",
        "en": r"previously|instead of|was|formerly|previous|old",
        "fr": r"précédemment|auparavant|au lieu de|ancien|anciennement",
        "es": r"antes|anteriormente|anterior|en lugar de|en vez de",
        "it": r"prima|precedentemente|precedente|anziché|invece di",
        "tr": r"eskiden|önceki|eski|yerine",
    },
    # the day something changes: "ab dem 01.02.2027", "à partir du", "a partir del", "dal"
    "from_date": {
        "de": r"ab(?: dem| 1\.)?|gültig ab|wirksam ab",
        "en": r"from|with effect from|effective(?: from)?|starting|as of|beginning on",
        "fr": r"à partir du|à compter du|dès le|à dater du|a partir du",
        "es": r"a partir del|a partir de|desde el|con efecto desde el|con efecto a partir del",
        "it": r"a partire dal|a decorrere dal|con decorrenza dal|con effetto dal|dal",
        "tr": r"",
    },
    "from_date_after": {"tr": rf"tarihinden itibaren|itibaren|{_A}?(?:den|dan) itibaren"},
    # a letter that replaces an earlier one
    "replaces": {
        "de": r"ersetzt|ersetzen",
        "en": r"replaces|supersedes",
        "fr": r"remplace|annule et remplace|annule",
        "es": r"sustituye|reemplaza|anula",
        "it": r"sostituisce|annulla e sostituisce|annulla",
    },
    "replaces_of": {
        "de": r"vom", "en": r"of|dated", "fr": r"du|en date du|datée du", "es": r"del|de fecha|con fecha",
        "it": r"del|in data",
    },
    # words for the end of a period: "01.01.2026 bis 31.12.2026"
    "period_join": {"*": r"bis|-|–|—|au|al|a|to|through|until|hasta|kadar"},
}


# Notice periods in contracts: "at least 30 days before 31 March 2027" means the notice has to be given by 1 March 2027.
NUMBER_WORDS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "twelve": 12,
    "ein": 1, "eine": 1, "einen": 1, "einem": 1, "zwei": 2, "drei": 3, "vier": 4, "fünf": 5, "sechs": 6, "sieben": 7,
    "acht": 8, "neun": 9, "zehn": 10, "zwölf": 12,
    "un": 1, "une": 1, "deux": 2, "trois": 3, "quatre": 4, "cinq": 5, "sept": 7, "huit": 8, "neuf": 9, "dix": 10, "douze": 12,
    "uno": 1, "dos": 2, "tres": 3, "cuatro": 4, "cinco": 5, "seis": 6, "siete": 7, "ocho": 8, "nueve": 9, "diez": 10, "doce": 12,
    "due": 2, "tre": 3, "quattro": 4, "cinque": 5, "sei": 6, "sette": 7, "otto": 8, "nove": 9, "dieci": 10, "dodici": 12,
    "bir": 1, "iki": 2, "üç": 3, "dört": 4, "beş": 5, "altı": 6, "yedi": 7, "sekiz": 8, "dokuz": 9,
}
# the unit of the period, by language (a regular expression for each of days, weeks, months)
PERIOD_UNITS = {
    "days": r"days?|tage[n]?|jours?|d[ií]as?|giorni|giorno|gün",
    "weeks": r"weeks?|wochen?|semaines?|semanas?|settimane|settimana|hafta",
    "months": r"months?|monate[n]?|monat|mois|mes(?:es)?|mesi|mese|ay",
}
# words that make a sentence about giving notice of a contract
NOTICE_WORDS = {
    "en": r"notice|cancel\w*|terminat\w*",
    "de": r"k[üu]e?ndig\w*",
    "fr": r"pr[ée]avis|r[ée]sili\w*",
    "es": r"preaviso|rescind\w*|rescis\w*|cancelar|cancelaci[oó]n|dar de baja|baja del",
    "it": r"disdett\w*|recesso|preavviso|recedere",
    "tr": r"fesih\w*|ihbar\w*|iptal\w*|bildirim\w*",
}
# between the period and the date: "30 days BEFORE 31 March", "3 Monate VOR dem Vertragsende am 31.03.", "antes del"
PERIOD_BEFORE = {
    "en": r"before|prior to|ahead of", "de": r"vor|zum", "fr": r"avant", "es": r"antes\s+(?:del?|al?)",
    "it": r"prima\s+(?:del|della|dello|di)|prima",
}
# a contract starting is not something to do: "The contract starts on 1 April 2026", "Vertragsbeginn: 01.04.2026"
CONTRACT_START = (r"(?:contract|agreement|lease|tenancy|policy|membership|subscription)\s+(?:starts?|begins?|commences?|"
                  r"is effective)|start date|commencement|effective date of the"
                  r"|vertragsbeginn|mietbeginn|versicherungsbeginn|beginn des vertrag\w*|vertrag beginnt|versicherungsschutz beginnt"
                  r"|d[ée]but du contrat|date de d[ée]but|le contrat (?:commence|prend effet)"
                  r"|inicio del contrato|fecha de inicio|el contrato (?:comienza|empieza|entra en vigor)"
                  r"|inizio del contratto|data di inizio|il contratto (?:inizia|decorre)|decorrenza del contratto"
                  r"|s[öo]zle[sş]me ba[sş]lang[ıi][cç]|ba[sş]lang[ıi][cç] tarihi|s[öo]zle[sş]me .{0,20}ba[sş]lar")


def rule(name: str, langs: Optional[Iterable[str]] = None) -> str:
    """The fragments of one rule for these languages (default: all), joined as one alternation."""
    table = RULES[name]
    parts = [table[l] for l in (langs or LANGUAGES) if table.get(l)]
    parts += [v for k, v in table.items() if k == "*"]
    return "|".join(parts)


def compiled(name: str, template: str = r"\b(?:{})\b", flags=re.IGNORECASE):
    """A rule as a compiled regular expression; template says where the alternation goes."""
    return re.compile(template.format(rule(name)), flags)


# ---------------------------------------------------------------------------------------------------------------
# Kinds of letters, most specific first (the order matters, see facts_service). Fragments per language.
TYPES = [
    ("debt_collection", {
        "de": r"inkasso\w*|forderungsmanagement", "en": r"debt collect\w*|collection agency",
        "fr": r"recouvrement|société de recouvrement", "es": r"cobro de deudas|agencia de cobro|recobro",
        "it": r"recupero crediti|società di recupero", "tr": r"icra|borç tahsil\w*|tahsilat"}),
    ("reminder", {
        "de": r"mahnung|zahlungserinnerung|letzte erinnerung|pfändungsankündigung",
        "en": r"payment reminder|final notice|overdue notice|past due|final demand",
        "fr": r"relance|mise en demeure|rappel de paiement|dernier rappel",
        "es": r"recordatorio de pago|reclamación de deuda|último aviso|requerimiento de pago",
        "it": r"sollecito|diffida|ultimo avviso", "tr": r"ödeme hatırlatma\w*|son uyarı|ihtar\w*"}),
    ("fine", {
        "de": r"bußgeldbescheid|bussgeldbescheid|verwarnungsgeld|anhörung im bußgeldverfahren",
        "en": r"penalty notice|parking fine|parking charge notice|traffic ticket|speeding ticket",
        "fr": r"amende|avis de contravention|procès-verbal|contravention",
        "es": r"multa|sanción|denuncia de tráfico|infracción",
        "it": r"multa|verbale|sanzione amministrativa|contravvenzione",
        "tr": r"trafik cezası|idari para cezası|ceza tutanağı"}),
    ("tax_notice", {
        "de": r"steuerbescheid|bescheid für \d{4} über|einkommensteuer\w*bescheid",
        "en": r"tax assessment|notice of assessment|irs notice|self assessment|council tax|tax return",
        "fr": rf"avis d{_A}imposition|taxe foncière|déclaration de revenus",
        "es": r"liquidación tributaria|agencia tributaria|declaración de la renta",
        "it": r"avviso di accertamento|cartella esattoriale|cartella di pagamento|avviso bonario",
        "tr": r"vergi tebligatı|ödeme emri|tahakkuk fişi|vergi dairesi"}),
    ("payslip", {
        "de": r"gehaltsabrechnung|entgeltabrechnung|lohnabrechnung|verdienstabrechnung",
        "en": r"payslip|pay slip|salary statement|pay stub|wage statement",
        "fr": r"bulletin de paie|bulletin de salaire|fiche de paie", "es": r"nómina|recibo de salarios",
        "it": r"busta paga|cedolino", "tr": r"maaş bordrosu|bordro"}),
    ("termination", {
        "de": r"kündigungsbestätigung|bestätigung (?:ihrer|der) kündigung|kündigung",
        "en": r"cancellation confirm\w*|notice of termination|termination notice",
        "fr": r"résiliation|confirmation de résiliation", "es": r"confirmación de baja|rescisión|baja del servicio",
        "it": r"disdetta|conferma di disdetta|recesso", "tr": r"fesih\w*|iptal onayı|abonelik iptali"}),
    ("statement", {
        "de": r"nebenkostenabrechnung|betriebskostenabrechnung|jahresabrechnung|kontoauszug|abrechnung",
        "en": r"account statement|statement of account|bank statement|monthly statement",
        "fr": r"relevé de compte|décompte de charges|régularisation des charges|relevé",
        "es": r"extracto de cuenta|extracto|liquidación de gastos",
        "it": r"estratto conto|rendiconto|conguaglio", "tr": r"hesap özeti|ekstre|hesap dökümü"}),
    ("invoice", {
        "de": r"\w*(?<!be)rechnung", "en": r"invoice|bill\b", "fr": r"facture", "es": r"factura",
        "it": r"fattura|ricevuta", "tr": r"fatura"}),
    ("job_offer", {
        "de": r"arbeitsangebot|stellenangebot", "en": r"offer of employment|job offer|offer letter|pleased to offer you",
        "fr": rf"offre d{_A}emploi|proposition d{_A}embauche|promesse d{_A}embauche",
        "es": r"oferta de empleo|oferta de trabajo", "it": r"offerta di lavoro|proposta di assunzione",
        "tr": r"iş teklif\w*"}),
    ("contract", {
        "de": r"\w*mietvertrag|\w*arbeitsvertrag|vertrag\b", "en": r"employment contract|tenancy agreement|agreement|terms and conditions|lease",
        "fr": r"contrat\w*|bail\b", "es": r"contrato\w*|arrendamiento", "it": r"contratto\w*|locazione",
        "tr": r"sözleşme\w*"}),
    ("invitation", {
        "de": r"einladung|vorladung", "en": r"invitation|appointment\b",
        "fr": r"convocation|invitation|rendez-vous", "es": r"citación|invitación|cita previa",
        "it": r"convocazione|invito|appuntamento", "tr": r"davet\w*|randevu\w*|çağrı"}),
    ("medical", {
        "de": r"arztbrief|befundbericht|befund|diagnose|entlassungsbericht", "en": r"medical report|diagnosis|discharge summary",
        "fr": rf"compte rendu médical|ordonnance|résultats d{_A}analyses|certificat médical",
        "es": r"informe médico|diagnóstico|alta hospitalaria", "it": r"referto|diagnosi|lettera di dimissione|certificato medico",
        "tr": r"epikriz|tahlil sonuçları|sağlık raporu"}),
    ("price_change", {
        "de": r"beitragsanpassung|preisanpassung|preisänderung|zusatzbeitrag|entgeltänderung|"
              r"änderung (?:der|unserer|ihrer) (?:entgelte|preise|beiträge|bedingungen|konditionen)|"
              r"(?:beitrag|preis|entgelt)\w* ändert sich|neue bankverbindung",
        "en": r"price change|change (?:of|in) (?:fees|prices)|price increase|premium increase|rate change",
        "fr": r"modification tarifaire|changement de tarif|évolution tarifaire|augmentation de (?:votre|la) cotisation",
        "es": r"modificación de tarifas|cambio de precio|actualización de tarifas|subida de (?:precio|cuota)",
        "it": r"variazione tariffaria|modifica delle condizioni|aggiornamento tariffe|variazione del premio",
        "tr": r"tarife değişikliği|fiyat değişikliği|zam bildirimi"}),
    ("payment_notice", {
        "de": r"ankündigung der lastschrift|lastschriftankündigung|vorabankündigung", "en": r"payment notice|direct debit notice",
        "fr": r"avis de prélèvement|préavis de prélèvement", "es": r"aviso de adeudo|aviso de cargo|preaviso de domiciliación",
        "it": r"preavviso di addebito|avviso di addebito", "tr": r"otomatik ödeme bildirimi|talimat bildirimi"}),
    ("notice", {
        "de": r"bescheid\b|verwaltungsakt", "en": r"official notice", "fr": r"notification officielle|avis officiel",
        "es": r"notificación oficial|resolución", "it": r"provvedimento|notifica ufficiale|comunicazione ufficiale",
        "tr": r"resmi bildirim|tebligat"}),
    ("insurance", {
        "de": r"versicherung\w*|versicherungsschein|police\b", "en": r"insurance|policy",
        "fr": rf"assurance|attestation d{_A}assurance", "es": r"seguro|póliza|aseguradora", "it": r"assicurazione|polizza",
        "tr": r"sigorta|poliçe"}),
    ("prize", {
        "de": r"gewinnbenachrichtigung|gewinner|gewonnen", "en": r"you have won|prize",
        "fr": r"vous avez gagné|loterie|gagnant", "es": r"has ganado|felicidades|premio|sorteo|ganador",
        "it": r"hai vinto|vincita|premio|vincitore", "tr": r"kazandınız|çekiliş|talihli"}),
]


def type_patterns():
    """[(kind, regex source)] for facts_service."""
    return [(kind, "|".join(f for l in LANGUAGES for f in [frags.get(l)] if f)) for kind, frags in TYPES]


# A screenshot of a text message: "Nachricht von +44 7700 900123 heute 09:14"
MESSAGE_WORDS = r"nachricht von|sms von|imessage von|message from|text message from|message de|sms de|mensaje de|messaggio da|mesajı|mesaj:"
# "zwischen Dieter Brand": the other party of a contract
BETWEEN_WORDS = r"zwischen|between|entre|tra|arasında"
BETWEEN_AND = r"vertreten|represented|und|and|et|y|e|ve"

# Reference numbers: (kind, label fragments, all languages together).
REFERENCE_LABELS = [
    ("customer_number", r"kunden[- ]?(?:nummer|nr\.?)|kd\.?[- ]?nr\.?|customer (?:number|no\.?|id)|client (?:number|no\.?)|"
                        r"numéro (?:de )?client|n[°º]\.? ?(?:de )?client|número de cliente|n\.º de cliente|nº de cliente|"
                        r"codice cliente|numero cliente|müşteri (?:numarası|no)|abone (?:numarası|no)|tesisat (?:numarası|no)|"
                        r"account (?:number|no\.?)"),
    ("invoice_number", r"rechnungs[- ]?(?:nummer|nr\.?)|rechnung nr\.?|invoice (?:number|no\.?)|numéro de facture|"
                       r"n[°º]\.? ?(?:de )?facture|número de factura|n\.º de factura|nº de factura|factura n[º°.]|"
                       r"numero fattura|n\. ?fattura|fattura n[.°º]?|fatura (?:numarası|no)"),
    ("contract_number", r"vertrags[- ]?(?:nummer|nr\.?)|vertrag nr\.?|contract (?:number|no\.?)|numéro de contrat|"
                        r"n[°º]\.? ?(?:de )?contrat|número de contrato|n\.º de contrato|numero contratto|"
                        r"sözleşme (?:numarası|no)"),
    ("policy_number", r"versicherungs[- ]?(?:schein[- ]?)?(?:nummer|nr\.?)|policen?[- ]?(?:nummer|nr\.?)|policy (?:number|no\.?)|"
                      r"numéro de police|número de póliza|n\.º de póliza|numero polizza|poliçe (?:numarası|no)"),
    ("tax_number", r"steuer[- ]?(?:nummer|nr\.?)|steuer-id|steuerliche identifikationsnummer|tax (?:id|number)|"
                   r"numéro fiscal|n[°º]\.? ?fiscal|nif\b|número de identificación fiscal|codice fiscale|partita iva|"
                   r"vergi (?:kimlik )?(?:numarası|no)"),
    ("file_number", r"aktenzeichen|az\.|geschäftszeichen|unser zeichen|kassenzeichen|file (?:number|no\.?)|our ref(?:erence)?\.?|"
                    r"case (?:number|no\.?)|claim (?:number|no\.?)|numéro de dossier|n[°º]\.? ?de dossier|"
                    r"número de expediente|n\.º de expediente|numero pratica|numero di pratica|dosya (?:numarası|no)"),
    ("member_number", r"mitglieds[- ]?(?:nummer|nr\.?)|versichertennummer|member(?:ship)? (?:number|no\.?)|"
                      r"numéro d[’']adhérent|número de socio|número de afiliado|numero socio|üye (?:numarası|no)"),
    ("employee_number", r"personal[- ]?(?:nummer|nr\.?)|employee (?:number|no\.?|id)|matricule|número de empleado|"
                        r"matricola|sicil (?:numarası|no)"),
    ("mandate_reference", r"mandatsreferenz|mandate reference|référence unique de mandat|referencia del mandato|"
                          r"riferimento mandato"),
    ("reference", r"referenz(?:nummer)?|reference(?: number)?|ref\.?|vorgangs[- ]?(?:nummer|nr\.?)|bestell[- ]?(?:nummer|nr\.?)|"
                  r"order (?:number|no\.?)|confirmation (?:number|code)|tracking (?:number|no\.?)|"
                  r"votre référence|notre référence|référence|su referencia|nuestra referencia|referencia|"
                  r"vostro riferimento|nostro riferimento|riferimento|referans(?: numarası| no)?|"
                  r"numéro de commande|número de pedido|numero ordine|sipariş (?:numarası|no)"),
]

# ---------------------------------------------------------------------------------------------------------------
# Signs of a scam (document_checks). Fragments are for all languages together.
SCAM = {
    "authority": {
        # (country of the authority, words)
        "DE": r"finanzamt|finanzkasse|stadtkasse|kreiskasse|bußgeldstelle|bussgeldstelle|agentur für arbeit|jobcenter|"
              r"bundes\w+|landes\w+amt|amtsgericht|landgericht|gericht|hauptzollamt|zollamt|polizei\w*|rentenversicherung|"
              r"familienkasse|beitragsservice|ordnungsamt|bürgeramt|ausländerbehörde|staatsanwaltschaft",
        "FR": rf"trésor public|dgfip|direction générale des finances|impôts\.gouv|tribunal|gendarmerie|police nationale|urssaf|"
              rf"caisse d{_A}allocations|france travail|pôle emploi|préfecture|ants\b|amende\.gouv|assurance maladie|"
              rf"huissier|commissaire de justice",
        "ES": r"agencia tributaria|hacienda|seguridad social|policía nacional|guardia civil|juzgado|\bdgt\b|ayuntamiento|"
              r"sepe\b|fiscalía|tribunal",
        "IT": r"agenzia delle entrate|agenzia delle entrate-riscossione|guardia di finanza|carabinieri|polizia|tribunale|"
              r"\binps\b|\binail\b|comune di|questura|procura",
        "TR": r"vergi dairesi|\bsgk\b|emniyet|icra müdürlüğü|mahkeme|savcılık|belediye|gelir idaresi|\bptt\b|jandarma",
        "GB": r"\bhmrc\b|hm revenue|\bdvla\b|\bdwp\b|national insurance|tv licensing|council tax|\bnhs\b|"
              r"hm courts|metropolitan police",
        "US": r"\birs\b|internal revenue service|social security administration|\bssa\b|\bdmv\b|\bfbi\b|\bmedicare\b|"
              r"u\.?s\.? marshals|\bfbi\b|department of justice|u\.?s\.? customs",
    },
    "voucher": r"paysafecard\w*|gutschein\w*|guthabenkarte\w*|google[- ]play[- ]karte\w*|itunes|apple[- ]gift|steam[- ]karte\w*|"
               r"amazon[- ]gutschein\w*|bitcoin\w*|krypto\w*|crypto\w*|western union|moneygram|gift ?cards?|"
               r"cartes? cadeaux?|transcash|neosurf|tarjetas? (?:de )?regalo|buono regalo|carta regalo|ricarica postepay|"
               r"hediye (?:kartı|çeki)|zelle|venmo|cash ?app|wire transfer",
    "pay_words": r"zahl\w*|bezahl\w*|überweis\w*|gebühr\w*|begleich\w*|pay\w*|fee|"
                 r"payer|paiement|régler|frais|pagar|pago|abonar|tasa|gastos|pagare|pagamento|versare|spese|"
                 r"öde\w*|ücret|harç",
    "urgency": r"innerhalb (?:von )?(?:12|24|48|72) stunden|within (?:12|24|48|72) hours|\bheute noch\b|"
               r"\bletzte (?:chance|möglichkeit)\b|\bsofort\b|"
               r"dans les (?:12|24|48|72) heures|sous (?:24|48|72) ?h|dernière chance|aujourd[’']hui même|"
               r"en las próximas (?:12|24|48|72) horas|dentro de (?:12|24|48|72) horas|última oportunidad|hoy mismo|"
               r"entro (?:12|24|48|72) ore|ultima possibilità|oggi stesso|"
               r"(?:12|24|48|72) saat içinde|son şans|bugün içinde|"
               r"act now|last chance|immediately",
    "arrest": r"haftbefehl\w*|verhaft\w*|festnahme|gefängnis|anzeige bei der polizei|strafanzeige|"
              rf"mandat d{_A}arrêt|arrestation|garde à vue|poursuites pénales|prison|"
              r"orden de arresto|detención|cárcel|prisión|denuncia penal|"
              r"mandato di arresto|arresto|carcere|denuncia penale|"
              r"tutuklama|gözaltı|hapis|yakalama kararı|suç duyurusu|"
              r"arrest warrant|warrant for your arrest|jail|criminal charges",
    "advance_fee": r"gewonnen|gewinn\w*|erbschaft|lotterie|preisgeld|won|prize|inheritance|"
                   r"gagné|gagnant|héritage|loterie|ganado|ganador|herencia|lotería|sorteo|vinto|vincitore|eredità|lotteria|"
                   r"kazandınız|miras|piyango|çekiliş",
    "fee": r"bearbeitungsgebühr|gebühr\w*|vorab|freischalt\w*|fee|"
           r"frais|à l[’']avance|débloquer|gastos de gestión|tasa|por adelantado|desbloquear|"
           r"spese di pratica|commissione|anticipo|sbloccare|işlem ücreti|masraf|ön ödeme|peşin|harç",
    "secrecy": r"vertraulich|niemandem|geheim|confidential|confidentiel|ne le dites à personne|secret|confidencial|"
               r"no se lo diga a nadie|secreto|riservato|non dirlo a nessuno|segreto|gizli|kimseye söylemeyin",
    "account_change": r"neue\w* (?:bankverbindung|konto|kontoverbindung)|kontowechsel|hausbank gewechselt|"
                      r"(?:bankverbindung|kontoverbindung) (?:hat sich )?geändert|geänderte\w* (?:bankverbindung|kontoverbindung)|"
                      r"new bank (?:details|account)|updated bank details|changed (?:our )?bank|"
                      r"nouvelles? coordonnées bancaires|nouveau (?:compte|rib)|changement de (?:compte|rib|banque)|nouvel iban|"
                      r"nueva cuenta|nuevos datos bancarios|cambio de cuenta|nuevo iban|"
                      r"nuove coordinate bancarie|nuovo conto|nuovo iban|variazione (?:delle )?coordinate|"
                      r"yeni (?:hesap|iban|banka)|banka bilgilerimiz değişti|hesap değişikliği",
    # text that speaks to an AI instead of to the reader
    "ai_to": r"(?:hinweis|hinweise|anweisung|anweisungen|nachricht|note|notes|instruction|instructions|message|"
             r"instrucciones?|istruzioni|talimat\w*|not)\s+"
             r"(?:für|an|for|to|pour|à|para|per|a)\s+(?:alle\s+|all\s+|les\s+|las\s+|le\s+)?(?:digitale\w*\s+)?"
             r"(?:ki|ai|ia|assistent\w*|assistant\w*|asistente\w*|assistente\w*|chatbot\w*|sprachmodell\w*|language model\w*|"
             r"llm\w*|yapay zeka\w*)"
             r"|yapay zeka\s+(?:asistan\w*|model\w*)\s+için\s+(?:not|talimat\w*)",
    "ignore_instructions": r"\b(?:ignore|disregard) (?:all |any )?(?:previous|prior|above) (?:instructions|rules)"
                           r"|\bignorier\w* (?:alle |sämtliche )?(?:vorherigen|bisherigen|obigen) (?:anweisungen|regeln)"
                           r"|\bignor(?:ez|a|e) (?:toutes? )?(?:les )?(?:instructions?|consignes?) (?:précédentes|ci-dessus)"
                           r"|\bignor(?:a|e) (?:todas )?(?:las )?instrucciones anteriores"
                           r"|\bignora (?:tutte )?(?:le )?istruzioni precedenti"
                           r"|\bönceki (?:tüm )?(?:talimatları|yönergeleri) (?:yoksay|görmezden gel)\w*",
}
