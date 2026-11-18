/**
 * StarkLLM Theme Definitions
 * Curated palette presets for high-aesthetic personalization.
 * The ids never change (they are saved in the settings); the names and descriptions come from themeText() in the
 * interface language.
 */
import { t } from '../i18n';

export const AVAILABLE_THEMES = [
  {
    id: 'dark',
    bg: '#05070a',
    card: '#121622',
    accent: '#4f46e5',
    bright: '#818cf8',
    gradient: 'linear-gradient(135deg, #6366f1, #8b5cf6)'
  },
  {
    id: 'pink',
    bg: '#0a040b',
    card: '#220f28',
    accent: '#f43f5e',
    bright: '#fb7185',
    gradient: 'linear-gradient(135deg, #ec4899, #f43f5e)'
  },
  {
    id: 'black',
    bg: '#000000',
    card: '#101010',
    accent: '#0284c7',
    bright: '#38bdf8',
    gradient: 'linear-gradient(135deg, #0284c7, #38bdf8)'
  },
  {
    id: 'glass',
    bg: '#070b16',
    card: 'rgba(25, 36, 66, 0.42)',
    accent: '#8b5cf6',
    bright: '#a78bfa',
    gradient: 'linear-gradient(135deg, #a855f7, #38bdf8)'
  },
  {
    id: 'emerald',
    bg: '#030c08',
    card: '#0d281e',
    accent: '#10b981',
    bright: '#34d399',
    gradient: 'linear-gradient(135deg, #10b981, #06b6d4)'
  },
  {
    id: 'amber',
    bg: '#0b0602',
    card: '#26190b',
    accent: '#f59e0b',
    bright: '#fbbf24',
    gradient: 'linear-gradient(135deg, #f59e0b, #ea580c)'
  },
  {
    id: 'nord',
    bg: '#060f18',
    card: '#152c43',
    accent: '#0891b2',
    bright: '#22d3ee',
    gradient: 'linear-gradient(135deg, #06b6d4, #3b82f6)'
  },
  {
    id: 'light',
    bg: '#f0f2f8',
    card: '#ffffff',
    accent: '#4f46e5',
    bright: '#6366f1',
    gradient: 'linear-gradient(135deg, #ffffff, #e0e7ff)'
  },
  {
    id: 'doodle',
    bg: '#efe6dc',
    card: '#fffdf9',
    accent: '#0f766e',
    bright: '#0d9488',
    gradient: 'linear-gradient(135deg, #0d9488, #14b8a6)',
    pattern: true
  },
  {
    id: 'doodle-night',
    bg: '#0b141a',
    card: '#1f2c33',
    accent: '#14b8a6',
    bright: '#2dd4bf',
    gradient: 'linear-gradient(135deg, #14b8a6, #06b6d4)',
    pattern: true
  },
  {
    id: 'flowers',
    bg: '#fdf2f6',
    card: '#ffffff',
    accent: '#db2777',
    bright: '#ec4899',
    gradient: 'linear-gradient(135deg, #ec4899, #f59e0b)',
    pattern: true
  },
  {
    id: 'matrix',
    bg: '#000a03',
    card: '#02140a',
    accent: '#16a34a',
    bright: '#22c55e',
    gradient: 'linear-gradient(135deg, #16a34a, #4ade80)',
    pattern: true
  },
  {
    id: 'stars',
    bg: '#0a0f24',
    card: '#161e44',
    accent: '#f59e0b',
    bright: '#fbbf24',
    gradient: 'linear-gradient(135deg, #6366f1, #f59e0b)',
    pattern: true
  }
];

const THEME_TEXTS = () => ({
  dark: { name: t('Midnight Indigo'), badge: t('Default'), desc: t('Classic deep slate with rich indigo and violet radiance.') },
  pink: { name: t('Cyberpunk Rose'), badge: t('Cyber Rose'), desc: t('Vibrant neon pink & rose with warm ambient cyber glow.') },
  black: { name: t('OLED Pitch Black'), badge: t('OLED Black'), desc: t('Pure #000000 true black for maximum contrast and battery life.') },
  glass: { name: t('Liquid Glass'), badge: t('Liquid Glass'), desc: t('Translucent frosted glass with iridescent multi-color radiance.') },
  emerald: { name: t('Matrix Emerald'), badge: t('Matrix Emerald'), desc: t('Obsidian matrix with electric cyber emerald green accents.') },
  amber: { name: t('Sunset Volcano'), badge: t('Sunset Amber'), desc: t('Volcanic slate infused with warm glowing amber & flame accents.') },
  nord: { name: t('Arctic Frost'), badge: t('Arctic Frost'), desc: t('Sub-zero arctic navy with crystalline cyan & blue frost.') },
  light: { name: t('Daylight Minimal'), badge: t('Daylight Light'), desc: t('Clean daylight aesthetic with soft shadows and crisp contrast.') },
  doodle: { name: t('Doodle Chat'), badge: t('Pattern'), desc: t('Warm paper with little dolls, hearts, letters and stars drawn in the background.') },
  'doodle-night': { name: t('Doodle Night'), badge: t('Pattern'), desc: t('The doodles on a calm dark chat background.') },
  flowers: { name: t('Flower Meadow'), badge: t('Pattern'), desc: t('Small pink, lilac and peach flowers on soft blush.') },
  matrix: { name: t('Matrix Code'), badge: t('Pattern'), desc: t('Green code rain on black, in a monospace font.') },
  stars: { name: t('Starry Night'), badge: t('Pattern'), desc: t('A quiet night sky full of small stars, with warm gold accents.') },
});

/** Name, badge and description of a theme in the interface language (read while rendering). */
export function themeText(themeId) {
  return THEME_TEXTS()[themeId] || { name: themeId, badge: '', desc: '' };
}

export function applyTheme(themeId) {
  document.documentElement.setAttribute('data-theme', themeId);
  localStorage.setItem('ui_theme', themeId);
}

export function getCurrentTheme() {
  return localStorage.getItem('ui_theme') || 'dark';
}
