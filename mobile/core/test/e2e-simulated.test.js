// Simulated end-to-end test: QR payload + confirmation code, session, an allow-listed request
// answered by a fake engine, and refused requests. No network: the "relay" is an in-memory pipe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePairingUri, ProtocolError, generateKeyPair } from '../src/index.js';
import { createWorld, fakeEngine, strictEngine, RELAY, ROUTING_ID } from './helpers.js';

test('pairing: QR payload, matching 6-digit code, user confirmation, then approved', async () => {
  const w = createWorld();
  const { uri, expiresAt } = w.host.createPairingOffer({ relay: RELAY, routingId: ROUTING_ID });

  // The QR payload is a strictly parsed URI with exactly the fields of the design.
  const offer = parsePairingUri(uri);
  assert.equal(offer.relay, RELAY);
  assert.equal(offer.routingId, ROUTING_ID);
  assert.equal(offer.pcPublicKey.length, 32);
  assert.equal(offer.secret.length, 32);
  assert.equal(offer.expiresAt, Math.floor(expiresAt / 1000) * 1000);

  const { peerId, client } = w.newPhone();
  let phoneCode = null;
  const done = client.startPairing(uri, 'iPhone of Christian', (c) => (phoneCode = c));
  for (let i = 0; i < 20 && !w.host.pendingPairings().length; i++) await w.tick();

  const [pending] = w.host.pendingPairings();
  assert.ok(pending, 'the PC shows a pending pairing');
  assert.equal(pending.deviceName, 'iPhone of Christian');
  assert.match(pending.code, /^\d{6}$/);
  assert.equal(phoneCode, pending.code, 'phone and PC screens show the same code');
  assert.equal(w.devices.list().length, 0, 'nothing is approved before the user presses Allow');

  w.host.confirmPairing(pending.pairingId, true);
  const record = await done;
  assert.equal(w.devices.list().length, 1);
  assert.equal(record.routingId, ROUTING_ID);
  assert.deepEqual(record.permissions, ['read', 'chat']);
  assert.ok(w.closed.includes(peerId), 'the pairing channel is closed after the result');
});

test('session: allow-listed requests are answered by the fake engine (inbox, deadlines, cases, ask, source)', async () => {
  const w = createWorld();
  const { record } = await w.pairPhone();
  const { client } = await w.connectPhone(record);

  const inbox = await client.request('inbox.list', { limit: 10, unread_only: true });
  assert.equal(inbox.items[0].from, 'Finanzamt Berlin');
  const dl = await client.request('deadlines.list', { within_days: 30 });
  assert.equal(dl.items[0].due, '2026-12-01');
  const cases = await client.request('cases.list', { status: 'open' });
  assert.equal(cases.items[0].id, 'c1');

  const chunks = [];
  const answer = await client.request('chat.ask', { question: 'Wann endet die Einspruchsfrist?' }, { onChunk: (c) => chunks.push(c.delta) });
  assert.equal(chunks.join(''), 'Die Frist endet am 1. Dezember.');
  assert.equal(answer.citations[0].source_id, 'src-1');

  const src = await client.request('source.open', { source_id: answer.citations[0].source_id });
  assert.match(src.text, /Frist/);

  const info = await client.request('device.info');
  assert.equal(info.pc_name, 'Christian-PC');

  // exactly the five engine methods were used, with validated params and the device context
  const names = w.engine.calls.map((c) => c[0]);
  assert.deepEqual(names, ['inboxList', 'deadlinesList', 'casesList', 'chatAsk', 'sourceOpen']);
  assert.equal(w.engine.calls[0][2].deviceName, 'iPhone of Christian');
});

test('refused: requests outside the allow-list never reach the engine', async () => {
  const w = createWorld();
  const { record } = await w.pairPhone();
  const { client } = await w.connectPhone(record);

  for (const type of ['settings.update', 'models.pull', 'backup.restore', 'mcp.call', 'code.execute', 'http.get', 'constructor', '__proto__', 'inbox.list ']) {
    await assert.rejects(client._unsafeSend({ type, params: {} }), (e) => e.code === 'unknown_type', type);
  }
  await assert.rejects(client._unsafeSend({ type: 'inbox.list', params: { limit: 10, evil: true } }), (e) => e.code === 'bad_request');
  await assert.rejects(client._unsafeSend({ type: 'inbox.list', params: { limit: 1e9 } }), (e) => e.code === 'bad_request');
  await assert.rejects(client._unsafeSend({ type: 'chat.ask', params: {} }), (e) => e.code === 'bad_request');
  await assert.rejects(client._unsafeSend({ type: 'inbox.list', extra: 1 }), (e) => e.code === 'bad_request');
  assert.equal(w.engine.calls.length, 0, 'the engine was not touched by any refused request');

  // the same session still works afterwards
  assert.ok((await client.request('inbox.list')).items.length);
  assert.equal(w.engine.calls.length, 1);
});

test('permissions: a read-only phone cannot ask questions', async () => {
  const w = createWorld();
  const { record } = await w.pairPhone({ permissions: ['read'] });
  const { client } = await w.connectPhone(record);
  assert.ok((await client.request('inbox.list')).items.length);
  await assert.rejects(client.request('chat.ask', { question: 'hello' }), (e) => e.code === 'forbidden');
  assert.deepEqual(w.engine.calls.map((c) => c[0]), ['inboxList']);
});

