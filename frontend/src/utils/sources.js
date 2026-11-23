import { t } from '../i18n';

export { citedSources } from './citedSources.js';

// The backend labels a source as "file (locator)" in English: "letter.pdf (Page 2 (OCR))", "IMG_1.jpg (Image (OCR))",
// "notes.md (Chunk 3)". These turn the locator into words in the UI language.
const LOCATOR = /^(.*?\.[A-Za-z0-9]{1,8})\s*\((.*)\)\s*$/;

export function readableLocator(locator) {
  let how = '';
  let rest = String(locator || '').trim();
  const m = rest.match(/^(.*?)\s*\((OCR|Vision)\)$/);
  if (m) {
    rest = m[1];
    how = m[2] === 'OCR' ? t('read from the image') : t('described by the image model');
  }
  let where = rest;
  let p;
  if ((p = rest.match(/^Page (\d+)$/))) where = t('Page {page}', { page: p[1] });
  else if (rest === 'Image') where = t('Photo');
  else if ((p = rest.match(/^Chunk (\d+)$/))) where = t('Part {part}', { part: p[1] });
  else if ((p = rest.match(/^Time (\d{2}:\d{2}:\d{2})$/))) where = t('at {time}', { time: p[1] });
  else if ((p = rest.match(/^Sheet '(.+)' \(chunk (\d+)\)$/))) where = t('Sheet "{sheet}"', { sheet: p[1] });
  else if ((p = rest.match(/^Section: '(.+)'(?: \(chunk \d+\)| Chunk \d+)?$/))) where = t('Section "{section}"', { section: p[1] });
  return how ? `${where}, ${how}` : where;
}

export function readableSource(label) {
  const m = String(label).match(LOCATOR);
  if (!m) return String(label);
  return `${m[1]} · ${readableLocator(m[2])}`;
}
