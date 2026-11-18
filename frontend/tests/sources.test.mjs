import { test } from 'node:test';
import assert from 'node:assert/strict';
import { citedSources } from '../src/utils/citedSources.js';

const ws = ['contract.pdf (Page 2)', 'notes.md (Chunk 3)'];

test('the chips show the files the answer names', () => {
  const r = citedSources({ content: 'According to [contract.pdf] the rent is 900 EUR.', wsSources: ws, sourcesMode: 'maybe' });
  assert.deepEqual(r.ws, ['contract.pdf (Page 2)']);
});

test('a code answer to a message that only may be about the documents lists no sources', () => {
  const r = citedSources({ content: '```python\ndef add(a, b):\n    return a + b\n```', wsSources: ws, sourcesMode: 'maybe' });
  assert.deepEqual(r.ws, []);
  assert.deepEqual(r.kb, []);
});

test('a question about the documents keeps all sources when the answer names none', () => {
  const r = citedSources({ content: 'The rent is 900 EUR.', wsSources: ws, sourcesMode: 'documents' });
  assert.deepEqual(r.ws, ws);
  const older = citedSources({ content: 'The rent is 900 EUR.', wsSources: ws });
  assert.deepEqual(older.ws, ws);
});
