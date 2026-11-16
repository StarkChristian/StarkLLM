import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isHidden, setHidden, guideDone, setGuideDone, stepAfter, GUIDE_POSES, HIDDEN_KEY, GUIDE_KEY } from '../src/utils/lucy.js';

const memory = () => {
  const data = new Map();
  return { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
};
const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };

test('hiding Lucy is remembered, and showing her again too', () => {
  const s = memory();
  assert.equal(isHidden(s), false);
  setHidden(true, s);
  assert.equal(isHidden(s), true);
  assert.equal(s.getItem(HIDDEN_KEY), '1');
  setHidden(false, s);
  assert.equal(isHidden(s), false);
});

test('the first-start guide is shown until it was finished once', () => {
  const s = memory();
  assert.equal(guideDone(s), false);
  setGuideDone(true, s);
  assert.equal(guideDone(s), true);
  assert.equal(s.getItem(GUIDE_KEY), '1');
});

test('a blocked or missing storage never breaks a page: she is simply shown', () => {
  assert.equal(isHidden(blocked), false);
  assert.equal(guideDone(blocked), false);
  assert.doesNotThrow(() => setHidden(true, blocked));
  assert.doesNotThrow(() => setGuideDone(true, blocked));
  assert.equal(isHidden(null), false);
});

test('the guide stays inside its steps and has a pose for each', () => {
  assert.equal(GUIDE_POSES.length, 3);
  assert.equal(stepAfter(0, 3, -1), 0);
  assert.equal(stepAfter(0, 3, 1), 1);
  assert.equal(stepAfter(2, 3, 1), 2);
});

const SRC = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

test('Lucy loads nothing from the network and is not part of error pages', () => {
  const markup = read('assets/lucy/lucy-markup.html');
  const urls = [...markup.matchAll(/(?:href|src)="(https?:[^"]+)"/g)];
  assert.deepEqual(urls, [], 'no external references in the drawing');
  assert.ok(!/url\(\s*['"]?https?:/.test(read('assets/lucy/lucy.css')));
  for (const file of ['components/ErrorBoundary.jsx', 'components/HealthBanner.jsx', 'components/Toast.jsx']) {
    assert.ok(!/Lucy/.test(read(file)), `${file} must not show Lucy`);
  }
});

test('her texts come from the translation files, and she respects reduced motion', () => {
  const component = read('components/Lucy.jsx');
  assert.ok(/prefers-reduced-motion: reduce/.test(component));
  assert.ok(/prefers-reduced-motion: reduce/.test(read('assets/lucy/lucy.css')));
  assert.ok(!/position:\s*fixed/.test(read('components/Lucy.module.css')), 'she is part of the page, not an overlay');
});
