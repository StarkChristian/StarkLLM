"""Many generated letters with known dates and amounts: a benchmark for the date finder (dates_service).

Real letters say the same thing in many ways: "bis zum 15.12.2026", "Zahlungsziel: 15.12.2026", "spätestens am
15. Dezember 2026", "bis 15.12." (no year), amounts as "1.234,56 EUR", "€ 412,00", "412,- €". Each generated letter
carries what a correct reader finds in it (EXPECTED) and what it must not report (dates that are not something to do,
like the date of the letter or a birthday). Fully deterministic (seeded), German and English.

    python3 -m scenarios.letters            # in backend/: prints recall, precision and amount accuracy
"""
import random
from datetime import date, timedelta
from typing import Dict, List

MONTHS_DE = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober",
             "November", "Dezember"]
MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October",
             "November", "December"]

SENDERS = ["Stadtwerke Neckartal", "Rhein-Main Versicherung AG", "Finanzamt Oststadt", "Hausverwaltung Lindner GmbH",
           "Telekomm Plus GmbH", "Krankenkasse Südwest", "Autohaus Berger KG", "Zahnarztpraxis Dr. Ilić",
           "Volkshochschule Talstadt", "Bürgeramt Weststadt", "Kita Sonnenblume e.V.", "Fitnessclub Aktiv"]


def fmt_date_de(d: date, style: int) -> str:
    return [f"{d:%d.%m.%Y}", f"{d.day}. {MONTHS_DE[d.month - 1]} {d.year}", f"{d:%d.%m.%y}", f"{d.day}.{d.month}.{d.year}",
            f"{d:%d.%m.%Y}"][style]


def fmt_amount_de(cents: int, style: int) -> str:
    euros, c = divmod(cents, 100)
    num = f"{euros:,}".replace(",", ".") + f",{c:02d}"
    return [f"{num} EUR", f"{num} €", f"€ {num}", f"EUR {num}", f"{num} Euro"][style]


def amount_key(cents: int) -> str:
    euros, c = divmod(cents, 100)
    return f"{euros:,}".replace(",", ".") + f",{c:02d}"


