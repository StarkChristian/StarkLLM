"""The labelled retrieval eval set (StarkLLM 2.7, option 4): one folder PDF per language and questions with the page
that answers them.

Page 1 of each folder is the language's test letter (backend/tests/fixtures/letters); pages 2-6 are the documents a
household keeps next to it (tenancy, car insurance, a doctor's appointment, an internet contract, a payslip), written
for this eval so that they share vocabulary on purpose: amounts, dates, "monthly", "notice", "contract" appear on
several pages, so a passage has to be chosen by meaning, not by one shared word. All folders, the English invoice and
the other fixtures (tests/fixtures/msi) go into ONE workspace, so letters of the other languages compete as well.

The questions paraphrase the page instead of copying it ("Can I have breakfast before my heart test?" for "do not eat
for twelve hours"). Two questions per language have no answer in any document ("unanswerable"): one near a real
document (household contents insurance next to the car insurance) and one far from all of them (passport). They
calibrate the "no good source" threshold (source_quality.py).
"""

LETTERS = {"de": "de_ch_rechnung.txt", "en": "en_gb_reminder.txt", "fr": "fr_facture.txt", "es": "es_factura.txt",
           "it": "it_fattura.txt", "tr": "tr_fatura.txt"}
FOLDERS = {"de": "de_unterlagen.pdf", "en": "en_documents.pdf", "fr": "fr_documents.pdf", "es": "es_documentos.pdf",
           "it": "it_documenti.pdf", "tr": "tr_belgeler.pdf"}
# also in the workspace, as competition: (folder under tests/fixtures, file)
EXTRA_FILES = [("letters", "en_us_invoice.txt"), ("msi", "tax_letter_de.txt"), ("msi", "scam_letter.txt"),
               ("msi", "invoice_en_gbp.txt"), ("msi", "suppliers.csv"), ("msi", "app.log")]

