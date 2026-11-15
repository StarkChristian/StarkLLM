// Node-only parts (Electron main process / engine host): the Ed25519 relay key, routing ids and
// file-backed storage. The phone never imports this file.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fromBase64Url, toBase32, toBase64Url } from './bytes.js';
import { generateKeyPair, keyPairFromSecret } from './noise.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/**
 * Routing id = base32(first 20 bytes of SHA-256(relay public key)): 32 characters, public, and
 * it reveals nothing but the key's hash.
 * @param {Uint8Array} relayPublicKey
 */
export function routingIdFromPublicKey(relayPublicKey) {
  return toBase32(createHash('sha256').update(relayPublicKey).digest().subarray(0, 20));
}

/** @returns {{ publicKey: Uint8Array, secretKey: Uint8Array }} raw 32-byte Ed25519 keys */
export function generateRelayKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(ED25519_SPKI_PREFIX.length)),
    secretKey: new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(ED25519_PKCS8_PREFIX.length)),
  };
}

/** @param {{ publicKey: Uint8Array, secretKey: Uint8Array }} key */
export function relaySigner(key) {
  const priv = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, key.secretKey]), format: 'der', type: 'pkcs8' });
  return { publicKey: key.publicKey, sign: (/** @type {Uint8Array} */ m) => new Uint8Array(edSign(null, m, priv)) };
}

/** @param {Uint8Array} publicKey @param {Uint8Array} message @param {Uint8Array} signature */
export function verifyRelaySignature(publicKey, message, signature) {
  try {
    const pub = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
    return edVerify(null, message, pub, signature);
  } catch {
    return false;
  }
}

function writeSecretFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path); // atomic replace
  try { chmodSync(path, 0o600); } catch { /* not supported on this file system (Windows): the profile folder is already private */ }
}

/** JSON file store for DeviceRegistry (atomic writes, mode 600). */
export class FileDeviceStore {
  /** @param {string} path */
  constructor(path) {
    this.path = path;
  }
  load() {
    return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : null;
  }
  save(state) {
    writeSecretFile(this.path, JSON.stringify(state, null, 2));
  }
}

/**
 * Loads (or creates on first use) the PC's keys from `dir`: the Noise identity key and the relay
 * key. All keys are created on this PC and never leave it.
 * @param {string} dir e.g. <data folder>/remote
 */
export function loadOrCreateIdentity(dir) {
  const file = join(dir, 'identity.json');
  if (existsSync(file)) {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const relay = { publicKey: fromBase64Url(j.relay.publicKey), secretKey: fromBase64Url(j.relay.secretKey) };
    const current = keyPairFromSecret(fromBase64Url(j.noise.secretKey));
    const previous = j.previous
      ? { keyPair: keyPairFromSecret(fromBase64Url(j.previous.secretKey)), until: j.previous.until }
      : undefined;
    return { noise: { current, previous }, relay, routingId: routingIdFromPublicKey(relay.publicKey), save: (/** @type {any} */ ident) => saveIdentity(file, ident) };
  }
  const ident = { noise: { current: generateKeyPair() }, relay: generateRelayKey() };
  saveIdentity(file, ident);
  return { ...ident, routingId: routingIdFromPublicKey(ident.relay.publicKey), save: (/** @type {any} */ i) => saveIdentity(file, i) };
}

function saveIdentity(file, ident) {
  writeSecretFile(
    file,
    JSON.stringify({
      version: 1,
      noise: { secretKey: toBase64Url(ident.noise.current.secretKey) },
      previous: ident.noise.previous
        ? { secretKey: toBase64Url(ident.noise.previous.keyPair.secretKey), until: ident.noise.previous.until }
        : undefined,
      relay: { publicKey: toBase64Url(ident.relay.publicKey), secretKey: toBase64Url(ident.relay.secretKey) },
    }),
  );
}
