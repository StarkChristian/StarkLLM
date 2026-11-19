import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerLineRange } from '../src/utils/sourceLine.js';

// the page text of the tour letter Stadtwerke-Rechnung.pdf as the engine reads it (PyMuPDF, one text line per line)
const LETTER = [
  'Stadtwerke Musterstadt GmbH', 'Am Wasserturm 5', '12345 Musterstadt', '0000 123456-0', 'kundenservice@stadtwerke-',
  'musterstadt.example', 'Stadtwerke Musterstadt GmbH · Am Wasserturm 5 · 12345', 'Musterstadt', 'Frau Anna Becker',
  'Lindenstraße 23', '12345 Musterstadt', 'Datum', '03.11.2026', 'Kundennummer', '4471-2093', 'Rechnungsnummer',
  '2026-118734', 'Ihre Stromrechnung', 'Sehr geehrte Frau Becker,',
  'für Ihre Stromlieferung in der Lindenstraße 23 im Zeitraum 01.09.2026 bis 31.10.2026', 'berechnen wir Ihnen:',
  'Arbeitspreis: 412 kWh (Zählerstand 18.204 → 18.616)', '108,81 €', 'Grundpreis: 61 Tage', '19,59 €',
  'Rechnungsbetrag', '128,40 €', 'Im Rechnungsbetrag ist die Umsatzsteuer von 19 % enthalten: 20,50 €.',
  'Bitte überweisen Sie den Rechnungsbetrag von 128,40 € bis zum 15.12.2026 unter Angabe',
  'der Rechnungsnummer.', 'ZAHLUNGSINFORMATIONEN', 'Empfänger', 'Stadtwerke Musterstadt GmbH', 'IBAN',
  'DE00 0000 0000 0000 0000 01', 'Verwendungszweck', 'Rechnung 2026-118734', 'Betrag', '128,40 €', 'Fällig am',
  '15.12.2026', 'Mit freundlichen Grüßen', 'Ihr Kundenservice', 'Stadtwerke Musterstadt GmbH', '',
].join('\n');

const ANSWER = 'Bis Jahresende musst du Folgendes bezahlen:\n\n'
  + '- **Stadtwerke-Rechnung**: 128,40 € bis zum 15.12.2026 [Stadtwerke-Rechnung.pdf]\n'
  + '- **Grundsteuer**: 186,00 € bis zum 15.11.2026 [Grundsteuer.pdf]\n\nInsgesamt: 314,40 €.';

const marked = (text, r) => (r ? text.slice(r[0], r[1]) : null);

test('a letter is opened at the sentence the amount and the due date come from, not at its letterhead', () => {
  const r = answerLineRange(LETTER, ANSWER, [0, 700]);
  assert.equal(marked(LETTER, r),
    'Bitte überweisen Sie den Rechnungsbetrag von 128,40 € bis zum 15.12.2026 unter Angabe\nder Rechnungsnummer.');
});

test('an amount written with a dot instead of a comma still finds its line', () => {
  const r = answerLineRange(LETTER, 'You have to pay 128.40 EUR by 15.12.2026.');
  assert.match(marked(LETTER, r), /^Bitte überweisen/);
});

test('a single shared amount marks the line with that amount', () => {
  const text = 'Musterfirma AG\nHauptstraße 1\nDer Beitrag beträgt 42,17 € im Monat.\nViele Grüße';
  assert.equal(marked(text, answerLineRange(text, 'Der Beitrag: 42,17 €')), 'Der Beitrag beträgt 42,17 € im Monat.');
});

test('the cited chunk is searched before the rest of the page', () => {
  const text = 'Summe 99,90 € (Vorjahr)\n' + 'x\n'.repeat(50) + 'Summe 99,90 € in diesem Jahr';
  const r = answerLineRange(text, 'Die Summe ist 99,90 €.', [text.length - 40, text.length]);
  assert.equal(marked(text, r), 'Summe 99,90 € in diesem Jahr');
});

test('no line is chosen when nothing of the answer is on the page (the viewer then marks the chunk start)', () => {
  assert.equal(answerLineRange(LETTER, 'Dazu habe ich nichts gefunden.'), null);
  assert.equal(answerLineRange(LETTER, ''), null);
  assert.equal(answerLineRange('', ANSWER), null);
  // one or two digits alone ("19 %", "5") do not point at a line
  assert.equal(answerLineRange('Am Wasserturm 5\nMwSt 19 %', 'Seite 5, 19 %'), null);
});
