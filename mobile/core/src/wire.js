import { ProtocolError } from './errors.js';
import { KIND, MAX_NOISE_MESSAGE, PROTOCOL_VERSION } from './constants.js';

/** @type {Set<number>} */
const KINDS = new Set(Object.values(KIND));
const MIN_BODY = {
  [KIND.PAIR_1]: 96, // e (32) + encrypted s (48) + empty payload tag (16)
  [KIND.SESSION_1]: 96,
  [KIND.PAIR_2]: 48, // e (32) + payload tag (16)
  [KIND.SESSION_2]: 48,
  [KIND.DATA]: 16,
};

/**
 * Frame layout on the relay link: [version u8][kind u8][Noise message ...].
 * @param {number} kind one of KIND
 * @param {Uint8Array} body
 * @returns {Uint8Array}
 */
export function encodeFrame(kind, body) {
  if (!KINDS.has(kind) || body.length > MAX_NOISE_MESSAGE) throw new ProtocolError('bad_frame');
  const out = new Uint8Array(2 + body.length);
  out[0] = PROTOCOL_VERSION;
  out[1] = kind;
  out.set(body, 2);
  return out;
}

/**
 * Strict frame parser. Anything unexpected is a ProtocolError, never another exception type.
 * @param {unknown} bytes
 * @returns {{ kind: number, body: Uint8Array }}
 */
export function decodeFrame(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new ProtocolError('bad_frame');
  if (bytes.length < 2) throw new ProtocolError('bad_frame');
  if (bytes[0] !== PROTOCOL_VERSION) throw new ProtocolError('unsupported_version');
  const kind = bytes[1];
  if (!KINDS.has(kind)) throw new ProtocolError('bad_frame');
  const body = bytes.subarray(2);
  if (body.length > MAX_NOISE_MESSAGE || body.length < MIN_BODY[kind]) throw new ProtocolError('bad_frame');
  return { kind, body };
}
