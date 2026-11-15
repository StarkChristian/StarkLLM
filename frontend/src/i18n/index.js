// UI languages: English (the source) and one file per other language, src/i18n/<code>.json (German today).
// The English text is the key: t('Knowledge Base') gives the translation when the UI language has one, else the
// English text. So a missing translation shows English, never a key or an empty label.
// {name} placeholders: t('Updated: {time}', { time }).
// The language is the user's choice in Settings, else the language of the system when there is a file for it, else
// English. Changing it reloads the page, so every component simply calls t() while rendering.
// Adding a language: add the file, nothing else (docs/adding-a-language.md).
import { SOURCE_LANGUAGE, languageList, pickLanguage, localeFor } from './locales.js';

const FILES = import.meta.glob('./*.json', { eager: true, import: 'default' });
const DICTIONARIES = {};
for (const [path, dictionary] of Object.entries(FILES)) {
  const code = path.match(/\.\/([\w-]+)\.json$/)?.[1];
  if (code && code !== SOURCE_LANGUAGE) DICTIONARIES[code] = dictionary;
}

export const LANGUAGES = languageList(Object.keys(DICTIONARIES));
const CODES = LANGUAGES.map((l) => l.code);
const STORAGE_KEY = 'starkllm_language';

function systemLanguages() {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? [...navigator.languages] : [navigator.language].filter(Boolean);
}

function detect() {
  let saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch (_) { /* private mode */ }
  return pickLanguage(saved, systemLanguages(), CODES);
}

let current = detect();

export function language() {
  return current;
}

/** The locale for dates, times and numbers in the current UI language ("en-GB", "en-US", "de-AT", "fr", ...). */
export function locale() {
  return localeFor(current, systemLanguages());
}

export function setLanguage(code) {
  if (!CODES.includes(code) || code === current) return;
  try { localStorage.setItem(STORAGE_KEY, code); } catch (_) { /* private mode */ }
  current = code;
  document.documentElement.lang = code;
  window.location.reload();
}

export function t(text, values) {
  const dict = DICTIONARIES[current];
  let out = (dict && dict[text]) || text;
  if (values) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m));
  return out;
}

if (typeof document !== 'undefined') {
  document.documentElement.lang = current;
  document.documentElement.dir = LANGUAGES.find((l) => l.code === current)?.dir || 'ltr';
}