PAGES = {
    "de": [
        None,  # page 1: the letter
        """Mietvertrag über Wohnraum
Vermieterin: Hausverwaltung Sonnenhof GmbH, Lindenstraße 8, 50674 Köln
Mieterin: Anna Beispiel
Mietobjekt: 3-Zimmer-Wohnung, 2. OG links, Lindenstraße 8, 50674 Köln, ca. 78 m²
§ 3 Miete: Die monatliche Grundmiete (Kaltmiete) beträgt 950,00 EUR. Hinzu kommt eine Vorauszahlung auf die Betriebskosten von 180,00 EUR monatlich. Die Miete ist bis zum dritten Werktag eines Monats im Voraus zu zahlen.
§ 4 Kaution: Die Mieterin leistet eine Mietsicherheit in Höhe von drei Monatskaltmieten, also 2.850,00 EUR.
§ 9 Kündigung: Die Kündigungsfrist für die Mieterin beträgt drei Monate zum Monatsende. Die Kündigung bedarf der Schriftform.
§ 11 Tierhaltung: Hunde und Katzen dürfen nur mit vorheriger schriftlicher Zustimmung der Vermieterin gehalten werden.""",
        """Versicherungsschein Kfz-Versicherung
Rheinland Assekuranz AG, Policennummer KV-2026-55120
Fahrzeug: VW Golf, amtliches Kennzeichen K-AB 1234
Versicherungsbeginn: 01.01.2026, Laufzeit ein Jahr mit stillschweigender Verlängerung
Jahresbeitrag: 612,40 EUR, zahlbar vierteljährlich zu je 153,10 EUR
Haftpflicht: Deckungssumme 100 Mio. EUR pauschal
Vollkasko mit Selbstbeteiligung von 300,00 EUR, Teilkasko mit Selbstbeteiligung von 150,00 EUR
Schadenfreiheitsklasse SF 7
Schadenmeldung rund um die Uhr unter 0800 123 45 67.""",
        """Kardiologische Praxis Dr. med. Petra Hoffmann
Termin zur Belastungs-EKG- und Herzultraschall-Untersuchung
Sehr geehrte Frau Beispiel, Ihr Termin ist am Freitag, 8. Januar 2027, um 8:15 Uhr.
Bitte erscheinen Sie nüchtern: zwölf Stunden vor der Untersuchung nichts essen, Wasser und ungesüßter Tee sind erlaubt.
Bringen Sie Ihre Versichertenkarte, die Überweisung Ihres Hausarztes und eine Liste Ihrer Medikamente mit.
Sportkleidung und bequeme Schuhe sind für das Belastungs-EKG erforderlich.
Absagen bitte mindestens 24 Stunden vorher, sonst berechnen wir eine Ausfallgebühr von 40 EUR.""",
        """Auftragsbestätigung Internet und Festnetz
Netzwelt Telekom GmbH, Vertragsnummer NW-88213
Tarif: Glasfaser 250, Download bis 250 Mbit/s, Upload bis 50 Mbit/s
Monatlicher Grundpreis: 39,99 EUR, in den ersten sechs Monaten 19,99 EUR
Routermiete: 4,99 EUR pro Monat
Mindestvertragslaufzeit: 24 Monate ab Freischaltung am 14.10.2026
Danach verlängert sich der Vertrag auf unbestimmte Zeit und ist monatlich kündbar.
Einmaliger Bereitstellungspreis: 69,99 EUR.""",
        """Entgeltabrechnung November 2026
Arbeitgeber: Brückner Logistik GmbH, Personalnummer 20417
Steuerklasse I, Kirchensteuer: keine
Bruttogehalt: 3.850,00 EUR
Lohnsteuer: 512,33 EUR, Solidaritätszuschlag: 0,00 EUR
Sozialversicherungsbeiträge gesamt: 824,90 EUR
Nettoverdienst: 2.512,77 EUR, Auszahlung am 30.11.2026
Urlaubsanspruch 2026: 28 Tage, genommen: 17 Tage, Resturlaub: 11 Tage
Überstundenkonto: 6,5 Stunden.""",
    ],
    "en": [
        None,
        """Assured Shorthold Tenancy Agreement
Landlord: Northgate Lettings Ltd, 8 Linden Street, Leeds LS2 7HT
Tenant: John Smith
Property: two-bedroom flat, Flat 4, 8 Linden Street, Leeds LS2 7HT
Clause 3 Rent: The rent is £950.00 per calendar month, payable in advance on the first day of each month. Council tax and utilities are paid by the tenant.
Clause 4 Deposit: The tenant pays a deposit of £1,096.00, protected with the Deposit Protection Service.
Clause 9 Ending the tenancy: After the fixed term of twelve months, the tenant may end the tenancy by giving at least one month's written notice, ending on the last day of a rental period.
Clause 11 Pets: No pets may be kept without the landlord's prior written consent.""",
        """Motor Insurance Certificate and Schedule
Thamesbridge Insurance plc, policy number MTR-2026-55120
Vehicle: Ford Focus, registration LS21 ABC
Period of cover: 1 January 2026 to 31 December 2026
Annual premium: £612.40, paid by ten monthly instalments of £61.24
Cover: comprehensive
Compulsory excess £250 and voluntary excess £150 for accidental damage claims; windscreen claims have an excess of £95
No claims discount: 7 years
To report a claim call 0800 123 4567, open 24 hours.""",
        """Leeds Heart Clinic, Department of Cardiology
Appointment letter
Dear Mr Smith, your exercise ECG and heart ultrasound are booked for Friday 8 January 2027 at 8:15 am.
Please do not eat for twelve hours before the test; you may drink water.
Bring your NHS number, your GP referral letter and a list of the medicines you take.
Wear comfortable clothes and trainers for the exercise test.
If you cannot attend, please tell us at least 24 hours in advance so the slot can be offered to another patient.""",
        """Order confirmation: Fibre broadband and landline
Linkwave Communications, contract reference LW-88213
Package: Full Fibre 250, average download speed 250 Mb, upload 50 Mb
Monthly price: £39.99, £19.99 for the first six months
Router rental: £4.99 per month
Minimum term: 24 months from activation on 14 October 2026
After the minimum term the contract runs month to month and can be cancelled with 30 days' notice.
One-off set-up fee: £69.99.""",
        """Payslip November 2026
Employer: Bruckner Logistics Ltd, employee number 20417
Tax code 1257L, NI category A
Gross pay: £3,850.00
Income tax: £512.33, National Insurance: £235.10, pension contribution: £154.00
Net pay: £2,948.57, paid on 30 November 2026
Holiday entitlement 2026: 28 days, taken: 17 days, remaining: 11 days
Overtime balance: 6.5 hours.""",
    ],
    "fr": [
        None,
        """Contrat de location (bail d'habitation)
Bailleur : SCI Les Tilleuls, 8 rue des Tilleuls, 69006 Lyon
Locataire : Anna Exemple
Logement : appartement de trois pièces, 2e étage, 78 m²
Article 3 – Loyer : le loyer mensuel hors charges est de 950,00 €, auquel s'ajoute une provision pour charges de 180,00 € par mois, payable d'avance le 5 de chaque mois.
Article 4 – Dépôt de garantie : le locataire verse un dépôt de garantie de 950,00 €, soit un mois de loyer hors charges.
Article 9 – Congé : le locataire peut donner congé à tout moment avec un préavis de trois mois, réduit à un mois en zone tendue, par lettre recommandée.
Article 11 – Animaux : la détention d'animaux domestiques est autorisée s'ils ne causent aucun trouble.""",
        """Conditions particulières – Assurance automobile
Assurances du Rhône SA, contrat n° AUTO-2026-55120
Véhicule : Peugeot 308, immatriculation AB-123-CD
Date d'effet : 1er janvier 2026, contrat annuel à tacite reconduction
Cotisation annuelle : 612,40 €, payable par prélèvement trimestriel de 153,10 €
Formule tous risques
Franchise dommages tous accidents : 300 € ; franchise bris de glace : 75 €
Coefficient de bonus-malus : 0,68
Déclaration de sinistre 24 h/24 au 09 70 12 34 56.""",
        """Cabinet de cardiologie du Dr Marie Laurent
Convocation
Madame, votre épreuve d'effort et votre échographie cardiaque sont prévues le vendredi 8 janvier 2027 à 8 h 15.
Merci de venir à jeun : ne rien manger pendant les douze heures qui précèdent l'examen ; l'eau est autorisée.
Apportez votre carte Vitale, la lettre de votre médecin traitant et la liste de vos médicaments.
Prévoyez une tenue de sport et des baskets pour l'épreuve d'effort.
Toute annulation doit être signalée au moins 24 heures à l'avance.""",
        """Confirmation de commande – Box fibre et téléphone fixe
Lienfibre Télécom, référence client LF-88213
Offre : Fibre 250, débit descendant jusqu'à 250 Mbit/s, montant 50 Mbit/s
Prix mensuel : 19,99 € pendant six mois, puis 39,99 €
Location de la box : 4,99 € par mois
Engagement : 24 mois à compter de l'activation le 14 octobre 2026
Résiliation en cours d'engagement : frais égaux aux mensualités restantes
Frais de mise en service : 69,99 €.""",
        """Bulletin de paie – novembre 2026
Employeur : Bruckner Logistique SARL, matricule 20417
Salaire brut : 3 850,00 €
Cotisations salariales : 852,40 €
Prélèvement à la source (taux 7,5 %) : 224,82 €
Net à payer : 2 772,78 €, versé le 30 novembre 2026
Congés payés : acquis 25 jours, pris 14 jours, solde 11 jours
Heures supplémentaires : 6,5 heures.""",
    ],
    "es": [
        None,
        """Contrato de arrendamiento de vivienda
Arrendador: Inmobiliaria Los Tilos S.L., Calle de los Tilos 8, 28014 Madrid
Arrendataria: Ana Ejemplo
Vivienda: piso de tres habitaciones, 2.º izquierda, 78 m²
Cláusula tercera – Renta: la renta mensual es de 950,00 €, que se abonará por adelantado dentro de los siete primeros días de cada mes. Los gastos de comunidad están incluidos.
Cláusula cuarta – Fianza: la arrendataria entrega una fianza de 1.900,00 €, equivalente a dos mensualidades.
Cláusula novena – Desistimiento: transcurridos seis meses, la arrendataria podrá desistir del contrato comunicándolo por escrito con al menos treinta días de antelación.
Cláusula undécima – Mascotas: se permite tener animales de compañía previa autorización escrita del arrendador.""",
        """Condiciones particulares – Seguro de automóvil
Seguros Ibéricos S.A., póliza n.º AUT-2026-55120
Vehículo: Seat León, matrícula 1234 ABC
Efecto: 1 de enero de 2026, duración anual prorrogable
Prima anual: 612,40 €, fraccionada en pagos trimestrales de 153,10 €
Modalidad: todo riesgo con franquicia
Franquicia por daños propios: 300 € por siniestro; lunas sin franquicia
Asistencia en carretera y partes de siniestro 24 horas: 900 123 456.""",
        """Consulta de Cardiología Dra. Lucía Martín
Citación
Estimada señora Ejemplo: su prueba de esfuerzo y su ecocardiograma están programados para el viernes 8 de enero de 2027 a las 8:15.
Debe acudir en ayunas: no coma nada durante las doce horas anteriores a la prueba; puede beber agua.
Traiga su tarjeta sanitaria, el volante de su médico de cabecera y la lista de los medicamentos que toma.
Lleve ropa y calzado deportivo para la prueba de esfuerzo.
Si no puede acudir, avísenos con al menos 24 horas de antelación.""",
        """Confirmación de pedido – Fibra y teléfono fijo
Enlace Telecom S.A., número de contrato ET-88213
Tarifa: Fibra 250, velocidad de bajada hasta 250 Mb, subida 50 Mb
Cuota mensual: 39,99 €; durante los seis primeros meses 19,99 €
Alquiler del router: 4,99 € al mes
Permanencia: 24 meses desde la activación el 14 de octubre de 2026
Si se da de baja antes, se cobrará la parte proporcional de la penalización de 120 €.
Alta e instalación: 69,99 €.""",
        """Nómina de noviembre de 2026
Empresa: Bruckner Logística S.L., n.º de empleado 20417
Salario bruto: 3.850,00 €
Retención IRPF (15 %): 577,50 €
Cotización a la Seguridad Social: 249,48 €
Líquido a percibir: 3.023,02 €, abonado el 30 de noviembre de 2026
Vacaciones 2026: 23 días laborables, disfrutados 12, pendientes 11
Horas extraordinarias: 6,5 horas.""",
    ],
    "it": [
        None,
        """Contratto di locazione ad uso abitativo
Locatore: Immobiliare I Tigli S.r.l., Via dei Tigli 8, 20121 Milano
Conduttrice: Anna Esempio
Immobile: appartamento di tre locali, secondo piano, 78 m²
Art. 3 – Canone: il canone mensile è di 950,00 €, oltre a 180,00 € al mese di spese condominiali, da versare entro il giorno 5 di ogni mese.
Art. 4 – Deposito cauzionale: la conduttrice versa un deposito cauzionale di 2.850,00 €, pari a tre mensilità.
Art. 9 – Recesso: la conduttrice può recedere in qualsiasi momento con preavviso di sei mesi mediante lettera raccomandata.
Art. 11 – Animali: è consentito tenere animali domestici che non arrechino disturbo.""",
        """Polizza di assicurazione auto (RC Auto e Kasko)
Assicurazioni Padane S.p.A., polizza n. AUTO-2026-55120
Veicolo: Fiat Tipo, targa AB123CD
Decorrenza: 1° gennaio 2026, durata annuale senza tacito rinnovo
Premio annuo: 612,40 €, pagabile in due rate semestrali da 306,20 €
Garanzia Kasko con scoperto del 10 % e minimo di 300 € per sinistro
Classe di merito: 1
Denuncia di sinistro e soccorso stradale 24 ore su 24: 800 123 456.""",
        """Studio di Cardiologia Dott.ssa Giulia Ferri
Promemoria appuntamento
Gentile signora Esempio, la sua prova da sforzo e l'ecocardiogramma sono fissati per venerdì 8 gennaio 2027 alle ore 8:15.
Si presenti a digiuno: non mangi nulla nelle dodici ore precedenti l'esame; può bere acqua.
Porti la tessera sanitaria, l'impegnativa del medico di base e l'elenco dei farmaci che assume.
Indossi abiti comodi e scarpe da ginnastica per la prova da sforzo.
In caso di disdetta, la preghiamo di avvisarci almeno 24 ore prima.""",
        """Conferma d'ordine – Fibra e telefono fisso
Connessa Telecomunicazioni S.p.A., codice contratto CT-88213
Offerta: Fibra 250, velocità in download fino a 250 Mbit/s, in upload 50 Mbit/s
Canone mensile: 39,99 €, per i primi sei mesi 19,99 €
Noleggio modem: 4,99 € al mese
Vincolo contrattuale: 24 mesi dall'attivazione del 14 ottobre 2026
In caso di recesso anticipato è dovuto il costo di disattivazione di 29,99 €.
Contributo di attivazione: 69,99 €.""",
        """Busta paga – novembre 2026
Datore di lavoro: Bruckner Logistica S.r.l., matricola 20417
Retribuzione lorda: 3.850,00 €
Contributi previdenziali INPS: 353,43 €
IRPEF netta: 812,65 €
Netto in busta: 2.683,92 €, accreditato il 30 novembre 2026
Ferie: maturate 26 giorni, godute 15, residue 11
Straordinari: 6,5 ore.""",
    ],
    "tr": [
        None,
        """Konut Kira Sözleşmesi
Kiraya veren: Ihlamur Emlak Ltd. Şti., Ihlamur Sokak 8, 06680 Ankara
Kiracı: Ayşe Örnek
Kiralanan: 3+1 daire, 2. kat, 78 m²
Madde 3 – Kira bedeli: Aylık kira bedeli 18.500,00 TL olup her ayın 5'ine kadar peşin ödenir. Aidat kiracıya aittir.
Madde 4 – Depozito: Kiracı, iki aylık kira tutarında 37.000,00 TL güvence bedeli öder.
Madde 9 – Fesih: Kiracı, sözleşmeyi en az otuz gün önceden yazılı bildirimde bulunarak feshedebilir.
Madde 11 – Evcil hayvan: Evcil hayvan beslemek kiraya verenin yazılı iznine bağlıdır.""",
        """Kasko Sigorta Poliçesi
Anadolu Güven Sigorta A.Ş., poliçe no KSK-2026-55120
Araç: Renault Clio, plaka 06 ABC 123
Başlangıç: 01.01.2026, süre bir yıl
Yıllık prim: 24.600,00 TL, dört taksitte 6.150,00 TL
Muafiyet: her hasarda 5.000 TL sigortalıya aittir
Hasarsızlık indirimi: %30
Hasar ihbarı ve yol yardımı 7/24: 0850 123 45 67.""",
        """Özel Kardiyoloji Muayenehanesi – Dr. Elif Demir
Randevu bildirimi
Sayın Ayşe Örnek, efor testiniz ve kalp ultrasonunuz 8 Ocak 2027 Cuma günü saat 08:15'te yapılacaktır.
Lütfen aç gelin: tetkikten önceki on iki saat boyunca hiçbir şey yemeyin; su içebilirsiniz.
Kimlik kartınızı, aile hekiminizin sevk belgesini ve kullandığınız ilaçların listesini getirin.
Efor testi için rahat kıyafet ve spor ayakkabı giyin.
Gelemeyecekseniz en az 24 saat önceden haber verin.""",
        """Abonelik Onayı – Fiber İnternet ve Ev Telefonu
Bağlantı Telekom A.Ş., abone no BT-88213
Tarife: Fiber 250, indirme hızı 250 Mbps'ye kadar, yükleme 50 Mbps
Aylık ücret: 499,90 TL, ilk altı ay 299,90 TL
Modem kirası: aylık 49,90 TL
Taahhüt süresi: 14 Ekim 2026 aktivasyon tarihinden itibaren 24 ay
Taahhüt bitmeden iptal edilirse sağlanan indirimler geri alınır.
Kurulum ücreti: 699,00 TL.""",
        """Ücret Bordrosu – Kasım 2026
İşveren: Bruckner Lojistik A.Ş., sicil no 20417
Brüt ücret: 85.000,00 TL
SGK işçi payı: 11.900,00 TL, işsizlik sigortası: 850,00 TL
Gelir vergisi: 10.837,50 TL, damga vergisi: 645,15 TL
Net ödenen: 60.767,35 TL, 30 Kasım 2026 tarihinde ödendi
Yıllık izin hakkı: 20 gün, kullanılan: 9 gün, kalan: 11 gün
Fazla mesai: 6,5 saat.""",
    ],
}

