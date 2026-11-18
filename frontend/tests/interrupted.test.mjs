import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withInterruptedNotes, STILL_ANSWERING_MS } from '../src/utils/interrupted.js';

const now = Date.parse('2026-11-18T02:00:00Z');
const old = '2026-11-18T01:00:00Z';

test('a question left without an answer gets a note with the question to try again', () => {
  const out = withInterruptedNotes([{ role: 'user', content: 'Summarize Moby-Dick', created_at: old }], 'NOTE', now);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1], { role: 'assistant', content: 'NOTE', isError: true, failedText: 'Summarize Moby-Dick', interrupted: true });
});

test('a question followed by another question gets the note between them; answered ones none', () => {
  const out = withInterruptedNotes([
    { role: 'user', content: 'a', created_at: old }, { role: 'user', content: 'b', created_at: old },
    { role: 'assistant', content: 'answer' }], 'NOTE', now);
  assert.deepEqual(out.map((m) => m.content), ['a', 'NOTE', 'b', 'answer']);
});

test('a question from the last minutes may still be answered: no note', () => {
  const recent = new Date(now - STILL_ANSWERING_MS + 1000).toISOString();
  assert.equal(withInterruptedNotes([{ role: 'user', content: 'q', created_at: recent }], 'NOTE', now).length, 1);
});
