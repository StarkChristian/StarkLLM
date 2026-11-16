// WebSocket clients for the relay: one for the PC (authenticated with its relay key) and one for
// a phone. The WebSocket class is injected, so this works with `ws` in Node and with the browser
// or React Native WebSocket on the phone.
import { fromHex, toBase64Url, toHex, concat } from './bytes.js';
import { CLOSE, pcAuthMessage, PATH_PC, PATH_PHONE, PEER_ID_BYTES } from './relay-protocol.js';
import { ProtocolError } from './errors.js';
import { MAX_WIRE_FRAME } from './constants.js';

function open(WebSocketImpl, url) {
  const ws = new WebSocketImpl(url);
  ws.binaryType = 'arraybuffer';
  return ws;
}

const asBytes = (data) => (data instanceof Uint8Array ? data : new Uint8Array(data));

/**
 * @typedef {object} PcLinkOptions
 * @property {string} relay base URL, wss://relay.example.org
 * @property {string} routingId
 * @property {{ publicKey: Uint8Array, sign: (message: Uint8Array) => Uint8Array | Promise<Uint8Array> }} signer Ed25519
 * @property {new (url: string) => any} WebSocketImpl
 * @property {(peerId: string, frame: Uint8Array) => void} onFrame
 * @property {(peerId: string, up: boolean) => void} [onPeer]
 * @property {(code: number, reason: string) => void} [onClose]
 */

export class RelayPcLink {
  /** @param {PcLinkOptions} o */
  constructor(o) {
    this.o = o;
    this.ws = null;
  }

  /** @returns {Promise<void>} resolves when the relay accepted the PC */
  connect() {
    const { relay, routingId, signer, WebSocketImpl } = this.o;
    const ws = (this.ws = open(WebSocketImpl, `${relay}${PATH_PC}?id=${routingId}`));
    return new Promise((resolve, reject) => {
      let ready = false;
      ws.onerror = () => {};
      ws.onclose = (ev) => {
        if (!ready) reject(new ProtocolError('relay_closed', `relay closed the link (${ev.code})`));
        this.o.onClose?.(ev.code, String(ev.reason ?? ''));
      };
      ws.onmessage = async (ev) => {
        try {
          if (typeof ev.data === 'string') {
            const m = JSON.parse(ev.data);
            if (m.t === 'challenge' && typeof m.nonce === 'string') {
              const sig = await signer.sign(pcAuthMessage(routingId, m.nonce));
              ws.send(JSON.stringify({ t: 'auth', pk: toBase64Url(signer.publicKey), sig: toBase64Url(sig) }));
            } else if (m.t === 'ready') {
              ready = true;
              resolve();
            } else if (m.t === 'peer' && typeof m.peer === 'string') {
              this.o.onPeer?.(m.peer, m.up === true);
            }
            return;
          }
          const bytes = asBytes(ev.data);
          if (bytes.length <= PEER_ID_BYTES || bytes.length > MAX_WIRE_FRAME + PEER_ID_BYTES) return;
          this.o.onFrame(toHex(bytes.subarray(0, PEER_ID_BYTES)), bytes.subarray(PEER_ID_BYTES));
        } catch {
          ws.close(CLOSE.BAD_FRAME, 'bad message');
        }
      };
    });
  }

  /** @param {string} peerId @param {Uint8Array} frame */
  send(peerId, frame) {
    if (this.ws?.readyState === 1) this.ws.send(concat(fromHex(peerId), frame));
  }

  /** Ask the relay to disconnect one phone (revocation). */
  kick(peerId) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'kick', peer: peerId }));
  }

  close() {
    this.ws?.close(1000, 'bye');
  }
}

/**
 * @typedef {object} PhoneLinkOptions
 * @property {string} relay
 * @property {string} routingId
 * @property {new (url: string) => any} WebSocketImpl
 * @property {(frame: Uint8Array) => void} onFrame
 * @property {(code: number, reason: string) => void} [onClose]
 */

export class RelayPhoneLink {
  /** @param {PhoneLinkOptions} o */
  constructor(o) {
    this.o = o;
    this.ws = null;
  }

  /** @returns {Promise<void>} resolves when the relay connected us to the PC's mailbox */
  connect() {
    const ws = (this.ws = open(this.o.WebSocketImpl, `${this.o.relay}${PATH_PHONE}?id=${this.o.routingId}`));
    return new Promise((resolve, reject) => {
      let ready = false;
      ws.onerror = () => {};
      ws.onclose = (ev) => {
        if (!ready) reject(new ProtocolError('relay_closed', `relay closed the link (${ev.code})`));
        this.o.onClose?.(ev.code, String(ev.reason ?? ''));
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            if (JSON.parse(ev.data).t === 'ready') {
              ready = true;
              resolve();
            }
          } catch {
            ws.close(CLOSE.BAD_FRAME, 'bad message');
          }
          return;
        }
        this.o.onFrame(asBytes(ev.data));
      };
    });
  }

  /** @param {Uint8Array} frame */
  send(frame) {
    if (this.ws?.readyState === 1) this.ws.send(frame);
  }

  close() {
    this.ws?.close(1000, 'bye');
  }
}

