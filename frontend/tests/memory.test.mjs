import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMemoryHeader, memorySources, provenance, rejectionCode, rememberText, sortMemories, MEMORY_MAX_CHARS } from '../src/utils/memory.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('the memory chip reads the header and ignores anything broken', () => {
  const header = encodeURIComponent(JSON.stringify([{ id: 'a', text: 'I prefer trains.', pinned: true }, { id: 'b', text: '' }, null, { text: 'no id' }]));
  assert.deepEqual(parseMemoryHeader(header), [{ id: 'a', text: 'I prefer trains.', pinned: true }]);
  assert.deepEqual(parseMemoryHeader(''), []);
  assert.deepEqual(parseMemoryHeader(null), []);
  assert.deepEqual(parseMemoryHeader('%E0%A4%A'), []);
  assert.deepEqual(parseMemoryHeader(encodeURIComponent('{"id":"a"}')), []);
  assert.deepEqual(memorySources(undefined), []);
});

test('every entry gets the provenance line that says where it came from', () => {
  assert.equal(provenance({ origin: 'user' }).kind, 'typed');
  assert.deepEqual(provenance({ origin: 'user', chat_id: 3, chat_title: 'Trip', chat_exists: true, from_role: 'user' }), { kind: 'userMessage', chat: 'Trip' });
  assert.equal(provenance({ origin: 'user', chat_id: 3, chat_title: 'Trip', chat_exists: true, from_role: 'assistant' }).kind, 'answer');
  assert.equal(provenance({ origin: 'user', chat_id: 3, chat_title: 'Trip', chat_exists: true }).kind, 'chat');
  assert.equal(provenance({ origin: 'user', chat_id: 3, chat_title: null, chat_exists: false }).kind, 'deletedChat');
  assert.deepEqual(provenance({ origin: 'suggestion', status: 'active', chat_id: 3, chat_title: 'Trip', chat_exists: true }), { kind: 'acceptedFrom', chat: 'Trip' });
  assert.equal(provenance({ origin: 'suggestion', status: 'active' }).kind, 'accepted');
  assert.equal(provenance({ origin: 'suggestion', status: 'suggested', chat_id: 3, chat_title: 'Trip', chat_exists: true }).kind, 'suggestedFrom');
  assert.equal(provenance({ origin: 'suggestion', status: 'suggested' }).kind, 'suggested');
  assert.equal(provenance({ origin: 'legacy', status: 'active' }).kind, 'legacy');
  assert.equal(provenance(null).kind, 'typed');
});

test('a refused memory gives its code so the app can warn in the user\'s language', () => {
  assert.equal(rejectionCode({ detail: { code: 'addresses_ai', message: '...' } }), 'addresses_ai');
  assert.equal(rejectionCode({ detail: 'Not found' }), null);
  assert.equal(rejectionCode(null), null);
});

test('"Remember this" offers the text without tool blocks and within the limit', () => {
  assert.equal(rememberText('I live in Graz.\n```json\n{"x":1}\n```\nThanks'), 'I live in Graz.\n \nThanks');
  assert.equal(rememberText('x'.repeat(MEMORY_MAX_CHARS + 50)).length, MEMORY_MAX_CHARS);
  assert.equal(rememberText(undefined), '');
});

test('pinned memories come first, then the newest', () => {
  const order = sortMemories([
    { id: 'old', created_at: '2026-01-01' }, { id: 'pin', pinned: true, created_at: '2025-01-01' }, { id: 'new', created_at: '2026-11-01' },
  ]).map((m) => m.id);
  assert.deepEqual(order, ['pin', 'new', 'old']);
});

test('the app writes memory only from a click of the user', () => {
  // only the memory panel (typed, edited, accepted) and "Remember this" on a message call the memory routes
  const writers = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const f = path.join(d, e.name);
    if (e.isDirectory()) return walk(f);
    if (!/\.(jsx?|mjs)$/.test(e.name)) return;
    const code = fs.readFileSync(f, 'utf8');
    if (/\/api\/v1\/chat\/memory\//.test(code)) writers.push(path.relative(src, f).split(path.sep).join('/'));
  });
  walk(src);
  assert.deepEqual(writers.sort(), ['components/MemoryManager.jsx', 'components/RememberThis.jsx']);
  const remember = fs.readFileSync(path.join(src, 'components', 'RememberThis.jsx'), 'utf8');
  assert.match(remember, /onSubmit=/);         // saved by the user's button, after the user saw (and could edit) the text
});
