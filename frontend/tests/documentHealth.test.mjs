import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageList, megabytes, noSourceActions, splitWarnings, downloadPercent } from '../src/utils/documentHealth.js';

test('page lists are short', () => {
  assert.equal(pageList([2, 3, 4]), '2, 3, 4');
  assert.equal(pageList(Array.from({ length: 20 }, (_, i) => i + 1), 3), '1, 2, 3 … (+17)');
  assert.equal(pageList(null), '');
});

test('download sizes are whole megabytes', () => {
  assert.equal(megabytes(357941199), '358 MB');
  assert.equal(megabytes(0), '0 MB');
});

test('the no-source notice offers web search only when it was off', () => {
  assert.deepEqual(noSourceActions({ kind: 'no_good_source', web: false }), ['check', 'rephrase', 'web']);
  assert.deepEqual(noSourceActions({ kind: 'no_good_source', web: true }), ['check', 'rephrase']);
});

test('the no-source notice is shown apart from scam warnings and account notes', () => {
  const w = [{ kind: 'scam_signs', file: 'a.pdf' }, { kind: 'account_change' }, { kind: 'no_good_source' }];
  const s = splitWarnings(w);
  assert.equal(s.noSource.kind, 'no_good_source');
  assert.deepEqual(s.serious.map((x) => x.kind), ['scam_signs']);
  assert.deepEqual(s.notes.map((x) => x.kind), ['account_change']);
  assert.equal(splitWarnings(undefined).noSource, null);
});

test('download progress', () => {
  assert.equal(downloadPercent({ state: 'downloading', done: 50, total: 200 }), 25);
  assert.equal(downloadPercent({ state: 'idle', done: 200, total: 200 }), null);
});
