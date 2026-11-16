import { t } from '../i18n';

// Every retrieved passage used to be listed as a source, even when the answer did not use it (a question about one
// file listed five). The answer names the files it used ("According to [Project card.md] ..."), so the chips show
// those files. If the answer names none of them, all retrieved sources are shown, as before.
const FILE = /^(.*?\.[A-Za-z0-9]{1,8})(?=\s*\(|$)/;

function fileName(label) {
  const m = String(label).match(FILE);
  return (m ? m[1] : String(label)).trim().toLowerCase();
}

export function citedSources(msg) {
  const ws = msg.wsSources || [];
  const kb = msg.kbSources || [];
  const text = (msg.content || '').toLowerCase();
  if (!text) return { ws, kb };
  const keep = (list) => list.filter((label) => text.includes(fileName(label)));
  const citedWs = keep(ws);
  const citedKb = keep(kb);
  if (citedWs.length + citedKb.length === 0) return { ws, kb };
  return { ws: citedWs, kb: citedKb };
}

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
  else if ((p = rest.match(/^Sheet '(.+)' \(chunk (\d+)\)$/))) where = t('Sheet "{sheet}"', { sheet: p[1] });
  else if ((p = rest.match(/^Section: '(.+)'(?: \(chunk \d+\)| Chunk \d+)?$/))) where = t('Section "{section}"', { section: p[1] });
  return how ? `${where}, ${how}` : where;
}

export function readableSource(label) {
  const m = String(label).match(LOCATOR);
  if (!m) return String(label);
  return `${m[1]} · ${readableLocator(m[2])}`;
}
