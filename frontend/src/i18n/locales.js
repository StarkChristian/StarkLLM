// Pure helpers of the UI languages (no build tool needed, so node can test them): which languages exist, which one
// to use, how a language is written, and which locale formats its dates and numbers.
// Adding a language is adding one file: src/i18n/<code>.json (docs/adding-a-language.md). Names come from the browser
// (Intl.DisplayNames), so the file holds nothing but translations.

export const SOURCE_LANGUAGE = 'en'; // the English text is the key of every translation; also the fallback
const RIGHT_TO_LEFT = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'yi']);

const base = (tag) => String(tag || '').toLowerCase().split(/[-_]/)[0];

function displayName(code, inLanguage) {
  try {
    return new Intl.DisplayNames([inLanguage], { type: 'language' }).of(code) || code;
  } catch (_) {
    return code;
  }
}

/** The name of a language written in another language: languageName('fr', 'de') is "Französisch". */
export function languageName(code, inLanguage) {
  return displayName(code, inLanguage);
}

/** [{ code, name (English), nativeName, dir }]: English first, then by English name. */
export function languageList(codes) {
  const all = [...new Set([SOURCE_LANGUAGE, ...codes])].map((code) => ({
    code,
    name: displayName(code, 'en'),
    nativeName: displayName(code, code),
    dir: RIGHT_TO_LEFT.has(code) ? 'rtl' : 'ltr',
  }));
  return [all[0], ...all.slice(1).sort((a, b) => a.name.localeCompare(b.name, 'en'))];
}

/** The language to show: the user's saved choice, else the first language of the system we have a file for, else English. */
export function pickLanguage(saved, systemLanguages, codes) {
  if (saved && codes.includes(saved)) return saved;
  for (const tag of systemLanguages || []) {
    const code = base(tag);
    if (codes.includes(code)) return code;
  }
  return SOURCE_LANGUAGE;
}

/**
 * The locale that formats dates, times and numbers. A system locale of the same language wins (an American on an
 * English UI sees 12/15/2026, a Briton 15/12/2026, an Austrian on a German UI "15.12.2026" with Austrian numbers);
 * else the language itself, English as en-GB (day before month, 24-hour clock) because it is the least surprising.
 */
export function localeFor(code, systemLanguages) {
  const same = (systemLanguages || []).find((tag) => base(tag) === code && /[-_]/.test(tag));
  if (same) return same.replace('_', '-');
  return code === SOURCE_LANGUAGE ? 'en-GB' : code;
}

/** A number as money in a currency, in the locale ("$1,234.56", "1.234,56 $", "1 234,56 €"). */
export function formatMoney(value, currency, locale, decimals = 2) {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(value);
  } catch (_) {
    return `${Number(value).toFixed(decimals)} ${currency}`;
  }
}

/** An ISO date (2026-12-15) in the locale; the calendar day does not move with the time zone. */
export function formatDay(iso, locale, options) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(locale, { timeZone: 'UTC', ...options });
}
