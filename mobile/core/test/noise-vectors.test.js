// Runs the official Noise test vectors against the Noise library we depend on (salty-crypto).
// If the library ever stops reproducing them, this test fails and CI is red: the rule from the
// design is "we replace the library, we never patch the crypto".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Handshake, INTERNALS, Noise_25519_ChaChaPoly_BLAKE2s } from 'salty-crypto';

const dir = new URL('./vectors/', import.meta.url);
const hex = (s) => (s === undefined ? undefined : Uint8Array.from(Buffer.from(s, 'hex')));
const toHex = (b) => Buffer.from(b).toString('hex');
const keypair = (sk) =>
  sk === undefined ? undefined : { secret: sk, public: INTERNALS.dh.x25519.scalarMultBase(sk) };

const FILES = ['cacophony.json', 'snow.json', 'noise-c.json'];
const counts = {};

function runVector(v) {
  const name = v.protocol_name ?? v.name;
  const m = /^Noise_([A-Za-z0-9+]+)_25519_ChaChaPoly_BLAKE2s$/.exec(name);
  assert.ok(m, name);
  const pattern = m[1];
  const psksI = v.init_psks ?? (v.init_psk ? [v.init_psk] : undefined);
  const psksR = v.resp_psks ?? (v.resp_psk ? [v.resp_psk] : undefined);
  const I = new Handshake(Noise_25519_ChaChaPoly_BLAKE2s, pattern, 'initiator', {
    prologue: hex(v.init_prologue),
    staticKeypair: keypair(hex(v.init_static)),
    remoteStaticPublicKey: hex(v.init_remote_static),
    pregeneratedEphemeralKeypair: keypair(hex(v.init_ephemeral)),
    preSharedKeys: psksI?.map(hex),
  });
  const R = new Handshake(Noise_25519_ChaChaPoly_BLAKE2s, pattern, 'responder', {
    prologue: hex(v.resp_prologue),
    staticKeypair: keypair(hex(v.resp_static)),
    remoteStaticPublicKey: hex(v.resp_remote_static),
    pregeneratedEphemeralKeypair: keypair(hex(v.resp_ephemeral)),
    preSharedKeys: psksR?.map(hex),
  });
  const oneWay = pattern.replace(/psk\d|\+/g, '').length === 1;
  const party = { I, R };
  const transport = {};
  let turn = 'I';
  const other = () => (turn === 'I' ? 'R' : 'I');
  v.messages.forEach((msg, i) => {
    if (transport.I && transport.R) {
      const ct = transport[turn].send.encrypt(hex(msg.payload));
      assert.equal(toHex(ct), msg.ciphertext, `${name} message ${i} (transport)`);
      assert.equal(toHex(transport[other()].recv.decrypt(ct)), msg.payload);
    } else {
      const w = party[turn].writeMessage(hex(msg.payload));
      assert.equal(toHex(w.packet), msg.ciphertext, `${name} message ${i} (handshake)`);
      const r = party[other()].readMessage(w.packet);
      assert.equal(toHex(r.message), msg.payload);
      if (w.finished && r.finished) { transport[turn] = w.finished; transport[other()] = r.finished; }
    }
    if (!oneWay) turn = other();
  });
}

for (const file of FILES) {
  const doc = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
  test(`official Noise vectors: ${file} (${doc.vectors.length} vectors, source ${doc.source})`, () => {
    for (const v of doc.vectors) {
      const name = v.protocol_name ?? v.name;
      runVector(v);
      counts[name] = (counts[name] ?? 0) + 1;
    }
  });
}

test('the vectors really cover the two patterns StarkLLM uses', () => {
  const names = Object.keys(counts);
  assert.ok(names.includes('Noise_IK_25519_ChaChaPoly_BLAKE2s'), 'IK vectors missing');
  assert.ok(names.includes('Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s'), 'IKpsk2 vectors missing');
  assert.ok(names.length >= 40, `only ${names.length} distinct protocols ran`);
});
