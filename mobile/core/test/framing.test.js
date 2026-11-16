// Property and fuzz tests for framing, padding, the transport channel and the QR parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  KIND, MAX_MESSAGE_BYTES, PROTOCOL_VERSION, ProtocolError, REKEY_INTERVAL,
  decodeFrame, encodeFrame, parsePairingUri, buildPairingUri, toBase64Url, fromBase64Url, toHex,
  generateKeyPair, isLowOrderPoint,
} from '../src/index.js';
import { HandshakeInitiator, HandshakeResponder } from '../src/noise.js';
import { PROLOGUE_SESSION } from '../src/constants.js';
import { ROUTING_ID } from './helpers.js';

const bytes = (max = 300) => fc.uint8Array({ minLength: 0, maxLength: max });
const RUNS = { numRuns: 400 };

function channel() {
  const pc = generateKeyPair();
  const phone = generateKeyPair();
  const I = new HandshakeInitiator({ pattern: 'IK', prologue: PROLOGUE_SESSION, staticKey: phone, remoteStaticPublicKey: pc.publicKey });
  const R = new HandshakeResponder({ pattern: 'IK', prologue: PROLOGUE_SESSION, staticKey: pc });
  R.readFirst(I.writeFirst(new Uint8Array(0)));
  const second = R.writeSecond(new Uint8Array(0));
  const { transport: a } = I.readSecond(second.packet);
  return { phone: a, pc: second.transport };
}

test('decodeFrame never throws anything but ProtocolError, whatever the input', () => {
  fc.assert(
    fc.property(fc.oneof(bytes(400), fc.constant(null), fc.string(), fc.constant(undefined), fc.array(fc.nat())), (input) => {
      try {
        const f = decodeFrame(input);
        assert.ok(f.body instanceof Uint8Array);
      } catch (e) {
        assert.ok(e instanceof ProtocolError, `unexpected ${e}`);
      }
    }),
    RUNS,
  );
});

test('encodeFrame/decodeFrame round-trip; wrong version or unknown kind is refused', () => {
  fc.assert(
    fc.property(fc.constantFrom(...Object.values(KIND)), fc.uint8Array({ minLength: 100, maxLength: 500 }), (kind, body) => {
      const f = encodeFrame(kind, body);
      const d = decodeFrame(f);
      assert.equal(d.kind, kind);
      assert.deepEqual(d.body, body);
      const badVersion = f.slice();
      badVersion[0] = PROTOCOL_VERSION + 1;
      assert.throws(() => decodeFrame(badVersion), (e) => e.code === 'unsupported_version');
      const badKind = f.slice();
      badKind[1] = 0;
      assert.throws(() => decodeFrame(badKind), (e) => e.code === 'bad_frame');
    }),
    RUNS,
  );
});

test('transport: any message up to the limit round-trips, ciphertext sizes are padded to 256-byte steps', () => {
  const { phone, pc } = channel();
  fc.assert(
    fc.property(fc.uint8Array({ minLength: 0, maxLength: 3000 }), (msg) => {
      const ct = phone.seal(msg);
      assert.equal((ct.length - 16) % 256, 0);
      assert.deepEqual(pc.open(ct), msg);
    }),
    { numRuns: 200 },
  );
  assert.throws(() => phone.seal(new Uint8Array(MAX_MESSAGE_BYTES + 1)), (e) => e.code === 'too_large');
  assert.deepEqual(pc.open(phone.seal(new Uint8Array(MAX_MESSAGE_BYTES))).length, MAX_MESSAGE_BYTES);
});

test('transport: sizes hide the exact message length (same bucket, same size)', () => {
  const { phone } = channel();
  assert.equal(phone.seal(new Uint8Array(10)).length, phone.seal(new Uint8Array(200)).length);
});

test('replay protection: a replayed, reordered, dropped or tampered message kills the channel', () => {
  for (const attack of ['replay', 'reorder', 'drop', 'flip', 'truncate']) {
    const { phone, pc } = channel();
    const m1 = phone.seal(new Uint8Array([1]));
    const m2 = phone.seal(new Uint8Array([2]));
    const m3 = phone.seal(new Uint8Array([3]));
    if (attack === 'replay') {
      pc.open(m1);
      assert.throws(() => pc.open(m1), ProtocolError);
    } else if (attack === 'reorder') {
      assert.throws(() => pc.open(m2), ProtocolError);
    } else if (attack === 'drop') {
      pc.open(m1);
      assert.throws(() => pc.open(m3), ProtocolError);
    } else if (attack === 'flip') {
      const bad = m1.slice();
      bad[5] ^= 1;
      assert.throws(() => pc.open(bad), ProtocolError);
    } else {
      assert.throws(() => pc.open(m1.slice(0, m1.length - 1)), ProtocolError);
    }
    assert.throws(() => pc.open(m1), (e) => e.code === 'channel_closed', `${attack}: channel stays closed`);
  }
});

test('transport: rekey boundaries stay in sync in both directions over many messages', () => {
  const { phone, pc } = channel();
  for (let i = 0; i < REKEY_INTERVAL * 2 + 5; i++) {
    const m = new Uint8Array([i & 255]);
    assert.deepEqual(pc.open(phone.seal(m)), m);
    assert.deepEqual(phone.open(pc.seal(m)), m);
  }
});

