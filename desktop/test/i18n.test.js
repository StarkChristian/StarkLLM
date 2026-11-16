// The desktop texts (dialogs, tray menu, start screen, start-up problems) in every interface language: each text the
// code asks for with t('...') or status('...') has a translation in every locales/<code>.json, placeholders match, and
// nothing is left over. The English text is the key, so English needs no file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const i18n = require('../i18n');

const ROOT = path.join(__dirname, '..');
const SOURCES = ['main.js', 'updates.js', 'engine.js', 'diagnostics.js', 'ollama-install.js', 'native-engine.js'];
const LITERAL = String.raw`('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`;
// t('...') and status('...') (also the two branches of status(cond ? 'a' : 'b'))
const CALLS = [new RegExp(String.raw`(?<![\w.])t\(\s*${LITERAL}`, 'g'), new RegExp(String.raw`(?<![\w.])status\(\s*(?:[\w.]+\s*\?\s*)?${LITERAL}(?:\s*:\s*${LITERAL})?`, 'g')];
const evalLiteral = (lit) => new Function(`return ${lit}`)();

function collectKeys() {
  const keys = new Set();
  for (const file of SOURCES) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const rx of CALLS) {
      for (const m of src.matchAll(rx)) for (const lit of m.slice(1)) if (lit) keys.add(evalLiteral(lit));
    }
  }
  // the languages' own words in the splash screen and tray
  return [...keys];
}

const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
const CODES = i18n.LANGUAGES.filter((c) => c !== 'en');

test('every desktop text has a translation in every language, with the same placeholders', () => {
  const keys = collectKeys();
  assert.ok(keys.length > 60, `found only ${keys.length} texts`);
  for (const code of CODES) {
    const dict = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${code}.json`), 'utf8'));
    const missing = keys.filter((k) => !(k in dict));
    const unused = Object.keys(dict).filter((k) => !keys.includes(k));
    const badPlaceholders = keys.filter((k) => k in dict && placeholders(k) !== placeholders(dict[k]));
    assert.deepEqual(missing, [], `${code}: missing`);
    assert.deepEqual(unused, [], `${code}: not used any more`);
    assert.deepEqual(badPlaceholders, [], `${code}: placeholders differ`);
  }
});

test('a language is chosen from the saved choice, else from Windows, else English', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starkllm-lang-'));
  assert.equal(i18n.init(dir, 'de-DE'), 'de');
  assert.equal(i18n.init(dir, 'ja'), 'en');
  assert.equal(i18n.init(dir, 'tr'), 'tr');
  assert.equal(i18n.init(dir, undefined), 'en');
  assert.equal(i18n.save(dir, 'fr'), true);
  assert.equal(i18n.init(dir, 'de-DE'), 'fr'); // the saved choice wins
  assert.equal(i18n.save(dir, 'xx'), false);
  assert.equal(i18n.init(dir, 'de-DE'), 'fr');
  i18n.setLanguage('en');
});

test('texts are translated, values are filled in, and a missing translation shows English', () => {
  i18n.setLanguage('de');
  assert.equal(i18n.t('Quit StarkLLM'), 'StarkLLM beenden');
  assert.equal(i18n.t('StarkLLM {version} is available.', { version: '2.1.0' }), 'StarkLLM 2.1.0 ist verfügbar.');
  assert.equal(i18n.t('A text nobody translated {x}', { x: 1 }), 'A text nobody translated 1');
  i18n.setLanguage('xx'); // unknown: stays German
  assert.equal(i18n.language(), 'de');
  i18n.setLanguage('en');
  assert.equal(i18n.t('Quit StarkLLM'), 'Quit StarkLLM');
  assert.equal(i18n.format('Port {a} or {b}', { a: 1 }), 'Port 1 or {b}');
});

test('the log keeps English while the screen shows the language', () => {
  assert.equal(i18n.format('Using {model} (already installed)', { model: 'qwen' }), 'Using qwen (already installed)');
});

module.exports = { collectKeys };
