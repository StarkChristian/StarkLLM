// One locale for every date, time and number in the UI, so they match the UI language instead of mixing with the
// system language (seen on a German Windows: "Montag, 9. November 2026" and "$74.114" in the English UI).
// English: en-GB (24-hour clock, day-month order, as usual in Europe). German: de-DE.
import { language } from '../i18n';

export const UI_LOCALE = language() === 'de' ? 'de-DE' : 'en-GB';

// US dollar amounts: "$74,291.00" in English, "74.291,00 $" in German
export function formatUsd(value, decimals = 2) {
  const n = value.toLocaleString(UI_LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return UI_LOCALE === 'de-DE' ? `${n} $` : `$${n}`;
}