# (id, question, page of the language's folder that answers it; None = no document answers it)
QUESTIONS = {
    "de": [
        ("D1", "Bis wann muss die Stromrechnung bezahlt sein?", 1),
        ("D2", "Was kostet es mich, wenn ich die Rechnung zu spät begleiche?", 1),
        ("D3", "Wie viel Kaution musste ich für die Wohnung hinterlegen?", 2),
        ("D4", "Mit welcher Frist kann ich meine Wohnung kündigen?", 2),
        ("D5", "Wie viel zahle ich selbst, wenn mein Auto einen Vollkaskoschaden hat?", 3),
        ("D6", "Darf ich vor der Herzuntersuchung frühstücken?", 4),
        ("D7", "Wie lange bin ich an den Glasfaservertrag gebunden?", 5),
        ("D8", "Wie viele Urlaubstage stehen mir noch zu?", 6),
        ("DU1", "Wie hoch ist der Beitrag meiner Hausratversicherung?", None),
        ("DU2", "Wann läuft mein Reisepass ab?", None),
    ],
    "en": [
        ("E1", "What's the latest date I can pay the outstanding energy bill?", 1),
        ("E2", "When is someone coming to read my meter?", 1),
        ("E3", "How much was the security deposit for the flat?", 2),
        ("E4", "How much notice do I have to give to move out of my flat?", 2),
        ("E5", "How much would I have to pay myself if I crashed my car?", 3),
        ("E6", "Can I have breakfast before my heart test?", 4),
        ("E7", "How long am I tied into the broadband deal?", 5),
        ("E8", "How many days off do I have left this year?", 6),
        ("EU1", "How much is my home contents insurance premium?", None),
        ("EU2", "When does my passport expire?", None),
    ],
    "fr": [
        ("F1", "Quelle est la date limite pour régler la facture d'électricité ?", 1),
        ("F2", "Quand le technicien doit-il passer ?", 1),
        ("F3", "Combien ai-je versé comme dépôt de garantie pour l'appartement ?", 2),
        ("F4", "Combien de temps à l'avance dois-je prévenir si je quitte mon logement ?", 2),
        ("F5", "Combien reste à ma charge si ma voiture est endommagée dans un accident ?", 3),
        ("F6", "Puis-je prendre un petit-déjeuner avant l'examen du cœur ?", 4),
        ("F7", "Pendant combien de temps suis-je engagé avec ma box internet ?", 5),
        ("F8", "Combien de jours de congés me reste-t-il ?", 6),
        ("FU1", "Quel est le montant de mon assurance habitation ?", None),
        ("FU2", "Quand mon passeport expire-t-il ?", None),
    ],
    "es": [
        ("S1", "¿Hasta cuándo tengo para pagar la factura de la luz?", 1),
        ("S2", "¿Qué día viene el técnico a casa?", 1),
        ("S3", "¿Cuánto dejé de fianza por el piso?", 2),
        ("S4", "¿Con cuánta antelación tengo que avisar si quiero dejar el piso?", 2),
        ("S5", "¿Cuánto me toca pagar a mí si tengo un golpe con el coche?", 3),
        ("S6", "¿Puedo desayunar antes de la prueba del corazón?", 4),
        ("S7", "¿Cuánto tiempo de permanencia tiene mi contrato de fibra?", 5),
        ("S8", "¿Cuántos días de vacaciones me quedan?", 6),
        ("SU1", "¿Cuánto pago por el seguro de hogar?", None),
        ("SU2", "¿Cuándo caduca mi pasaporte?", None),
    ],
    "it": [
        ("I1", "Entro quando devo pagare la bolletta della luce?", 1),
        ("I2", "A che ora arriva il tecnico?", 1),
        ("I3", "Quanto ho versato di deposito cauzionale per l'appartamento?", 2),
        ("I4", "Con quanto preavviso posso lasciare la casa in affitto?", 2),
        ("I5", "Quanto resta a mio carico se faccio un incidente con la macchina?", 3),
        ("I6", "Posso fare colazione prima della visita al cuore?", 4),
        ("I7", "Per quanto tempo sono vincolato con la fibra?", 5),
        ("I8", "Quanti giorni di ferie mi rimangono?", 6),
        ("IU1", "Quanto pago per l'assicurazione della casa?", None),
        ("IU2", "Quando scade il mio passaporto?", None),
    ],
    "tr": [
        ("T1", "Elektrik faturasını en geç ne zaman ödemem gerekiyor?", 1),
        ("T2", "Teknisyen hangi gün ve saatte geliyor?", 1),
        ("T3", "Ev için ne kadar depozito verdim?", 2),
        ("T4", "Evden çıkmak istersem kaç gün önceden haber vermeliyim?", 2),
        ("T5", "Arabam hasar görürse cebimden ne kadar çıkar?", 3),
        ("T6", "Kalp tetkikinden önce kahvaltı yapabilir miyim?", 4),
        ("T7", "İnternet aboneliğimin taahhüdü ne kadar sürüyor?", 5),
        ("T8", "Kaç gün yıllık iznim kaldı?", 6),
        ("TU1", "Konut sigortası primim ne kadar?", None),
        ("TU2", "Pasaportumun süresi ne zaman doluyor?", None),
    ],
}
