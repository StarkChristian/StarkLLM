// The read requests added after the owner's review: knowledge-base search, workspaces and chats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers.js';

async function ready(opts) {
  const w = createWorld(opts);
  const { record } = await w.pairPhone({ permissions: ['read'] });
  const { client } = await w.connectPhone(record);
  return { w, client };
}

test('kb.search, workspaces.list and chats.list work for a read-only phone', async () => {
  const { w, client } = await ready();
  const hits = await client.request('kb.search', { query: 'Einspruchsfrist', limit: 5 });
  assert.equal(hits.hits[0].source_id, 'src-1');
  assert.equal((await client.request('workspaces.list')).items[0].name, 'Steuer');
  assert.equal((await client.request('chats.list', { workspace_id: 'w1', limit: 10 })).items[0].id, 'ch1');
  assert.deepEqual(w.engine.calls.map((c) => c[0]), ['kbSearch', 'workspacesList', 'chatsList']);
  // the engine receives the validated copy and the device context
  assert.deepEqual(w.engine.calls[0][1], { query: 'Einspruchsfrist', limit: 5 });
  assert.equal(w.engine.calls[0][2].deviceName, 'iPhone of Christian');
});

test('the new read requests refuse bad parameters and never reach the engine', async () => {
  const { w, client } = await ready();
  const refuse = (type, params) => assert.rejects(client._unsafeSend({ type, params }), (e) => e.code === 'bad_request', `${type} ${JSON.stringify(params).slice(0, 60)}`);
  await refuse('kb.search', {});
  await refuse('kb.search', { query: '' });
  await refuse('kb.search', { query: 'x'.repeat(501) });
  await refuse('kb.search', { query: 'ok', limit: 21 });
  await refuse('kb.search', { query: 'ok', limit: 0 });
  await refuse('kb.search', { query: 'ok', path: '/etc/passwd' });
  await refuse('kb.search', { query: 'a\u0000b' });
  await refuse('kb.search', { query: ['a'] });
  await refuse('workspaces.list', { limit: 1000 });
  await refuse('workspaces.list', { all: true });
  await refuse('chats.list', { workspace_id: 'has space' });
  await refuse('chats.list', { workspace_id: '../x y' });
  await refuse('chats.list', { limit: '5' });
  await assert.rejects(client._unsafeSend({ type: 'chats.messages', params: { chat_id: 'ch1' } }), (e) => e.code === 'unknown_type');
  await assert.rejects(client._unsafeSend({ type: 'kb.delete', params: { source_id: 'src-1' } }), (e) => e.code === 'unknown_type');
  assert.equal(w.engine.calls.length, 0);
});

test('an engine error in a new request type becomes a generic error', async () => {
  const { w, client } = await ready();
  const orig = w.engine.kbSearch;
  w.engine.kbSearch = async () => { throw new Error('chroma at C:\\Users\\Christian\\data failed'); };
  await assert.rejects(client.request('kb.search', { query: 'x' }), (e) => e.code === 'engine_error' && !/Users|chroma/.test(e.message));
  w.engine.kbSearch = orig;
});
