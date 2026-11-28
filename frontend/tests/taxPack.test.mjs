// The package for the tax advisor (StarkLLM 2.8, option 11): the review list with the user's changes, what the export
// request sends, the password check and the file name from the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultYear, yearChoices, effectiveRows, overridesFrom, passwordProblem, counts, nameFromDisposition, MIN_PASSWORD,
} from '../src/utils/taxPack.js';

const ROWS = [
  { key: 'ws-1', category: 'tax', category_source: 'rules', included: true },
  { key: 'ws-2', category: 'housing', category_source: 'rules', included: true },
  { key: 'ws-3', category: 'tax', category_source: 'rules', included: false, excluded_reason: 'scam' },
  { key: 'ws-4', category: 'other', category_source: 'rules', included: true, suggested: 'work' },
];

test('the default year is last year, and the offered years include the years with letters', () => {
  const today = new Date('2026-11-28T12:00:00');
  assert.equal(defaultYear(today), 2025);
  assert.deepEqual(yearChoices([2024, 2019, 2025], today), [2026, 2025, 2024, 2019]);
  assert.deepEqual(yearChoices(undefined, today), [2026, 2025]);
});

test('the user changes a category, leaves a document out and takes a scam back in', () => {
  const changes = {
    'ws-1': { included: false },
    'ws-2': { category: 'other', source: 'user' },
    'ws-3': { included: true },
    'ws-4': { category: 'work', source: 'model' },
  };
  const rows = effectiveRows(ROWS, changes);
  assert.deepEqual(rows.map((r) => [r.key, r.category, r.included, r.category_source]), [
    ['ws-1', 'tax', false, 'rules'],
    ['ws-2', 'other', true, 'user'],
    ['ws-3', 'tax', true, 'rules'],
    ['ws-4', 'work', true, 'model'],
  ]);
  assert.deepEqual(overridesFrom(ROWS, changes), [
    { key: 'ws-1', included: false },
    { key: 'ws-2', category: 'other', source: 'user' },
    { key: 'ws-3', included: true },
    { key: 'ws-4', category: 'work', source: 'model' },
  ]);
  assert.deepEqual(counts(rows), { included: 3, excluded: 1, byCategory: { tax: 1, insurance: 0, housing: 0, work: 1, health: 0, other: 1 } });
});

test('changes back to the original send nothing, and unknown categories are ignored', () => {
  const changes = { 'ws-1': { included: true, category: 'tax' }, 'ws-2': { category: 'banana' }, 'ws-9': { included: false } };
  assert.deepEqual(overridesFrom(ROWS, changes), []);
  assert.equal(effectiveRows(ROWS, changes)[1].category, 'housing');
  assert.equal(effectiveRows(ROWS, changes).every((r) => !r.changed), true);
});

test('the password is optional, but if given it is long enough and repeated', () => {
  assert.equal(passwordProblem('', ''), null);
  assert.equal(passwordProblem('short', 'short'), 'short');
  assert.equal(passwordProblem('x'.repeat(MIN_PASSWORD), 'y'.repeat(MIN_PASSWORD)), 'different');
  assert.equal(passwordProblem('correct horse', 'correct horse'), null);
  assert.equal(passwordProblem('', 'something'), 'short');
});

test('the file name comes from the server, else the fallback', () => {
  assert.equal(nameFromDisposition("attachment; filename*=UTF-8''Steuerunterlagen_2025.zip", 'x.zip'), 'Steuerunterlagen_2025.zip');
  assert.equal(nameFromDisposition("attachment; filename*=UTF-8''Vergi_belgeleri_2025%C3%A7.zip", 'x.zip'), 'Vergi_belgeleri_2025ç.zip');
  assert.equal(nameFromDisposition(null, 'x.zip'), 'x.zip');
  assert.equal(nameFromDisposition("attachment; filename*=UTF-8''%E0%A4%A.zip", 'x.zip'), 'x.zip');
});