test('fuzz: random bytes fed to an open channel never decrypt and never throw other errors', () => {
  fc.assert(
    fc.property(bytes(600), (garbage) => {
      const { pc } = channel();
      try {
        pc.open(garbage);
        assert.fail('garbage must not decrypt');
      } catch (e) {
        assert.ok(e instanceof ProtocolError);
      }
    }),
    { numRuns: 150 },
  );
});

test('handshake: truncated / mutated first messages are refused as ProtocolError, never crash', () => {
  const pc = generateKeyPair();
  const phone = generateKeyPair();
  const I = new HandshakeInitiator({ pattern: 'IK', prologue: PROLOGUE_SESSION, staticKey: phone, remoteStaticPublicKey: pc.publicKey });
  const first = I.writeFirst(new Uint8Array(5));
  fc.assert(
    fc.property(fc.integer({ min: 0, max: first.length - 1 }), fc.integer({ min: 0, max: 255 }), (pos, val) => {
      const m = first.slice();
      if (m[pos] === val) return;
      m[pos] = val;
      const R = new HandshakeResponder({ pattern: 'IK', prologue: PROLOGUE_SESSION, staticKey: pc });
      assert.throws(() => R.readFirst(m), ProtocolError);
    }),
    RUNS,
  );
  for (let n = 0; n < first.length; n++) {
    const R = new HandshakeResponder({ pattern: 'IK', prologue: PROLOGUE_SESSION, staticKey: pc });
    assert.throws(() => R.readFirst(first.slice(0, n)), ProtocolError);
  }
});

test('handshake: the prologue binds the protocol version/purpose (session vs pairing never mix)', () => {
  const pc = generateKeyPair();
  const phone = generateKeyPair();
  const I = new HandshakeInitiator({ pattern: 'IK', prologue: PROLOGUE_SESSION, staticKey: phone, remoteStaticPublicKey: pc.publicKey });
  const R = new HandshakeResponder({ pattern: 'IK', prologue: new TextEncoder().encode('StarkLLM-remote-v2/session'), staticKey: pc });
  assert.throws(() => R.readFirst(I.writeFirst(new Uint8Array(0))), ProtocolError);
});

test('small-order points are refused as public keys', () => {
  assert.equal(isLowOrderPoint(new Uint8Array(32)), true);
  const one = new Uint8Array(32); one[0] = 1;
  assert.equal(isLowOrderPoint(one), true);
  const pc = generateKeyPair();
  assert.throws(() => new HandshakeInitiator({ pattern: 'IK', prologue: PROLOGUE_SESSION, staticKey: pc, remoteStaticPublicKey: new Uint8Array(32) }), ProtocolError);
  const R = new HandshakeResponder({ pattern: 'IK', prologue: PROLOGUE_SESSION, staticKey: pc });
  assert.throws(() => R.readFirst(new Uint8Array(120)), (e) => e.code === 'bad_key');
});

test('base64url: round-trip, and non-canonical or padded input is refused', () => {
  fc.assert(fc.property(bytes(100), (b) => assert.deepEqual(fromBase64Url(toBase64Url(b)), b)), RUNS);
  assert.throws(() => fromBase64Url('AA=='));
  assert.throws(() => fromBase64Url('AB')); // non-zero trailing bits
  assert.throws(() => fromBase64Url('A+/A'));
});

test('QR parser: valid payloads round-trip; arbitrary strings never throw anything but ProtocolError', () => {
  const pc = generateKeyPair().publicKey;
  const secret = generateKeyPair().secretKey;
  const uri = buildPairingUri({ relay: 'wss://relay.example.org', routingId: ROUTING_ID, pcPublicKey: pc, secret, expiresAt: 1_900_000_000_000, pcName: 'Büro-PC' });
  const o = parsePairingUri(uri);
  assert.equal(toHex(o.pcPublicKey), toHex(pc));
  assert.equal(o.pcName, 'Büro-PC');

  const bad = [
    uri.replace('starkllm://', 'https://'),
    uri.replace('wss%3A%2F%2F', 'ws%3A%2F%2F'),
    uri.replace('v=1', 'v=2'),
    uri + '&extra=1',
    uri + '&id=' + ROUTING_ID,
    uri.replace(/id=[^&]+/, 'id=SHORT'),
    uri.replace(/pk=[^&]+/, 'pk=AAAA'),
    uri.replace(/exp=\d+/, 'exp=soon'),
    uri.replace('relay.example.org', 'user%3Apw%40relay.example.org'),
  ];
  for (const b of bad) assert.throws(() => parsePairingUri(b), ProtocolError, b);
  assert.doesNotThrow(() => parsePairingUri(uri.replace('wss%3A%2F%2Frelay.example.org', 'ws%3A%2F%2Flocalhost%3A8787'), { allowInsecure: true }));
  assert.throws(() => parsePairingUri(uri.replace('wss%3A%2F%2Frelay.example.org', 'ws%3A%2F%2Fevil.example.org'), { allowInsecure: true }));

  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.constant(null), fc.constant(undefined), fc.string().map((s) => 'starkllm://pair?' + s)), (s) => {
      try { parsePairingUri(s); } catch (e) { assert.ok(e instanceof ProtocolError); }
    }),
    RUNS,
  );
});
