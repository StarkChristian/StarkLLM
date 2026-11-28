// Settings > Letters from a folder: the page says the engine's answers in the user's language
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseImportError, ADD_ERRORS, ERROR_KINDS } from '../src/utils/watchFolders.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('an import error is split into its kind and the technical detail', () => {
  assert.deepEqual(parseImportError('too_large: 230 MB'), { kind: 'too_large', detail: '230 MB' });
  assert.deepEqual(parseImportError('move: Access is denied'), { kind: 'move', detail: 'Access is denied' });
  assert.deepEqual(parseImportError('import: disk full: no space'), { kind: 'import', detail: 'disk full: no space' });
  assert.deepEqual(parseImportError('Something else'), { kind: 'other', detail: 'Something else' });
  assert.equal(parseImportError(''), null);
  assert.equal(parseImportError(null), null);
});

test('every kind the engine writes has a sentence on the page', () => {
  const engine = read('../../backend/app/services/watch_service.py');
  const page = read('../src/components/WatchedFolders.jsx');
  for (const kind of ERROR_KINDS) {
    assert.match(engine, new RegExp(`f"${kind}: `), `engine writes ${kind}`);
    assert.match(page, new RegExp(`\\b${kind}: t\\(`), `page says ${kind}`);
  }
});

test('the answers to adding a folder are the engine\'s own texts and are translated', () => {
  const engine = read('../../backend/app/services/watch_service.py') + read('../../backend/app/api/watch_folders.py');
  const page = read('../src/components/WatchedFolders.jsx');
  for (const text of ADD_ERRORS) {
    assert.ok(engine.includes(`"${text}"`), `engine: ${text}`);
    assert.ok(page.includes(`t(${JSON.stringify(text).replace(/^"|"$/g, text.includes("'") ? '"' : "'")})`), `page: ${text}`);
  }
});
