import test from 'node:test';
import assert from 'node:assert/strict';
import { detectLanguage, speechLanguage, pickVoice } from '../src/utils/speech.js';

const VOICES = [
  { id: 'en_US-lessac-medium', language: 'en' },
  { id: 'de_DE-thorsten-medium', language: 'de' },
  { id: 'fr_FR-siwis-medium', language: 'fr' },
];

test('the language of a text is found by its words and letters', () => {
  assert.equal(detectLanguage('Wie viel muss ich ans Finanzamt nachzahlen und bis wann?'), 'de');
  assert.equal(detectLanguage('Ihre Rechnung über 98,50 EUR ist fällig.'), 'de');
  assert.equal(detectLanguage('When is my appointment and what do I have to bring with me?'), 'en');
  assert.equal(detectLanguage('Quand dois-je payer la facture et combien ?'), 'fr');
  assert.equal(detectLanguage('¿Cuándo tengo que pagar la factura y cuánto es?'), 'es');
  assert.equal(detectLanguage('Quando devo pagare la fattura e quanto è?'), 'it');
  assert.equal(detectLanguage('Fatura için son ödeme tarihi ne zaman ve ne kadar?'), 'tr');
});

test('a text that is not clearly in one language has none', () => {
  assert.equal(detectLanguage(''), null);
  assert.equal(detectLanguage('   '), null);
  assert.equal(detectLanguage('12345'), null);
  assert.equal(detectLanguage('IBAN DE41 6005 0000 0001 2345 67'), null);
  assert.equal(detectLanguage('ok'), null);
});

test('the voice is the installed one of the text language, else the default voice (null)', () => {
  assert.equal(pickVoice(VOICES, 'Bitte überweisen Sie den Betrag bis zum Fünfzehnten.'), 'de_DE-thorsten-medium');
  assert.equal(pickVoice(VOICES, 'Please pay the amount by the fifteenth of December.'), 'en_US-lessac-medium');
  assert.equal(pickVoice(VOICES, 'Veuillez régler le montant avant le quinze décembre, merci.'), 'fr_FR-siwis-medium');
  assert.equal(pickVoice(VOICES, 'Lütfen tutarı on beş aralığa kadar ödeyiniz ve bilgi veriniz.'), null); // no Turkish voice installed
  assert.equal(pickVoice(VOICES, '12345', 'de'), 'de_DE-thorsten-medium'); // unclear: the interface language
  assert.equal(pickVoice([], 'Hallo, wie geht es Ihnen?'), null);
  assert.equal(pickVoice(undefined, 'Hallo'), null);
});

test('the browser speech language is a full tag', () => {
  assert.equal(speechLanguage('Wie geht es Ihnen heute und was machen Sie?'), 'de-DE');
  assert.equal(speechLanguage('Quand dois-je payer la facture ?'), 'fr-FR');
  assert.equal(speechLanguage('12345', 'tr'), 'tr-TR');
  assert.equal(speechLanguage('12345'), 'en-US');
});
