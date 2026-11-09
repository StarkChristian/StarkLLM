// UI languages: English (the source) and German (roadmap phase 2).
// The English text is the key: t('Knowledge Base') gives the German text when the UI is German and a translation
// exists, else the English text. So a missing translation shows English, never a key or an empty label.
// {name} placeholders: t('Updated: {time}', { time }).
// The language is the user's choice in Settings, else the language of the system (German Windows -> German UI).
// Changing it reloads the page, so every component simply calls t() while rendering.
import de from './de.json';

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'de', name: 'Deutsch' }
];

const DICTIONARIES = { de };
const STORAGE_KEY = 'starkllm_language';

function detect() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LANGUAGES.some((l) => l.code === saved)) return saved;
  } catch (_) { /* private mode */ }
  const system = (typeof navigator !== 'undefined' && (navigator.languages?.[0] || navigator.language)) || 'en';
  return system.toLowerCase().startsWith('de') ? 'de' : 'en';
}

let current = detect();

export function language() {
  return current;
}

export function setLanguage(code) {
  if (!LANGUAGES.some((l) => l.code === code) || code === current) return;
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

if (typeof document !== 'undefined') document.documentElement.lang = current;
