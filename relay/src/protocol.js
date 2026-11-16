// Link protocol between clients and the relay. Mirrors mobile/core/src/relay-protocol.js (a test
// in test/protocol-sync.test.js fails if the two files drift apart).
export const RELAY_PROTOCOL = 'starkllm-relay-v1';
export const PATH_PC = '/v1/pc';
export const PATH_PHONE = '/v1/phone';
export const PEER_ID_BYTES = 8;

export const CLOSE = Object.freeze({
  RENEW: 4000,
  REPLACED: 4001,
  AUTH_FAILED: 4003,
  PC_OFFLINE: 4004,
  BAD_FRAME: 4008,
  LIMIT: 4009,
  IDLE: 4010,
  RATE_LIMITED: 4029,
});

export const ROUTING_ID_RE = /^[a-z2-7]{32}$/;
