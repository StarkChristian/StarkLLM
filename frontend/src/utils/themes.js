/**
 * StarkLLM Theme Definitions
 * Curated palette presets for high-aesthetic personalization.
 */

export const AVAILABLE_THEMES = [
  {
    id: 'dark',
    name: 'Midnight Indigo',
    badge: 'Default',
    desc: 'Classic deep slate with rich indigo and violet radiance.',
    bg: '#05070a',
    card: '#121622',
    accent: '#4f46e5',
    bright: '#818cf8',
    gradient: 'linear-gradient(135deg, #6366f1, #8b5cf6)'
  },
  {
    id: 'pink',
    name: 'Cyberpunk Rose',
    badge: 'Cyber Rose',
    desc: 'Vibrant neon pink & rose with warm ambient cyber glow.',
    bg: '#0a040b',
    card: '#220f28',
    accent: '#f43f5e',
    bright: '#fb7185',
    gradient: 'linear-gradient(135deg, #ec4899, #f43f5e)'
  },
  {
    id: 'black',
    name: 'OLED Pitch Black',
    badge: 'OLED Black',
    desc: 'Pure #000000 true black for maximum contrast and battery life.',
    bg: '#000000',
    card: '#101010',
    accent: '#0284c7',
    bright: '#38bdf8',
    gradient: 'linear-gradient(135deg, #0284c7, #38bdf8)'
  },
  {
    id: 'glass',
    name: 'Liquid Glass',
    badge: 'Liquid Glass',
    desc: 'Translucent frosted glass with iridescent multi-color radiance.',
    bg: '#070b16',
    card: 'rgba(25, 36, 66, 0.42)',
    accent: '#8b5cf6',
    bright: '#a78bfa',
    gradient: 'linear-gradient(135deg, #a855f7, #38bdf8)'
  },
  {
    id: 'emerald',
    name: 'Matrix Emerald',
    badge: 'Matrix Emerald',
    desc: 'Obsidian matrix with electric cyber emerald green accents.',
    bg: '#030c08',
    card: '#0d281e',
    accent: '#10b981',
    bright: '#34d399',
    gradient: 'linear-gradient(135deg, #10b981, #06b6d4)'
  },
  {
    id: 'amber',
    name: 'Sunset Volcano',
    badge: 'Sunset Amber',
    desc: 'Volcanic slate infused with warm glowing amber & flame accents.',
    bg: '#0b0602',
    card: '#26190b',
    accent: '#f59e0b',
    bright: '#fbbf24',
    gradient: 'linear-gradient(135deg, #f59e0b, #ea580c)'
  },
  {
    id: 'nord',
    name: 'Arctic Frost',
    badge: 'Arctic Frost',
    desc: 'Sub-zero arctic navy with crystalline cyan & blue frost.',
    bg: '#060f18',
    card: '#152c43',
    accent: '#0891b2',
    bright: '#22d3ee',
    gradient: 'linear-gradient(135deg, #06b6d4, #3b82f6)'
  },
  {
    id: 'light',
    name: 'Daylight Minimal',
    badge: 'Daylight Light',
    desc: 'Clean daylight aesthetic with soft shadows and crisp contrast.',
    bg: '#f0f2f8',
    card: '#ffffff',
    accent: '#4f46e5',
    bright: '#6366f1',
    gradient: 'linear-gradient(135deg, #ffffff, #e0e7ff)'
  }
];

export function applyTheme(themeId) {
  document.documentElement.setAttribute('data-theme', themeId);
  localStorage.setItem('ui_theme', themeId);
}

export function getCurrentTheme() {
  return localStorage.getItem('ui_theme') || 'dark';
}