def generate(n: int = 120, seed: int = 2026, today: date = date(2026, 11, 10)) -> List[Dict]:
    """Letters {"id", "lang", "text", "expected": [{date, kind, amount, time}], "unwanted": [date]}."""
    rnd = random.Random(seed)
    letters = []
    for i in range(n):
        sender = rnd.choice(SENDERS)
        written = today - timedelta(days=rnd.randint(1, 20))
        due = today + timedelta(days=rnd.randint(3, 120))
        cents = rnd.choice([rnd.randint(500, 9999), rnd.randint(10000, 250000)])
        ds = rnd.randint(0, 4)
        am = rnd.randint(0, 4)
        kind = rnd.choice(["invoice", "invoice_label", "reminder", "change", "appointment", "cancel_confirm",
                           "notice", "debit", "english_invoice", "english_appointment", "no_year", "birthday_noise"])
        head = f"{sender}\nMusterstraße {rnd.randint(1, 99)}, {rnd.randint(10000, 99999)} Musterstadt\n\nAnna Beispiel\n" \
               f"Gartenweg 5\n{rnd.randint(10000, 99999)} Musterstadt\n\nDatum: {written:%d.%m.%Y}\n" \
               f"Kundennummer: {rnd.randint(100000, 999999)}\n\n"
        expected, unwanted = [], [written.isoformat()]
        a = fmt_amount_de(cents, am)
        d = fmt_date_de(due, ds)
        if kind == "invoice":
            body = (f"Rechnung Nr. {rnd.randint(1000, 9999)}\n\nSehr geehrte Frau Beispiel,\nfür unsere Leistungen im "
                    f"{MONTHS_DE[written.month - 1]} berechnen wir Ihnen {a}.\n"
                    + rnd.choice([f"Bitte überweisen Sie den Betrag bis zum {d}.",
                                  f"Der Betrag ist zahlbar bis {d}.",
                                  f"Bitte zahlen Sie spätestens am {d}."]))
            expected.append({"date": due.isoformat(), "kind": "deadline", "amount": amount_key(cents)})
        elif kind == "invoice_label":
            body = (f"Rechnung\n\nRechnungsbetrag: {a}\nZahlungsziel: {d}\nBankverbindung: IBAN DE02 1203 0000 0000 2020 51\n\n"
                    f"Vielen Dank für Ihren Auftrag.")
            expected.append({"date": due.isoformat(), "kind": "deadline", "amount": amount_key(cents)})
        elif kind == "reminder":
            fee = rnd.choice([250, 500, 1000])
            body = (f"1. Mahnung\n\nleider haben wir für die Rechnung vom {written - timedelta(days=30):%d.%m.%Y} über {a} noch "
                    f"keinen Zahlungseingang festgestellt. Wir berechnen eine Mahngebühr von {fmt_amount_de(fee, 0)}.\n"
                    f"Bitte überweisen Sie den offenen Betrag bis zum {d}.")
            expected.append({"date": due.isoformat(), "kind": "deadline", "amount": amount_key(cents)})
            unwanted.append((written - timedelta(days=30)).isoformat())
        elif kind == "change":
            start = date(due.year if due.month < 12 else due.year + 1, (due.month % 12) + 1, 1)
            body = (f"Ihr Beitrag ändert sich\n\nab dem {start:%d.%m.%Y} beträgt Ihr monatlicher Beitrag {a}. "
                    f"Sie haben ein Sonderkündigungsrecht. Sie können bis zum {d} kündigen.")
            expected.append({"date": due.isoformat(), "kind": "deadline", "amount": None})
            expected.append({"date": start.isoformat(), "kind": "change", "amount": amount_key(cents)})
        elif kind == "appointment":
            hh, mm = rnd.randint(8, 17), rnd.choice([0, 15, 30, 45])
            t = rnd.choice([f"{hh}:{mm:02d} Uhr", f"{hh}.{mm:02d} Uhr"])
            body = (f"Einladung\n\nbitte kommen Sie am {d} um {t} zu einem Gespräch in Raum {rnd.randint(1, 4)}.{rnd.randint(10, 40)}. "
                    f"Bringen Sie Ihren Ausweis mit.")
            expected.append({"date": due.isoformat(), "kind": "appointment", "time": f"{hh:02d}:{mm:02d}"})
        elif kind == "cancel_confirm":
            body = (f"Bestätigung Ihrer Kündigung\n\nwir bestätigen Ihre Kündigung. Ihr Vertrag endet zum {d}. "
                    f"Bis dahin buchen wir die Monatsbeiträge von {a} weiter ab.")
            expected.append({"date": due.isoformat(), "kind": "deadline", "amount": None})
        elif kind == "notice":
            body = (f"Bescheid\n\nDie festgesetzte Nachzahlung von {a} ist fällig am {d}.\n\nRechtsbehelfsbelehrung: "
                    f"Gegen diesen Bescheid kann innerhalb eines Monats nach Bekanntgabe Einspruch eingelegt werden.")
            expected.append({"date": due.isoformat(), "kind": "deadline", "amount": amount_key(cents)})
        elif kind == "debit":
            body = (f"Ankündigung der Lastschrift\n\nDer Betrag von {a} wird am {d} von Ihrem Konto "
                    f"DE02 1203 0000 0000 2020 51 abgebucht.")
            expected.append({"date": due.isoformat(), "kind": "payment", "amount": amount_key(cents)})
        elif kind == "english_invoice":
            euros, c = divmod(cents, 100)
            amount_en = f"EUR {euros:,}.{c:02d}"
            date_en = rnd.choice([f"{due.day} {MONTHS_EN[due.month - 1]} {due.year}", f"{MONTHS_EN[due.month - 1]} {due.day}, {due.year}"])
            head = f"{sender}\n\nAnna Beispiel\n\nDate: {written.day} {MONTHS_EN[written.month - 1]} {written.year}\n\n"
            body = f"Invoice\n\nThe amount of {amount_en} is due by {date_en}. Please pay by bank transfer."
            expected.append({"date": due.isoformat(), "kind": "deadline", "amount": f"{euros:,}.{c:02d}"})
        elif kind == "english_appointment":
            hh = rnd.randint(9, 16)
            date_en = f"{due.day} {MONTHS_EN[due.month - 1]} {due.year}"
            head = f"{sender}\n\nAnna Beispiel\n\nDate: {written.day} {MONTHS_EN[written.month - 1]} {written.year}\n\n"
            body = f"Appointment\n\nYour appointment is on {date_en} at {hh}:00. Please arrive ten minutes early."
            expected.append({"date": due.isoformat(), "kind": "appointment", "time": f"{hh:02d}:00"})
        elif kind == "no_year":
            # common in letters: the year is left out ("bis zum 15.12."); the letter's own year (or the next one,
            # when the day has already passed in that year) is meant
            body = (f"Zahlungserinnerung\n\nbitte überweisen Sie die offenen {a} bis zum {due.day:02d}.{due.month:02d}.")
            expected.append({"date": due.isoformat(), "kind": "deadline", "amount": amount_key(cents), "no_year": True})
        else:  # birthday_noise: a date that is nothing to do
            born = date(rnd.randint(1950, 2004), rnd.randint(1, 12), rnd.randint(1, 28))
            body = (f"Versicherungsschein\n\nVersicherte Person: Anna Beispiel, geboren am {born:%d.%m.%Y}.\n"
                    f"Der Jahresbeitrag von {a} wird am {d} abgebucht.")
            expected.append({"date": due.isoformat(), "kind": "payment", "amount": amount_key(cents)})
            unwanted.append(born.isoformat())
        letters.append({"id": f"L{i:03d}-{kind}", "lang": "en" if kind.startswith("english") else "de",
                        "text": head + body + "\n\nMit freundlichen Grüßen\n" + sender, "expected": expected,
                        "unwanted": unwanted})
    return letters


