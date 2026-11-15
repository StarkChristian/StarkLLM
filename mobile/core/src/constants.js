import { utf8 } from './bytes.js';

/** Protocol version. The first byte of every wire frame; a different value is refused. */
export const PROTOCOL_VERSION = 1;

/** Noise algorithm suite (the part after the pattern name in "Noise_IK_25519_ChaChaPoly_BLAKE2s"). */
export const NOISE_SUITE = '25519_ChaChaPoly_BLAKE2s';

/** The prologue binds the protocol version and the purpose into both handshakes. */
export const PROLOGUE_PAIRING = utf8('StarkLLM-remote-v1/pairing');
export const PROLOGUE_SESSION = utf8('StarkLLM-remote-v1/session');

/** Noise limits every message (handshake and transport) to 65535 bytes. */
export const MAX_NOISE_MESSAGE = 65535;
/** Largest wire frame (2 header bytes + Noise message). */
export const MAX_WIRE_FRAME = MAX_NOISE_MESSAGE + 2;
/** Transport plaintexts are padded to a multiple of this many bytes (hides exact sizes). */
export const PAD_BLOCK = 256;
/** Largest JSON message (before padding) in either direction. */
export const MAX_MESSAGE_BYTES = 60_000;

/** Each side rekeys its sending and receiving key after this many transport messages. */
export const REKEY_INTERVAL = 1000;

export const PAIRING_TTL_MS = 5 * 60_000;
export const HANDSHAKE_MAX_SKEW_MS = 2 * 60_000;
export const SESSION_IDLE_MS = 10 * 60_000;
export const SESSION_MAX_AGE_MS = 60 * 60_000;

/** Permissions a paired phone can have. "chat" includes everything "read" allows. */
export const PERMISSIONS = Object.freeze(['read', 'chat']);

/** Wire frame kinds. */
export const KIND = Object.freeze({
  PAIR_1: 1, // phone -> PC: first IKpsk2 message
  PAIR_2: 2, // PC -> phone: second IKpsk2 message
  SESSION_1: 3, // phone -> PC: first IK message
  SESSION_2: 4, // PC -> phone: second IK message
  DATA: 5, // both directions: Noise transport message
});
