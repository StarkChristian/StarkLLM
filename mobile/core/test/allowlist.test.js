// The allow-list: anything outside it must be refused and must never reach the engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  ENGINE_METHODS, REQUEST_TYPES, ProtocolError, decodeMessage, encodeMessage, parseRequest, parseResponse,
  encodeFrame, KIND,
} from '../src/index.js';
import { createWorld, fakeEngine, strictEngine } from './helpers.js';

const ALLOWED = Object.keys(REQUEST_TYPES);

test('the allow-list is exactly the documented set', () => {
  assert.deepEqual(
    [...ALLOWED].sort(),
    ['chat.ask', 'cases.list', 'deadlines.list', 'device.info', 'device.rotate_key', 'inbox.list', 'source.open'].sort(),
  );
  assert.deepEqual([...ENGINE_METHODS].sort(), ['casesList', 'chatAsk', 'deadlinesList', 'inboxList', 'sourceOpen']);
  assert.ok(Object.isFrozen(REQUEST_TYPES));
});

// -- generators ----------------------------------------------------------------------------
const jsonValue = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: 'small' },
    fc.constant(null), fc.boolean(), fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true }), fc.string({ maxLength: 40 }),
    fc.array(tie('value'), { maxLength: 4 }),
    fc.dictionary(fc.oneof(fc.string({ maxLength: 12 }), fc.constantFrom('__proto__', 'constructor', 'prototype', 'toString', 'id', 'type', 'params')), tie('value'), { maxKeys: 5 }),
  ),
})).value;

const nearValid = fc.record(
  {
    id: fc.oneof(fc.stringMatching(/^[A-Za-z0-9_-]{1,64}$/), fc.string({ maxLength: 80 }), jsonValue),
    type: fc.oneof(
      fc.constantFrom(...ALLOWED),
      fc.constantFrom(...ALLOWED).map((t) => t.toUpperCase()),
      fc.constantFrom(...ALLOWED).map((t) => ` ${t}`),
      fc.constantFrom('settings.update', 'models.pull', 'backup.restore', 'mcp.call', '__proto__', 'constructor', 'hasOwnProperty', 'toString', ''),
      jsonValue,
    ),
    params: fc.oneof(
      fc.constant(undefined),
      fc.dictionary(
        fc.constantFrom('limit', 'cursor', 'unread_only', 'within_days', 'status', 'question', 'workspace_id', 'conversation_id', 'source_id', 'max_chars', 'public_key', '__proto__', 'constructor', 'x'),
        jsonValue,
        { maxKeys: 6 },
      ),
      jsonValue,
    ),
    extra: jsonValue,
  },
  { requiredKeys: [] },
);

const opaqueId = fc.stringMatching(/^[A-Za-z0-9._:-]{1,40}$/);
const validRequest = fc.oneof(
  fc.record({ type: fc.constant('inbox.list'), params: fc.record({ limit: fc.integer({ min: 1, max: 100 }), unread_only: fc.boolean() }, { requiredKeys: [] }) }),
  fc.record({ type: fc.constant('deadlines.list'), params: fc.record({ within_days: fc.integer({ min: 1, max: 365 }) }, { requiredKeys: [] }) }),
  fc.record({ type: fc.constant('cases.list'), params: fc.record({ status: fc.constantFrom('open', 'closed', 'all'), cursor: opaqueId }, { requiredKeys: [] }) }),
  fc.record({ type: fc.constant('chat.ask'), params: fc.record({ question: fc.string({ minLength: 1, maxLength: 200 }).filter((q) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(q)) }) }),
  fc.record({ type: fc.constant('source.open'), params: fc.record({ source_id: opaqueId }) }),
).map((r) => ({ id: 'v', ...r }));
// a valid request with one random mutation: extra field, wrong type, out-of-range value, ...
const mutated = fc.tuple(validRequest, fc.constantFrom('extra', 'dropParams', 'typeCase', 'badId', 'bigString', 'nullParam')).map(([r, how]) => {
  const m = structuredClone(r);
  if (how === 'extra') m.params = { ...m.params, injected: 1 };
  else if (how === 'dropParams') delete m.params.question, delete m.params.source_id;
  else if (how === 'typeCase') m.type = m.type.toUpperCase();
  else if (how === 'badId') m.id = 'bad id!';
  else if (how === 'bigString') m.params = { ...m.params, question: 'x'.repeat(5000), source_id: 'y'.repeat(500) };
  else m.params = null;
  return m;
});

