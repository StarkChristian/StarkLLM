// Thin, typed layer over the Noise library (salty-crypto). All cryptography happens inside the
// library; this file only wires handshakes to our framing, padding and rekey policy.
//
//   pairing:  Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s   (phone = initiator, QR secret = PSK)
//   sessions: Noise_IK_25519_ChaChaPoly_BLAKE2s       (phone = initiator)
import { Handshake, INTERNALS, Noise_25519_ChaChaPoly_BLAKE2s, randomBytes } from 'salty-crypto';
import { ProtocolError } from './errors.js';
import { equalBytes, fromHex } from './bytes.js';
import { MAX_MESSAGE_BYTES, MAX_NOISE_MESSAGE, PAD_BLOCK, REKEY_INTERVAL } from './constants.js';

/**
 * @typedef {{ publicKey: Uint8Array, secretKey: Uint8Array }} KeyPair
 */

/** @returns {KeyPair} a fresh X25519 key pair */
export function generateKeyPair() {
  const secretKey = randomBytes(32);
  return keyPairFromSecret(secretKey);
}

/**
 * @param {Uint8Array} secretKey 32 bytes
 * @returns {KeyPair}
 */
export function keyPairFromSecret(secretKey) {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== 32) {
    throw new TypeError('secret key must be 32 bytes');
  }
  return { secretKey: secretKey.slice(), publicKey: INTERNALS.dh.x25519.scalarMultBase(secretKey) };
}

/** @returns {Uint8Array} 32 random bytes */
export const randomSecret = () => randomBytes(32);

// Encodings of the Curve25519 points of small order (and their non-canonical aliases). A DH with
// one of them yields a value the other side can predict, so we refuse them as public keys.
const LOW_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000',
  '0100000000000000000000000000000000000000000000000000000000000000',
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800',
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157',
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f',
].map(fromHex);

/**
 * @param {Uint8Array} pk 32-byte X25519 public key
 * @returns {boolean} true if the point has small order (must be refused)
 */
export function isLowOrderPoint(pk) {
  if (pk.length !== 32) return true;
  const masked = pk.slice();
  masked[31] &= 0x7f; // the top bit is ignored by X25519
  return LOW_ORDER.some((p) => equalBytes(p, masked));
}

/** Zero padding to a multiple of PAD_BLOCK, with a 2-byte length prefix. */
function pad(msg) {
  const total = Math.ceil((msg.length + 2) / PAD_BLOCK) * PAD_BLOCK;
  const out = new Uint8Array(total);
  out[0] = msg.length >> 8;
  out[1] = msg.length & 255;
  out.set(msg, 2);
  return out;
}

function unpad(padded) {
  if (padded.length < PAD_BLOCK || padded.length % PAD_BLOCK !== 0) {
    throw new ProtocolError('bad_padding');
  }
  const len = (padded[0] << 8) | padded[1];
  if (len > MAX_MESSAGE_BYTES || len + 2 > padded.length) throw new ProtocolError('bad_padding');
  for (let i = 2 + len; i < padded.length; i++) {
    if (padded[i] !== 0) throw new ProtocolError('bad_padding');
  }
  return padded.slice(2, 2 + len);
}

/**
 * One direction pair of an established Noise channel.
 *
 * - Every message is encrypted with an implicit 64-bit counter. A replayed, dropped, duplicated or
 *   reordered message fails to decrypt, and a failed decryption kills the channel for good.
 * - Plaintexts are padded to multiples of 256 bytes.
 * - Both sides rekey after every REKEY_INTERVAL messages in each direction (no extra message).
 */
export class Transport {
  /** @param {{send: any, recv: any}} cipherStates @param {Uint8Array} handshakeHash */
  constructor(cipherStates, handshakeHash) {
    this.send = cipherStates.send;
    this.recv = cipherStates.recv;
    /** Channel binding value, identical on both sides. */
    this.handshakeHash = handshakeHash.slice();
    this.sent = 0;
    this.received = 0;
    this.dead = false;
  }

  /**
   * @param {Uint8Array} message at most MAX_MESSAGE_BYTES
   * @returns {Uint8Array} Noise transport message (ciphertext)
   */
  seal(message) {
    if (this.dead) throw new ProtocolError('channel_closed');
    if (message.length > MAX_MESSAGE_BYTES) throw new ProtocolError('too_large');
    const ct = this.send.encrypt(pad(message));
    if (ct.length > MAX_NOISE_MESSAGE) throw new ProtocolError('too_large');
    this.sent++;
    if (this.sent % REKEY_INTERVAL === 0) this.send.rekey();
    return ct;
  }

  /**
   * @param {Uint8Array} ciphertext
   * @returns {Uint8Array} the message; throws ProtocolError (and closes the channel) on any failure
   */
  open(ciphertext) {
    if (this.dead) throw new ProtocolError('channel_closed');
    let padded;
    try {
      if (ciphertext.length > MAX_NOISE_MESSAGE) throw new Error('too long');
      padded = this.recv.decrypt(ciphertext);
    } catch {
      this.dead = true;
      throw new ProtocolError('decrypt_failed');
    }
    this.received++;
    if (this.received % REKEY_INTERVAL === 0) this.recv.rekey();
    try {
      return unpad(padded);
    } catch (e) {
      this.dead = true;
      throw e;
    }
  }
}


