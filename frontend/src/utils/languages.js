/**
 * StarkLLM interface languages.
 * English is the primary language; German is the second. Choosing and translating: src/i18n.
 */

export const SUPPORTED_LANGUAGES = [
  {
    code: 'en',
    name: 'English',
    nativeName: 'English',
    region: 'Global / US / UK',
    status: 'active',
    statusLabel: 'Active',
    dir: 'ltr',
    flag: '🇺🇸'
  },
  {
    code: 'de',
    name: 'German',
    nativeName: 'Deutsch',
    region: 'Germany, Austria, Switzerland',
    status: 'active',
    statusLabel: 'Active',
    dir: 'ltr',
    flag: '🇩🇪'
  }
];
