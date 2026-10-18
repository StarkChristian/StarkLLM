/**
 * StarkLLM Internationalization (i18n) & Language Roadmap
 * Languages ranked by global internet user population demographics:
 * 1. English (en) - Active default
 * 2. Chinese (zh) - Roadmap Tier 1
 * 3. Spanish (es) - Roadmap Tier 1
 * 4. French (fr) - Roadmap Tier 2
 * 5. German (de) - Roadmap Tier 2
 * 6. Arabic (ar) - Roadmap Tier 3 (RTL)
 * 7. Persian (fa) - Roadmap Tier 3 (RTL)
 * 8. Portuguese (pt) - Roadmap Tier 4
 * 9. Russian (ru) - Roadmap Tier 4
 * 10. Japanese (ja) - Roadmap Tier 4
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
    code: 'zh',
    name: 'Chinese',
    nativeName: '中文',
    region: 'China, Taiwan, Singapore',
    users: '1,100M+ users',
    status: 'roadmap',
    statusLabel: 'Roadmap (Tier 1)',
    dir: 'ltr',
    flag: '🇨🇳'
  },
  {
    code: 'es',
    name: 'Spanish',
    nativeName: 'Español',
    region: 'Spain & Latin America',
    users: '550M+ users',
    status: 'roadmap',
    statusLabel: 'Roadmap (Tier 1)',
    dir: 'ltr',
    flag: '🇪🇸'
  },
  {
    code: 'fr',
    name: 'French',
    nativeName: 'Français',
    region: 'France, Canada, Francophonie',
    users: '320M+ users',
    status: 'roadmap',
    statusLabel: 'Roadmap (Tier 2)',
    dir: 'ltr',
    flag: '🇫🇷'
  },
  {
    code: 'de',
    name: 'German',
    nativeName: 'Deutsch',
    region: 'Germany, Austria, Switzerland',
    users: '180M+ users',
    status: 'roadmap',
    statusLabel: 'Roadmap (Tier 2)',
    dir: 'ltr',
    flag: '🇩🇪'
  },
  {
    code: 'ar',
    name: 'Arabic',
    nativeName: 'Arabic',
    region: 'Middle East & North Africa',
    users: '270M+ users',
    status: 'roadmap',
    statusLabel: 'Roadmap (Tier 3)',
    dir: 'rtl',
    flag: '🇸🇦'
  },
  {
    code: 'fa',
    name: 'Persian',
    nativeName: 'Persian (Farsi)',
    region: 'Global Persian Speakers',
    users: '80M+ users',
    status: 'roadmap',
    statusLabel: 'Roadmap (Tier 3)',
    dir: 'rtl',
    flag: '🌐'
  },
  {
    code: 'pt',
    name: 'Portuguese',
    nativeName: 'Português',
    region: 'Brazil, Portugal',
    users: '260M+ users',
    status: 'roadmap',
    statusLabel: 'Roadmap (Tier 4)',
    dir: 'ltr',
    flag: '🇧🇷'
  },
  {
    code: 'ru',
    name: 'Russian',
    nativeName: 'Русский',
    region: 'Eastern Europe & Central Asia',
    users: '250M+ users',
    status: 'roadmap',
    statusLabel: 'Roadmap (Tier 4)',
    dir: 'ltr',
    flag: '🇷🇺'
  },
  {
    code: 'ja',
    name: 'Japanese',
    nativeName: '日本語',
    region: 'Japan',
    users: '125M+ users',
    status: 'roadmap',
    statusLabel: 'Roadmap (Tier 4)',
    dir: 'ltr',
    flag: '🇯🇵'
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