test('parseRequest: never throws; accepts only allow-listed types with closed, validated params', () => {
  fc.assert(
    fc.property(fc.oneof(nearValid, jsonValue, validRequest, mutated), (msg) => {
      const r = parseRequest(JSON.parse(JSON.stringify(msg ?? null)));
      if (r.ok) {
        assert.ok(ALLOWED.includes(r.request.type));
        assert.match(r.request.id, /^[A-Za-z0-9_-]{1,64}$/);
        const spec = REQUEST_TYPES[r.request.type];
        for (const k of Object.keys(r.request.params)) assert.ok(Object.hasOwn(spec.params, k));
        for (const [k, s] of Object.entries(spec.params)) if (!s.optional) assert.ok(k in r.request.params);
        assert.equal(Object.getPrototypeOf(r.request.params), Object.prototype);
      } else {
        assert.ok(['bad_request', 'unknown_type'].includes(r.code));
      }
    }),
    { numRuns: 3000 },
  );
});

test('parseRequest: oversized, wrongly typed and hostile values are refused', () => {
  const ok = (type, params) => parseRequest({ id: 'a', type, params });
  assert.equal(ok('chat.ask', { question: 'x'.repeat(4001) }).ok, false);
  assert.equal(ok('chat.ask', { question: '' }).ok, false);
  assert.equal(ok('chat.ask', { question: 'ok\u0000' }).ok, false);
  assert.equal(ok('chat.ask', { question: 'ok' }).ok, true);
  assert.equal(ok('inbox.list', { limit: 101 }).ok, false);
  assert.equal(ok('inbox.list', { limit: 1.5 }).ok, false);
  assert.equal(ok('inbox.list', { limit: '5' }).ok, false);
  assert.equal(ok('inbox.list', { limit: Number.MAX_SAFE_INTEGER + 2 }).ok, false);
  assert.equal(ok('inbox.list', JSON.parse('{"__proto__": {"admin": true}}')).ok, false);
  assert.equal(ok('inbox.list', []).ok, false);
  assert.equal(ok('source.open', { source_id: '../../etc/passwd' }).ok, true, 'ids are opaque; the engine adapter looks them up, it never opens paths');
  assert.equal(ok('source.open', { source_id: 'a b' }).ok, false);
  assert.equal(ok('source.open', {}).ok, false);
  assert.equal(ok('cases.list', { status: 'deleted' }).ok, false);
  assert.equal(parseRequest({ id: 'a'.repeat(65), type: 'device.info' }).ok, false);
  assert.equal(parseRequest({ id: 'a b', type: 'device.info' }).ok, false);
  assert.equal(parseRequest([]).ok, false);
  assert.equal(parseRequest('inbox.list').ok, false);
  assert.equal(parseRequest(null).ok, false);
});

test('message decoding is strict (UTF-8, JSON object, size)', () => {
  assert.throws(() => decodeMessage(Uint8Array.of(0xff, 0xfe)), ProtocolError);
  assert.throws(() => decodeMessage(new TextEncoder().encode('[1,2]')), ProtocolError);
  assert.throws(() => decodeMessage(new TextEncoder().encode('not json')), ProtocolError);
  assert.throws(() => decodeMessage(new Uint8Array(70_000)), ProtocolError);
  assert.throws(() => encodeMessage({ x: 'a'.repeat(70_000) }), ProtocolError);
  assert.deepEqual(decodeMessage(encodeMessage({ a: 1 })), { a: 1 });
});

test('parseResponse (phone side): odd shapes become ProtocolError, never other exceptions', () => {
  fc.assert(
    fc.property(fc.dictionary(fc.constantFrom('id', 'ok', 'result', 'error', 'chunk', 'done', 'event', 'data', 'x'), jsonValue, { maxKeys: 5 }), (m) => {
      try { parseResponse(JSON.parse(JSON.stringify(m))); } catch (e) { assert.ok(e instanceof ProtocolError); }
    }),
    { numRuns: 1500 },
  );
});

