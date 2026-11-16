// Host-level security behaviour: replay of handshakes, expiry, idle/age limits, devices registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceRegistry, MemoryDeviceStore, KIND, ProtocolError, decodeFrame, generateKeyPair, SESSION_IDLE_MS, SESSION_MAX_AGE_MS } from '../src/index.js';
import { HandshakeInitiator } from '../src/noise.js';
import { PROLOGUE_PAIRING } from '../src/constants.js';
import { encodeFrame, encodeMessage, parsePairingUri } from '../src/index.js';
import { createWorld, RELAY, ROUTING_ID } from './helpers.js';

test('a replayed first session message (recorded by the relay) is refused', async () => {
  const w = createWorld();
  const { record } = await w.pairPhone();
  const first = await w.connectPhone(record, 'peer-a');
  first.client.close();
  const msg1 = w.log.toHost.find((m) => m.peerId === 'peer-a' && decodeFrame(m.frame).kind === KIND.SESSION_1);
  assert.ok(msg1);
  const replies = w.log.toPhone.length;
  await w.host.handleFrame('peer-evil', msg1.frame);
  await w.host.handleFrame('peer-evil-2', msg1.frame);
  assert.equal(w.log.toPhone.length, replies, 'the PC answered a replay');
  assert.ok(!w.host.peers.has('peer-evil'));
});

test('a stale first message (older than 2 minutes) is refused even if never seen before', async () => {
  const w = createWorld();
  const { record } = await w.pairPhone();
  const p = w.newPhone('peer-old');
  p.client.now = () => w.now() - 3 * 60_000;
  p.client.startSession(record).catch(() => {});
  await w.tick(); await w.tick();
  assert.equal(p.client.state, 'closed');
  assert.equal(w.engine.calls.length, 0);
});

test('idle sessions end after 10 minutes, long sessions after 1 hour', async () => {
  const w = createWorld();
  const { record } = await w.pairPhone();
  const a = await w.connectPhone(record, 'idle');
  w.advance(SESSION_IDLE_MS + 1);
  w.host.tick();
  await w.tick();
  assert.ok(w.closed.includes('idle'));
  assert.equal(a.client.state, 'closed');

  const b = await w.connectPhone(record, 'long');
  for (let i = 0; i < 7; i++) { // stays active, but passes the hour
    w.advance(SESSION_MAX_AGE_MS / 6);
    if (b.client.state === 'session') await b.client.request('device.info').catch(() => {});
  }
  await w.tick();
  assert.equal(b.client.state, 'closed');
});

test('pending pairing expires if the user does nothing; the phone is told "denied"', async () => {
  const w = createWorld();
  const { uri } = w.host.createPairingOffer({ relay: RELAY, routingId: ROUTING_ID });
  const p = w.newPhone();
  const done = p.client.startPairing(uri, 'x', () => {});
  const result = assert.rejects(done, (e) => e.code === 'pairing_denied' || e.code === 'closed');
  for (let i = 0; i < 20 && !w.host.pendingPairings().length; i++) await w.tick();
  w.advance(5 * 60_000 + 1);
  w.host.tick();
  await result;
  assert.equal(w.devices.list().length, 0);
});

test('the user has five minutes to answer: a pending pairing survives tick() and can still be confirmed', async () => {
  const w = createWorld();
  const { uri } = w.host.createPairingOffer({ relay: RELAY, routingId: ROUTING_ID });
  const p = w.newPhone();
  const done = p.client.startPairing(uri, 'Slow user phone', () => {});
  for (let i = 0; i < 20 && !w.host.pendingPairings().length; i++) await w.tick();
  w.advance(3 * 60_000);
  w.host.tick();
  const [pending] = w.host.pendingPairings();
  assert.ok(pending, 'still pending after three minutes');
  w.host.confirmPairing(pending.pairingId, true);
  assert.equal((await done).deviceId.length > 0, true);
});

test('at most three half-open pairing handshakes per offer; unfinished ones are dropped by tick()', async () => {
  const w = createWorld();
  const { uri } = w.host.createPairingOffer({ relay: RELAY, routingId: ROUTING_ID });
  const offer = parsePairingUri(uri);
  // five phones start the handshake but never send their proof message
  for (let i = 0; i < 5; i++) {
    const hs = new HandshakeInitiator({
      pattern: 'IKpsk2', prologue: PROLOGUE_PAIRING, staticKey: generateKeyPair(),
      remoteStaticPublicKey: offer.pcPublicKey, psk: offer.secret,
    });
    const first = hs.writeFirst(encodeMessage({ v: 1, ts: w.now() }));
    await w.host.handleFrame(`half-${i}`, encodeFrame(KIND.PAIR_1, first));
  }
  const open = () => [...w.host.peers.values()].filter((p) => p.state === 'pairing-half');
  assert.equal(open().length, 3);
  w.advance(61_000);
  w.host.tick();
  assert.equal(open().length, 0);
});

test('a second offer replaces the first; the first QR code stops working', async () => {
  const w = createWorld();
  const { uri: first } = w.host.createPairingOffer({ relay: RELAY, routingId: ROUTING_ID });
  w.host.createPairingOffer({ relay: RELAY, routingId: ROUTING_ID });
  const p = w.newPhone();
  p.client.startPairing(first, 'x', () => {}).catch(() => {});
  await w.tick(); await w.tick();
  assert.equal(w.host.pendingPairings().length, 0);
});

test('device registry: approve, persist, revoke, permissions, rotation rules', () => {
  const store = new MemoryDeviceStore();
  let t = 1000;
  const reg = new DeviceRegistry(store, () => t);
  const k = generateKeyPair();
  const d = reg.approve({ name: '  Evil\u0000 name\n', publicKey: k.publicKey, permissions: ['chat', 'bogus'] });
  assert.equal(d.name, 'Evil name');
  assert.deepEqual(d.permissions, ['read', 'chat'], '"chat" implies "read", unknown permissions are dropped');
  assert.throws(() => reg.approve({ name: 'again', publicKey: k.publicKey }), ProtocolError);

  const again = new DeviceRegistry(store, () => t); // survives a restart
  assert.equal(again.findByPublicKey(k.publicKey).device.id, d.id);

  const k2 = generateKeyPair();
  reg.beginRotation(d.id, k2.publicKey);
  assert.equal(reg.findByPublicKey(k2.publicKey).viaPendingKey, true);
  assert.throws(() => reg.beginRotation(d.id, k.publicKey), ProtocolError, 'cannot rotate to a key that is already in use');
  assert.equal(reg.completeRotation(d.id), true);
  assert.equal(reg.findByPublicKey(k.publicKey), null, 'old key is gone');
  assert.equal(reg.findByPublicKey(k2.publicKey).viaPendingKey, false);

  assert.equal(reg.setPermissions(d.id, ['read']), true);
  assert.deepEqual(reg.get(d.id).permissions, ['read']);
  assert.equal(reg.revoke(d.id), true);
  assert.equal(reg.findByPublicKey(k2.publicKey), null, 'revoked key does not match');
  assert.equal(reg.revoke(d.id), false);
  assert.throws(() => reg.beginRotation(d.id, generateKeyPair().publicKey), ProtocolError);
  assert.equal(new DeviceRegistry(store).get(d.id).status, 'revoked');
});

test('revocation also cancels a rotation that was announced but not yet used', async () => {
  const w = createWorld();
  const { record } = await w.pairPhone();
  const k2 = generateKeyPair();
  w.devices.beginRotation(record.deviceId, k2.publicKey);
  w.host.revokeDevice(record.deviceId);
  assert.equal(w.devices.findByPublicKey(k2.publicKey), null);
});