/** Initiator side of an IK / IKpsk2 handshake (the phone). */
export class HandshakeInitiator {
  /**
   * @param {object} o
   * @param {'IK'|'IKpsk2'} o.pattern
   * @param {Uint8Array} o.prologue
   * @param {KeyPair} o.staticKey our long-term key
   * @param {Uint8Array} o.remoteStaticPublicKey the PC's public key (from the QR code / pairing)
   * @param {Uint8Array} [o.psk] required for IKpsk2
   * @param {KeyPair} [o.ephemeralForTests] deterministic ephemeral key (test vectors only)
   */
  constructor(o) {
    if ((o.pattern === 'IKpsk2') !== (o.psk !== undefined)) throw new TypeError('psk/pattern mismatch');
    if (isLowOrderPoint(o.remoteStaticPublicKey)) throw new ProtocolError('bad_key');
    this.hs = new Handshake(Noise_25519_ChaChaPoly_BLAKE2s, o.pattern, 'initiator', {
      prologue: o.prologue,
      staticKeypair: { public: o.staticKey.publicKey, secret: o.staticKey.secretKey },
      remoteStaticPublicKey: o.remoteStaticPublicKey,
      pregeneratedEphemeralKeypair: o.ephemeralForTests && {
        public: o.ephemeralForTests.publicKey,
        secret: o.ephemeralForTests.secretKey,
      },
      preSharedKeys: o.psk ? [o.psk] : undefined,
    });
    this.done = false;
  }

  /** @param {Uint8Array} payload @returns {Uint8Array} first handshake message */
  writeFirst(payload) {
    return this.hs.writeMessage(payload).packet;
  }

  /**
   * @param {Uint8Array} packet second handshake message
   * @returns {{ payload: Uint8Array, transport: Transport }}
   */
  readSecond(packet) {
    let r;
    try {
      if (packet.length > MAX_NOISE_MESSAGE) throw new Error('too long');
      if (isLowOrderPoint(packet.subarray(0, 32))) throw new ProtocolError('bad_key');
      r = this.hs.readMessage(packet);
    } catch (e) {
      if (e instanceof ProtocolError) throw e;
      throw new ProtocolError('handshake_failed');
    }
    if (!r.finished) throw new ProtocolError('handshake_failed');
    this.done = true;
    return { payload: r.message, transport: new Transport(r.finished, this.hs.handshakeHash) };
  }
}

/** Responder side of an IK / IKpsk2 handshake (the PC). */
export class HandshakeResponder {
  /**
   * @param {object} o
   * @param {'IK'|'IKpsk2'} o.pattern
   * @param {Uint8Array} o.prologue
   * @param {KeyPair} o.staticKey the PC's long-term key
   * @param {Uint8Array} [o.psk] required for IKpsk2
   * @param {KeyPair} [o.ephemeralForTests]
   */
  constructor(o) {
    if ((o.pattern === 'IKpsk2') !== (o.psk !== undefined)) throw new TypeError('psk/pattern mismatch');
    this.hs = new Handshake(Noise_25519_ChaChaPoly_BLAKE2s, o.pattern, 'responder', {
      prologue: o.prologue,
      staticKeypair: { public: o.staticKey.publicKey, secret: o.staticKey.secretKey },
      pregeneratedEphemeralKeypair: o.ephemeralForTests && {
        public: o.ephemeralForTests.publicKey,
        secret: o.ephemeralForTests.secretKey,
      },
      preSharedKeys: o.psk ? [o.psk] : undefined,
    });
  }

  /**
   * @param {Uint8Array} packet first handshake message
   * @returns {{ payload: Uint8Array, remoteStaticPublicKey: Uint8Array, remoteEphemeralPublicKey: Uint8Array }}
   */
  readFirst(packet) {
    if (packet.length > MAX_NOISE_MESSAGE || packet.length < 32) throw new ProtocolError('handshake_failed');
    const e = packet.slice(0, 32);
    if (isLowOrderPoint(e)) throw new ProtocolError('bad_key');
    let r;
    try {
      r = this.hs.readMessage(packet);
    } catch {
      throw new ProtocolError('handshake_failed');
    }
    const s = this.hs.remoteStaticPublicKey;
    if (!s || isLowOrderPoint(s)) throw new ProtocolError('bad_key');
    return { payload: r.message, remoteStaticPublicKey: s.slice(), remoteEphemeralPublicKey: e };
  }

  /**
   * @param {Uint8Array} payload
   * @returns {{ packet: Uint8Array, transport: Transport }}
   */
  writeSecond(payload) {
    const w = this.hs.writeMessage(payload);
    if (!w.finished) throw new ProtocolError('handshake_failed');
    return { packet: w.packet, transport: new Transport(w.finished, this.hs.handshakeHash) };
  }
}

/**
 * The short code both screens show after pairing: six decimal digits from the handshake hash.
 * The hash covers both ephemeral keys, both static keys and the pairing secret, so a man in the
 * middle cannot make the two screens agree.
 * @param {Uint8Array} handshakeHash
 * @returns {string} "482913"
 */
export function confirmationCode(handshakeHash) {
  const n = ((handshakeHash[0] << 24) | (handshakeHash[1] << 16) | (handshakeHash[2] << 8) | handshakeHash[3]) >>> 0;
  return String(n % 1_000_000).padStart(6, '0');
}

