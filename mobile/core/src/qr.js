// The pairing QR payload:
//   starkllm://pair?v=1&relay=<wss url>&id=<routing id>&pk=<PC public key>&s=<pairing secret>&exp=<unix s>[&n=<PC name>]
import { ProtocolError } from './errors.js';
import { fromBase64Url, toBase64Url } from './bytes.js';
import { PROTOCOL_VERSION } from './constants.js';

const ROUTING_ID_RE = /^[a-z2-7]{32}$/;
const KNOWN = new Set(['v', 'relay', 'id', 'pk', 's', 'exp', 'n']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * @typedef {object} PairingOffer
 * @property {string} relay relay base URL, wss://... (ws://localhost only with allowInsecure)
 * @property {string} routingId 32 characters base32
 * @property {Uint8Array} pcPublicKey 32 bytes
 * @property {Uint8Array} secret 32 bytes, the IKpsk2 pre-shared key
 * @property {number} expiresAt unix time in milliseconds
 * @property {string} [pcName]
 */

/**
 * @param {PairingOffer} o
 * @returns {string}
 */
export function buildPairingUri(o) {
  const q = new URLSearchParams();
  q.set('v', String(PROTOCOL_VERSION));
  q.set('relay', o.relay);
  q.set('id', o.routingId);
  q.set('pk', toBase64Url(o.pcPublicKey));
  q.set('s', toBase64Url(o.secret));
  q.set('exp', String(Math.floor(o.expiresAt / 1000)));
  if (o.pcName) q.set('n', o.pcName.slice(0, 48));
  return `starkllm://pair?${q.toString()}`;
}

/**
 * Strict parser for the QR payload. Throws ProtocolError("bad_qr") for anything unexpected.
 * @param {string} uri
 * @param {{ allowInsecure?: boolean }} [opts] allowInsecure: accept ws://localhost (development)
 * @returns {PairingOffer}
 */
export function parsePairingUri(uri, opts = {}) {
  const bad = (why) => new ProtocolError('bad_qr', `Invalid pairing QR code: ${why}`);
  if (typeof uri !== 'string' || uri.length > 1024) throw bad('size');
  const m = /^starkllm:\/\/pair\?([^#]*)$/.exec(uri);
  if (!m) throw bad('scheme');
  const params = new URLSearchParams(m[1]);
  /** @type {Record<string, string>} */
  const p = {};
  for (const [k, v] of params) {
    if (!KNOWN.has(k) || Object.hasOwn(p, k)) throw bad(`field ${k.slice(0, 16)}`);
    p[k] = v;
  }
  if (p.v !== String(PROTOCOL_VERSION)) throw new ProtocolError('unsupported_version', 'This QR code needs a different app version.');
  let relayUrl;
  try {
    relayUrl = new URL(p.relay);
  } catch {
    throw bad('relay');
  }
  const secure = relayUrl.protocol === 'wss:';
  const localDev = opts.allowInsecure === true && relayUrl.protocol === 'ws:' && LOCAL_HOSTS.has(relayUrl.hostname);
  if (!secure && !localDev) throw bad('relay must use wss://');
  if (relayUrl.username || relayUrl.password || relayUrl.search || relayUrl.hash) throw bad('relay');
  if (!ROUTING_ID_RE.test(p.id ?? '')) throw bad('id');
  let pcPublicKey, secret;
  try {
    pcPublicKey = fromBase64Url(p.pk);
    secret = fromBase64Url(p.s);
  } catch {
    throw bad('key encoding');
  }
  if (pcPublicKey.length !== 32 || secret.length !== 32) throw bad('key length');
  if (!/^[0-9]{9,11}$/.test(p.exp ?? '')) throw bad('exp');
  const pcName = p.n === undefined ? undefined : p.n;
  if (pcName !== undefined && (pcName.length > 48 || /[\u0000-\u001f\u007f]/.test(pcName))) throw bad('name');
  return {
    relay: relayUrl.origin + relayUrl.pathname.replace(/\/$/, ''),
    routingId: p.id,
    pcPublicKey,
    secret,
    expiresAt: Number(p.exp) * 1000,
    pcName,
  };
}
