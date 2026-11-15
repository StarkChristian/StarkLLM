import { createHash, createPublicKey, verify } from 'node:crypto';
import { RELAY_PROTOCOL } from './protocol.js';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const x of buf) {
    value = (value << 8) | x;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** Routing id = base32(first 20 bytes of SHA-256(Ed25519 public key)). */
export function routingIdFromPublicKey(pk) {
  return base32(createHash('sha256').update(pk).digest().subarray(0, 20));
}

export function authMessage(routingId, nonce) {
  return Buffer.from(`${RELAY_PROTOCOL}|pc-auth|${routingId}|${nonce}`, 'utf8');
}

/** True only if `pk` hashes to `routingId` and `sig` is a valid Ed25519 signature of the challenge. */
export function verifyPcAuth(routingId, nonce, pkB64, sigB64) {
  try {
    const pk = Buffer.from(pkB64, 'base64url');
    const sig = Buffer.from(sigB64, 'base64url');
    if (pk.length !== 32 || sig.length !== 64) return false;
    if (routingIdFromPublicKey(pk) !== routingId) return false;
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pk]), format: 'der', type: 'spki' });
    return verify(null, authMessage(routingId, nonce), key, sig);
  } catch {
    return false;
  }
}
