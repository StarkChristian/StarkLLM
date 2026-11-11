// Checks the German UI: every text passed to t() in a translated file has a German translation, and the dictionary
// has no entries that are not used any more. Run with: npm run i18n:check
// A file counts as translated once it imports t from the i18n module.
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
const de = JSON.parse(fs.readFileSync(path.join(SRC, 'i18n', 'de.json'), 'utf8'));

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

const missing = [...used].filter(([k]) => !(k in de));
const unused = Object.keys(de).filter((k) => !used.has(k));
const placeholders = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
const badPlaceholders = [...used.keys()].filter((k) => k in de && placeholders(k) !== placeholders(de[k]));

for (const [k, f] of missing) console.log(`missing German text (${f}): ${k}`);
for (const k of unused) console.log(`not used any more: ${k}`);
for (const k of badPlaceholders) console.log(`placeholders differ: ${k}`);
console.log(`${used.size} texts, ${missing.length} without German, ${unused.length} unused, ${badPlaceholders.length} with other placeholders`);
process.exit(missing.length || badPlaceholders.length || shadowed.length ? 1 : 0);
