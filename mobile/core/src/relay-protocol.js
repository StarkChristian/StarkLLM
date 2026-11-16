// The link protocol between a client (PC or phone) and the relay. The relay never looks inside
// the binary frames; this file only describes the envelope. relay/src/protocol.js mirrors these
// constants (a test checks that they stay identical).
import { utf8 } from './bytes.js';

export const RELAY_PROTOCOL = 'starkllm-relay-v1';
export const PATH_PC = '/v1/pc';
export const PATH_PHONE = '/v1/phone';
/** The relay adds / strips this many bytes (the phone's connection id) on the PC link. */
export const PEER_ID_BYTES = 8;

/** WebSocket close codes the relay uses. */
export const CLOSE = Object.freeze({
  RENEW: 4000, // max connection age reached: reconnect
  REPLACED: 4001, // the PC connected again
  AUTH_FAILED: 4003,
  PC_OFFLINE: 4004, // the PC went away (or never was there)
  BAD_FRAME: 4008,
  LIMIT: 4009, // too many connections
  IDLE: 4010,
  RATE_LIMITED: 4029,
});

/**
 * The bytes a PC signs with its Ed25519 relay key to prove it owns the routing id.
 * @param {string} routingId @param {string} nonce base64url challenge from the relay
 */
export const pcAuthMessage = (routingId, nonce) => utf8(`${RELAY_PROTOCOL}|pc-auth|${routingId}|${nonce}`);
