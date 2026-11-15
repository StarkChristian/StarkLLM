// One locale for every date, time and number in the UI, so they match the UI language instead of mixing with the
// system language (seen on a German Windows: "Montag, 9. November 2026" and "$74.114" in the English UI).
// The locale comes from the UI language and the system's region (i18n/locales.js): English is en-GB unless the system
// says en-US, en-AU, ...; German is de-DE unless the system says de-AT or de-CH.
import { locale } from '../i18n';
import { formatDay, formatMoney } from '../i18n/locales.js';

export const UI_LOCALE = locale();

// A sum in a currency: "$74,291.00" in English, "74.291,00 $" in German
export function money(value, currency = 'USD', decimals = 2) {
  return formatMoney(value, currency, UI_LOCALE, decimals);
}

// US dollar amounts (market prices)
export function formatUsd(value, decimals = 2) {
  return money(value, 'USD', decimals);
}

// An ISO day from the backend (2026-12-15) in the UI locale
export function day(iso, options) {
  return formatDay(iso, UI_LOCALE, options);
}
