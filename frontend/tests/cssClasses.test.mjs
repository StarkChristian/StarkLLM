// Every class a component takes from its CSS module (styles.x) exists in that file. A merge once emptied
// ChatArea.module.css and the whole chat lost its look; the unit tests did not notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KNOWN_GAPS = new Set(); // none left (the old gaps were styled on 22 Nov 2026)

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

test('every styles.x used in a component is defined in its CSS module', () => {
  const missing = [];
  for (const f of files(src).filter((x) => x.endsWith('.jsx'))) {
    const code = fs.readFileSync(f, 'utf8');
    for (const m of code.matchAll(/import\s+(\w+)\s+from\s+'(\.[^']+\.module\.css)'/g)) {
      const name = m[1];
      const css = fs.readFileSync(path.join(path.dirname(f), m[2]), 'utf8');
      const defined = new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((x) => x[1]));
      for (const u of code.matchAll(new RegExp(`\\b${name}\\.([A-Za-z_]\\w*)`, 'g'))) {
        if (!defined.has(u[1]) && !KNOWN_GAPS.has(`${path.relative(src, f).split(path.sep).join('/')}: ${name}.${u[1]}`)) missing.push(`${path.relative(src, f)}: ${name}.${u[1]}`);
      }
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});
