// The texts of the desktop app (dialogs, tray menu, start screen, start-up problems) in the interface languages.
// Same idea as the web UI (frontend/src/i18n): the English text is the key, and a missing translation shows English.
//   t('StarkLLM {version} is available.', { version })
// The language is the one the user chose in Settings (the page tells the desktop app through the preload bridge) or,
// before that, the language of Windows when there is a file for it. Adding a language: add locales/<code>.json and
// the code to LANGUAGES (docs/adding-a-language.md). Texts that are drafted by an AI need a native speaker's review.
const fs = require('fs');
const path = require('path');

const LANGUAGES = ['en', 'de', 'es', 'fr', 'it', 'tr'];
let current = 'en';
const cache = {};

function dictionary(code) {
  if (code === 'en') return null;
  if (!cache[code]) {
    try {
      cache[code] = JSON.parse(fs.readFileSync(path.join(__dirname, 'locales', `${code}.json`), 'utf8'));
    } catch (_) {
      cache[code] = {};
    }
  }
  return cache[code];
}

/** "de-AT" / "fr_FR" / "tr" -> "de" / "fr" / "tr" when there is a file for it, else null. */
function supported(tag) {
  const code = String(tag || '').toLowerCase().split(/[-_]/)[0];
  return LANGUAGES.includes(code) ? code : null;
}

function language() {
  return current;
}

function setLanguage(code) {
  const ok = supported(code);
  if (ok) current = ok;
  return current;
}

/**
 * Picks the language at start: the saved choice (userData/language.json), else the system's, else English.
 * dir: the user-data folder; systemLocale: app.getLocale().
 */
function init(dir, systemLocale) {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(path.join(dir, 'language.json'), 'utf8')).language;
  } catch (_) { /* not chosen yet */ }
  return setLanguage(supported(saved) || supported(systemLocale) || 'en');
}

/** Remembers the user's choice, so the desktop app starts in it before the page is loaded. */
function save(dir, code) {
  const ok = supported(code);
  if (!ok) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'language.json'), JSON.stringify({ language: ok }));
  } catch (_) { return false; }
  return true;
}

/** The English text with its values filled in: for the log, which stays English whatever the user's language. */
function format(text, values) {
  return values ? text.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m)) : text;
}

function t(text, values) {
  const dict = dictionary(current);
  return format((dict && dict[text]) || text, values);
}

module.exports = { t, format, init, save, language, setLanguage, supported, LANGUAGES };
