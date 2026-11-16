import WebSocket from 'ws';
import { createRelay } from '../src/server.js';
import { generateRelayKey, relaySigner, routingIdFromPublicKey } from '../../mobile/core/src/node.js';
import { RelayPcLink, RelayPhoneLink } from '../../mobile/core/src/index.js';

export async function startRelay(options = {}) {
  const logs = [];
  const taps = [];
  const relay = createRelay({
    log: (l) => logs.push(l),
    debugTap: (buf, direction) => taps.push({ direction, bytes: Buffer.from(buf) }),
    ...options,
  });
  const port = await relay.listen(0, '127.0.0.1');
  return { relay, port, logs, taps, url: `ws://127.0.0.1:${port}`, http: `http://127.0.0.1:${port}` };
}

export function newPcIdentity() {
  const key = generateRelayKey();
  return { key, signer: relaySigner(key), routingId: routingIdFromPublicKey(key.publicKey) };
}

/** Opens a raw ws and resolves with { ws, messages } after the upgrade (or rejects with the HTTP status). */
export function rawConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    const closed = new Promise((res) => ws.on('close', (code, reason) => res({ code, reason: reason.toString() })));
    ws.on('message', (data, isBinary) => messages.push(isBinary ? Buffer.from(data) : data.toString()));
    ws.on('open', () => resolve({ ws, messages, closed }));
    ws.on('unexpected-response', (req, res) => { res.resume(); reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })); });
    ws.on('error', () => {});
  });
}

export const until = async (cond, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
};

export async function connectPc(t, identity, handlers = {}) {
  const frames = [];
  const peers = [];
  const link = new RelayPcLink({
    relay: t.url,
    routingId: identity.routingId,
    signer: identity.signer,
    WebSocketImpl: WebSocket,
    onFrame: (peer, frame) => { frames.push({ peer, frame }); handlers.onFrame?.(peer, frame); },
    onPeer: (peer, up) => { peers.push({ peer, up }); handlers.onPeer?.(peer, up); },
    onClose: handlers.onClose,
  });
  await link.connect();
  return { link, frames, peers };
}

export async function connectPhone(t, routingId, handlers = {}) {
  const frames = [];
  const closes = [];
  const link = new RelayPhoneLink({
    relay: t.url,
    routingId,
    WebSocketImpl: WebSocket,
    onFrame: (f) => { frames.push(f); handlers.onFrame?.(f); },
    onClose: (code) => { closes.push(code); handlers.onClose?.(code); },
  });
  await link.connect();
  return { link, frames, closes };
}

export { WebSocket };