def score(letters: List[Dict], find) -> Dict:
    """Run find(text) -> [FoundDate] over the letters; recall, precision, amount and kind accuracy, and the misses."""
    exp_total = found_ok = amount_ok = amount_total = kind_ok = 0
    false_pos = 0
    reported = 0
    misses, wrong = [], []
    for letter in letters:
        found = find(letter["text"])
        reported += len(found)
        by_date = {}
        for f in found:
            by_date.setdefault(f.date, []).append(f)
        for e in letter["expected"]:
            exp_total += 1
            hits = by_date.get(e["date"], [])
            if not hits:
                misses.append(f"{letter['id']}: {e['date']} not found")
                continue
            found_ok += 1
            h = hits[0]
            if h.kind == e["kind"]:
                kind_ok += 1
            else:
                wrong.append(f"{letter['id']}: {e['date']} is {h.kind}, expected {e['kind']}")
            if e.get("amount"):
                amount_total += 1
                if h.amount and h.amount.split()[0] == e["amount"]:
                    amount_ok += 1
                else:
                    wrong.append(f"{letter['id']}: amount {h.amount}, expected {e['amount']}")
        expected_dates = {e["date"] for e in letter["expected"]}
        for f in found:
            if f.date not in expected_dates:
                false_pos += 1
                wrong.append(f"{letter['id']}: reported {f.date} ({f.kind})"
                             + (" which must not be" if f.date in letter["unwanted"] else ""))
    return {"letters": len(letters), "expected": exp_total, "recall": found_ok / max(1, exp_total),
            "precision": (reported - false_pos) / max(1, reported), "kind_accuracy": kind_ok / max(1, found_ok),
            "amount_accuracy": amount_ok / max(1, amount_total), "misses": misses, "wrong": wrong}


if __name__ == "__main__":
    import sys
    sys.path.insert(0, ".")
    from app.services.dates_service import find_dates
    result = score(generate(int(sys.argv[1]) if len(sys.argv) > 1 else 120), find_dates)
    for k in ("letters", "expected", "recall", "precision", "kind_accuracy", "amount_accuracy"):
        v = result[k]
        print(f"{k:16} {v:.1%}" if isinstance(v, float) else f"{k:16} {v}")
    for line in (result["misses"] + result["wrong"])[:40]:
        print("  " + line)