test('denied pairing: the user presses Deny, the phone is not approved', async () => {
  const w = createWorld();
  await assert.rejects(w.pairPhone({ approve: false }), (e) => e.code === 'pairing_denied');
  assert.equal(w.devices.list().length, 0);
});

test('revoked phone: live session is closed and its key stops working at once', async () => {
  const w = createWorld();
  const { record } = await w.pairPhone();
  const { client, peerId } = await w.connectPhone(record);
  assert.ok((await client.request('inbox.list')).items.length);

  w.host.revokeDevice(record.deviceId);
  await w.tick();
  await assert.rejects(client.request('inbox.list'), (e) => e.code === 'bad_state' || e.code === 'closed');
  assert.ok(w.closed.includes(peerId));

  // a new session attempt is dropped silently: no reply frame of any kind
  const before = w.log.toPhone.length;
  const second = w.newPhone();
  const attempt = second.client.startSession(record);
  attempt.catch(() => {});
  await w.tick(); await w.tick();
  assert.equal(w.log.toPhone.length, before, 'the PC sends nothing to a revoked key');
  assert.equal(w.engine.calls.length, 1);
});

test('stolen QR code: someone else scans it first; the user sees a different phone and denies', async () => {
  const w = createWorld();
  const { uri } = w.host.createPairingOffer({ relay: RELAY, routingId: ROUTING_ID });
  const attacker = w.newPhone();
  const attackerDone = attacker.client.startPairing(uri, 'Unknown device', () => {});
  attackerDone.catch(() => {});
  for (let i = 0; i < 20 && !w.host.pendingPairings().length; i++) await w.tick();
  const [p] = w.host.pendingPairings();
  assert.equal(p.deviceName, 'Unknown device');
  w.host.confirmPairing(p.pairingId, false); // the user does not recognise it
  await assert.rejects(attackerDone, (e) => e.code === 'pairing_denied');
  assert.equal(w.devices.list().length, 0);

  // the secret is spent: the real phone with the same QR code gets nothing
  const real = w.newPhone();
  const realDone = real.client.startPairing(uri, 'iPhone of Christian', () => {});
  realDone.catch(() => {});
  await w.tick(); await w.tick();
  assert.equal(w.host.pendingPairings().length, 0);
});

test('QR code expires after 5 minutes and can only be used once', async () => {
  const w = createWorld();
  const { uri } = w.host.createPairingOffer({ relay: RELAY, routingId: ROUTING_ID });
  w.advance(5 * 60_000 + 1);
  const late = w.newPhone();
  assert.throws(() => late.client.startPairing(uri, 'x', () => {}), (e) => e.code === 'expired_qr');

  // even a phone with an old clock cannot get through: the PC refuses an expired offer
  const w2 = createWorld();
  const { uri: uri2 } = w2.host.createPairingOffer({ relay: RELAY, routingId: ROUTING_ID });
  const early = w2.newPhone();
  early.client.now = () => w2.now() - 10 * 60_000; // phone thinks it is earlier
  w2.advance(5 * 60_000 + 1);
  const d = early.client.startPairing(uri2, 'x', () => {});
  d.catch(() => {});
  await w2.tick(); await w2.tick();
  assert.equal(w2.host.pendingPairings().length, 0);
});

test('wrong pairing secret: the PC never shows a pairing', async () => {
  const w = createWorld();
  const { uri } = w.host.createPairingOffer({ relay: RELAY, routingId: ROUTING_ID });
  const forged = uri.replace(/s=[^&]+/, 's=' + 'A'.repeat(43));
  const p = w.newPhone();
  const d = p.client.startPairing(forged, 'x', () => {});
  d.catch(() => {});
  await w.tick(); await w.tick(); await w.tick();
  assert.equal(w.host.pendingPairings().length, 0);
  assert.equal(w.devices.list().length, 0);
});

test('PC key rotation: old key accepted during the grace period, phone learns the new key', async () => {
  const w = createWorld();
  const { record } = await w.pairPhone();
  let updated = null;
  const first = await w.connectPhone(record);
  first.client.close();
  const newKey = generateKeyPair();
  w.host.rotateIdentity(newKey);
  const second = w.newPhone(undefined, { onRecordChange: (r) => (updated = r) });
  await second.client.startSession(record); // still the old PC key
  await w.tick(); await w.tick();
  assert.ok(updated, 'phone was told the new key inside the session');
  assert.notEqual(updated.pcPublicKey, record.pcPublicKey);
  const third = w.newPhone();
  await third.client.startSession(updated);
  assert.ok((await third.client.request('inbox.list')).items.length);
});

test('phone key rotation: announced inside a session, old key retired after the first session with the new one', async () => {
  const w = createWorld();
  const { record } = await w.pairPhone();
  const first = await w.connectPhone(record);
  const rotated = await first.client.rotateDeviceKey();
  assert.notEqual(rotated.deviceKey.publicKey, record.deviceKey.publicKey);
  assert.equal(w.devices.get(record.deviceId).publicKey, record.deviceKey.publicKey, 'old key stays until the new one is used');
  first.client.close();

  const p = await w.connectPhone(rotated);
  assert.ok((await p.client.request('inbox.list')).items.length);
  assert.equal(w.devices.get(record.deviceId).publicKey, rotated.deviceKey.publicKey);

  // the old key no longer works
  const before = w.log.toPhone.length;
  const old = w.newPhone();
  old.client.startSession(record).catch(() => {});
  await w.tick(); await w.tick();
  assert.equal(w.log.toPhone.length, before);
});
