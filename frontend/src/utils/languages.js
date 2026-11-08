/**
 * StarkLLM interface languages.
 * English is the primary language; German is the second and comes next.
 */

export const SUPPORTED_LANGUAGES = [
  {
    code: 'en',
    name: 'English',
    nativeName: 'English',
    region: 'Global / US / UK',
    users: '1,500M+ users',
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
    users: '180M+ users',
    status: 'roadmap',
    statusLabel: 'Next',
    dir: 'ltr',
    flag: '🇩🇪'
  }
];

export function getCurrentLanguage() {
  return localStorage.getItem('ui_language') || 'en';
}

export function setLanguage(code) {
  localStorage.setItem('ui_language', code);
  const lang = SUPPORTED_LANGUAGES.find(l => l.code === code);
  if (lang) {
    document.documentElement.setAttribute('lang', lang.code);
    document.documentElement.setAttribute('dir', lang.dir || 'ltr');
  }
}
