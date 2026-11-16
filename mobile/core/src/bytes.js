// Small byte helpers; the same code runs in Node, browsers and React Native (Hermes).

import { randomBytes } from 'salty-crypto';

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

/** @param {string} s */
export const utf8 = (s) => enc.encode(s);

/**
 * Strict UTF-8 decoding: invalid sequences throw instead of being replaced.
 * @param {Uint8Array} b
 */
export const fromUtf8 = (b) => dec.decode(b);

/** @param {...Uint8Array} parts */
export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * Comparison whose running time does not depend on where the arrays differ.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
export function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** @param {Uint8Array} b */
export function toHex(b) {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

/** @param {string} s */
export function fromHex(s) {
  if (typeof s !== 'string' || s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) {
    throw new TypeError('invalid hex');
  }
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/**
 * base64url without padding (RFC 4648 section 5).
 * @param {Uint8Array} b
 */
export function toBase64Url(b) {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < b.length) out += B64[(n >> 6) & 63];
    if (i + 2 < b.length) out += B64[n & 63];
  }
  return out;
}

/**
 * Strict base64url decoding: only the url-safe alphabet, no padding, canonical trailing bits.
 * @param {string} s
 */
export function fromBase64Url(s) {
  if (typeof s !== 'string' || s.length % 4 === 1) throw new TypeError('invalid base64url');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    let n = 0;
    const chunk = s.slice(i, i + 4);
    for (const c of chunk) {
      const v = B64_INDEX.get(c);
      if (v === undefined) throw new TypeError('invalid base64url');
      n = (n << 6) | v;
    }
    n <<= 6 * (4 - chunk.length);
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
    if (chunk.length < 4) {
      // canonical form: unused trailing bits must be zero
      const unused = chunk.length === 2 ? n & 0xffff : n & 0xff;
      if (unused !== 0) throw new TypeError('non-canonical base64url');
    }
  }
  return out;
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * RFC 4648 base32, lower case, no padding.
 * @param {Uint8Array} b
 */
export function toBase32(b) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const x of b) {
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

/**
 * @param {number} n
 * @returns {Uint8Array} n random bytes from the platform's secure random source
 */
export const randomBytesCompat = (n) => randomBytes(n);
