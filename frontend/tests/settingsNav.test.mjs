import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { shownSection } from '../src/utils/settingsNav.js';

const IDS = ['account', 'instructions', 'model', 'privacy', 'ui', 'about'];

test('the page asked for is shown, so its tab is the one marked', () => {
  for (const id of IDS) assert.equal(shownSection(IDS, id), id);
});

test('a page that is not in the list shows the first page, and that tab is marked', () => {
  assert.equal(shownSection(IDS.filter((id) => id !== 'account'), 'account'), 'instructions');
  assert.equal(shownSection(IDS, undefined), 'account');
  assert.equal(shownSection(IDS, 'phone'), 'account');
});

// Settings.jsx renders the tab list and the panels from the same value: no panel or tab reads the raw state
test('the tab list and every panel of Settings.jsx follow the shown page', () => {
  const src = readFileSync(new URL('../src/components/Settings.jsx', import.meta.url), 'utf8');
  assert.equal(/activeSection\s*===/.test(src), false, 'a panel or tab still compares the raw state');
  assert.match(src, /shown === id \? styles\.sideNavActive/);
  assert.match(src, /aria-current=\{shown === id \? 'page' : undefined\}/);
  const panels = [...src.matchAll(/\{shown === '([\w-]+)'/g)].map((m) => m[1]);
  for (const id of ['account', 'privacy', 'ui', 'about', 'phone']) assert.ok(panels.includes(id), `panel ${id}`);
});
