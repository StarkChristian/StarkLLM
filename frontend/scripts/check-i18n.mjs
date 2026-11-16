// Checks every UI translation (src/i18n/<code>.json, German today): every text passed to t() in a translated file has
// a translation, the file has no entries that are not used any more, and placeholders match. A new language is checked
// as soon as its file exists. Run with: npm run i18n:check
// A file counts as translated once it imports t from the i18n module.
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
const dictionaries = fs.readdirSync(path.join(SRC, 'i18n')).filter((f) => /^[a-z]{2,3}(-[A-Za-z]+)?\.json$/.test(f) && f !== 'en.json')
  .map((f) => [f.replace('.json', ''), JSON.parse(fs.readFileSync(path.join(SRC, 'i18n', f), 'utf8'))]);

const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, e.name);
    if (e.isDirectory()) walk(full);
    else if (/\.(jsx?|mjs)$/.test(e.name)) files.push(full);
  }
};
walk(SRC);

const pattern = /\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;
const used = new Map();
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  if (!/import \{[^}]*\bt\b[^}]*\} from '[./]+i18n'/.test(src)) continue;
  for (const m of src.matchAll(pattern)) {
    const key = (m[1] ?? m[2]).replace(/\\'/g, "'").replace(/\\"/g, '"');
    if (!used.has(key)) used.set(key, path.relative(SRC, f));
  }
}

// A callback parameter named t hides the translator: t('...') inside it calls the loop item and crashes the page
// ("t is not a function"; found in the toasts, the template list and the theme list).
const shadowed = [];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  if (!/import \{[^}]*\bt\b[^}]*\} from '[./]+i18n'/.test(src)) continue;
  src.split('\n').forEach((line, i) => {
    if (/(^|[(,]\s*)t\s*=>|\(\s*t\s*(,|\)\s*=>)|\bfunction\s*\(\s*t\b/.test(line)) shadowed.push(`${path.relative(SRC, f)}:${i + 1}`);
  });
}
for (const s of shadowed) console.log(`the name t is the translator, rename this parameter: ${s}`);

const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
let failed = shadowed.length > 0;
for (const [code, dict] of dictionaries) {
  const missing = [...used].filter(([k]) => !(k in dict));
  const unused = Object.keys(dict).filter((k) => !used.has(k));
  const badPlaceholders = [...used.keys()].filter((k) => k in dict && placeholders(k) !== placeholders(dict[k]));
  for (const [k, f] of missing) console.log(`[${code}] missing translation (${f}): ${k}`);
  for (const k of unused) console.log(`[${code}] not used any more: ${k}`);
  for (const k of badPlaceholders) console.log(`[${code}] placeholders differ: ${k}`);
  console.log(`[${code}] ${used.size} texts, ${missing.length} without translation, ${unused.length} unused, ${badPlaceholders.length} with other placeholders`);
  if (missing.length || badPlaceholders.length) failed = true;
}
if (!dictionaries.length) console.log('no translation files found');
process.exit(failed ? 1 : 0);