test('host fuzz: random messages inside an open session never reach the engine unless valid', async () => {
  const w = createWorld({ limits: { requestsPerSecond: 1e9, burst: 1e9, maxInflight: 1000 } });
  const { record } = await w.pairPhone();
  const { client } = await w.connectPhone(record);
  let valid = 0;
  let sent = 0;
  const samples = fc.sample(fc.oneof(nearValid, jsonValue, validRequest, mutated), { numRuns: 400, seed: 42 });
  for (const raw of samples) {
    const msg = JSON.parse(JSON.stringify(raw ?? {}));
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) continue;
    if (typeof msg.id !== 'string') msg.id = `f${sent}`; // keep ids unique so duplicate_id does not hide anything
    else msg.id = `${msg.id}`.slice(0, 50) + `-${sent}`;
    sent++;
    if (parseRequest(msg).ok && w.devices.get(record.deviceId).permissions.includes(REQUEST_TYPES[msg.type].permission)) {
      if (REQUEST_TYPES[msg.type].method) valid++;
    }
    const idOk = /^[A-Za-z0-9_-]{1,64}$/.test(msg.id);
    // a request whose id the PC cannot read gets an error that belongs to no request: don't wait for it
    await client._unsafeSend(msg, { noReply: !idOk }).catch((e) => assert.ok(e instanceof ProtocolError, String(e)));
  }
  await w.tick(); await w.tick();
  assert.equal(client.state, 'session', 'the session survived the whole fuzz run');
  assert.ok(sent > 200);
  assert.ok(valid >= 3, `fuzz must also produce some valid requests (got ${valid})`);
  // every engine call corresponds to a request that the strict parser accepts
  assert.equal(w.engine.calls.length, valid);
  for (const [name, params] of w.engine.calls) {
    assert.ok(ENGINE_METHODS.includes(name));
    assert.equal(Object.getPrototypeOf(params), Object.prototype);
  }
});

test('host fuzz: random frames on the link never throw, never reach the engine, never produce a reply', async () => {
  const w = createWorld();
  await fc.assert(
    fc.asyncProperty(fc.uint8Array({ minLength: 0, maxLength: 400 }), fc.constantFrom(...Object.values(KIND)), async (body, kind) => {
      const before = w.log.toPhone.length;
      const frames = [body, encodeFrame(kind, body.length < 100 ? new Uint8Array(100).map((_, i) => body[i] ?? i) : body)];
      for (const f of frames) await w.host.handleFrame('fuzz-peer', f);
      assert.equal(w.log.toPhone.length, before, 'no reply to garbage');
    }),
    { numRuns: 300 },
  );
  assert.equal(w.engine.calls.length, 0);
});

test('engine adapter: a throwing engine produces a generic error, not the internal message', async () => {
  const engine = strictEngine({ ...fakeEngine(), inboxList: async () => { throw new Error('SECRET-INTERNAL-PATH C:\\Users\\Christian\\db.sqlite'); } });
  const w = createWorld({ engine });
  const { record } = await w.pairPhone();
  const { client } = await w.connectPhone(record);
  await assert.rejects(client.request('inbox.list'), (e) => e.code === 'engine_error' && !/SECRET|Users/.test(e.message));
});

test('limits: rate limit and duplicate request ids', async () => {
  const w = createWorld({ limits: { requestsPerSecond: 1, burst: 3 } });
  const { record } = await w.pairPhone();
  const { client } = await w.connectPhone(record);
  const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map(() => client.request('device.info')));
  assert.ok(results.some((r) => r.status === 'fulfilled'));
  assert.ok(results.some((r) => r.status === 'rejected' && r.reason.code === 'rate_limited'));

  const w2 = createWorld();
  const p = await w2.pairPhone();
  const c2 = (await w2.connectPhone(p.record)).client;
  await c2._unsafeSend({ id: 'same', type: 'device.info' });
  await assert.rejects(c2._unsafeSend({ id: 'same', type: 'device.info' }), (e) => e.code === 'duplicate_id');
});
