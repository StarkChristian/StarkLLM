import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { languageList, pickLanguage, localeFor, formatMoney, formatDay, SOURCE_LANGUAGE } from '../src/i18n/locales.js';

const flat = (s) => s.replace(/[  ]/g, ' ');
const I18N = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'i18n');
const FILES = fs.readdirSync(I18N).filter((f) => /^[a-z]{2,3}(-[A-Za-z]+)?\.json$/.test(f)).map((f) => f.replace('.json', ''));

test('English is first and the other languages are named by the browser, in English and in themselves', () => {
  const list = languageList(['de']);
  assert.deepEqual(list.map((l) => l.code), ['en', 'de']);
  assert.equal(list[0].name, 'English');
  assert.equal(list[1].name, 'German');
  assert.equal(list[1].nativeName, 'Deutsch');
  assert.equal(list[1].dir, 'ltr');
});

test('every file in src/i18n is a language the list can name, and English needs no file', () => {
  assert.ok(FILES.includes('de'));
  assert.ok(!FILES.includes(SOURCE_LANGUAGE));
  for (const l of languageList(FILES)) assert.notEqual(l.name, l.code, `${l.code} has no name: is the file name a language code?`);
});

test('right-to-left languages are marked, so a translation file for one works without code changes', () => {
  assert.equal(languageList(['ar', 'fa', 'he']).find((l) => l.code === 'fa').dir, 'rtl');
});

test('the saved choice wins, else the first system language we have, else English', () => {
  const codes = ['en', 'de'];
  assert.equal(pickLanguage('de', ['en-US'], codes), 'de');
  assert.equal(pickLanguage('xx', ['de-AT'], codes), 'de');
  assert.equal(pickLanguage(null, ['de-AT', 'en'], codes), 'de');
  assert.equal(pickLanguage(null, ['fr-FR', 'de'], codes), 'de');
  assert.equal(pickLanguage(null, ['fr-FR'], codes), 'en');
  assert.equal(pickLanguage(null, ['tr', 'ja'], codes), 'en');
  assert.equal(pickLanguage(null, [], codes), 'en');
  assert.equal(pickLanguage(null, undefined, codes), 'en');
  assert.equal(pickLanguage(null, ['fr-FR'], ['en', 'de', 'fr']), 'fr');
});

test('dates and numbers follow the region of the system when it speaks the UI language', () => {
  assert.equal(localeFor('en', ['en-US']), 'en-US');
  assert.equal(localeFor('en', ['en-AU', 'de']), 'en-AU');
  assert.equal(localeFor('en', ['de-DE']), 'en-GB');
  assert.equal(localeFor('en', []), 'en-GB');
  assert.equal(localeFor('de', ['de-AT']), 'de-AT');
  assert.equal(localeFor('de', ['en-US']), 'de');
  assert.equal(localeFor('de', ['de']), 'de');
});

test('a day is written the way the locale writes it, whatever the time zone of the PC', () => {
  assert.equal(formatDay('2026-12-15', 'en-GB'), '15/12/2026');
  assert.equal(formatDay('2026-12-15', 'en-US'), '12/15/2026');
  assert.equal(formatDay('2026-12-15', 'de-DE'), '15.12.2026');
  assert.equal(formatDay('2026-12-15', 'fr-FR'), '15/12/2026');
  assert.equal(formatDay('2026-12-15', 'tr-TR'), '15.12.2026');
  assert.equal(formatDay('2026-12-15', 'en-US', { dateStyle: 'long' }), 'December 15, 2026');
  assert.equal(formatDay('', 'en-GB'), '');
  assert.equal(formatDay('not a date', 'en-GB'), '');
});

test('money is written with the separators of the locale and the symbol of its currency', () => {
  assert.equal(flat(formatMoney(1234.56, 'USD', 'en-US')), '$1,234.56');
  assert.equal(flat(formatMoney(1234.56, 'USD', 'de-DE')), '1.234,56 $');
  assert.equal(flat(formatMoney(1234.56, 'EUR', 'de-DE')), '1.234,56 €');
  assert.equal(flat(formatMoney(1234.56, 'EUR', 'fr-FR')), '1 234,56 €');
  assert.equal(flat(formatMoney(1234.56, 'GBP', 'en-GB')), '£1,234.56');
  assert.equal(flat(formatMoney(1234.5, 'CHF', 'de-CH')).replace('’', "'"), "CHF 1'234.50");
  assert.equal(flat(formatMoney(1234.56, 'TRY', 'tr-TR')), '₺1.234,56');
  assert.equal(flat(formatMoney(5, 'USD', 'en-US', 0)), '$5');
  assert.equal(formatMoney(5, 'not a currency', 'en-US'), '5.00 not a currency');
});
