// Phone side of the remote protocol (used by the PWA and later by the React Native app).
// Transport-agnostic: give it a `send(frame)` function (a relay WebSocket) and feed received
// frames to handleFrame().
import { ProtocolError } from './errors.js';
import { fromBase64Url, toBase64Url, randomBytesCompat } from './bytes.js';
import { KIND, PROLOGUE_PAIRING, PROLOGUE_SESSION, PROTOCOL_VERSION } from './constants.js';
import { generateKeyPair, HandshakeInitiator, confirmationCode } from './noise.js';
import { decodeFrame, encodeFrame } from './wire.js';
import { decodeMessage, encodeMessage, parseRequest, parseResponse } from './protocol.js';
import { parsePairingUri } from './qr.js';
import { fileHash, UPLOAD_CHUNK_BYTES } from './files.js';

/**
 * What the phone stores after pairing (keep it in Keychain / Keystore / non-extractable storage).
 * @typedef {object} PairedPc
 * @property {1} version
 * @property {string} relay
 * @property {string} routingId
 * @property {string} pcPublicKey base64url
 * @property {string} pcName
 * @property {string} deviceId
 * @property {string[]} permissions
 * @property {{ publicKey: string, secretKey: string }} deviceKey base64url
 */

/**
 * @typedef {object} ClientOptions
 * @property {(frame: Uint8Array) => void} send
 * @property {() => number} [now]
 * @property {(record: PairedPc) => void} [onRecordChange] called when the PC's key was rotated
 * @property {(event: {event: string, data?: any}) => void} [onEvent]
 * @property {{ allowInsecure?: boolean }} [qr]
 */

export class PhoneClient {
  /** @param {ClientOptions} o */
  constructor(o) {
    this.sendFrame = o.send;
    this.now = o.now ?? Date.now;
    this.onRecordChange = o.onRecordChange ?? (() => {});
    this.onEvent = o.onEvent ?? (() => {});
    this.qrOptions = o.qr ?? {};
    /** @type {'idle'|'pairing-1'|'pairing-wait'|'paired'|'session-1'|'session'|'closed'} */
    this.state = 'idle';
    /** @type {import('./noise.js').Transport | any} */
    this.transport = null;
    /** @type {any} */
    this.hs = null;
    /** @type {any} */
    this.offer = null;
    /** @type {any} */
    this.record = null;
    /** @type {any} */
    this.deviceKeyPair = null;
    /** @type {string} */
    this.deviceName = '';
    /** @type {Map<string, { resolve: Function, reject: Function, onChunk?: Function }>} */
    this.pendingRequests = new Map();
    /** @type {((code: string) => void) | null} */
    /** @type {Map<string, (r: any) => void>} */
    this.uploadWaiters = new Map();
    this.onPairingCode = null;
    /** @type {{ resolve: Function, reject: Function } | null} */
    this.pairingDone = null;
    /** @type {{ resolve: Function, reject: Function } | null} */
    this.sessionReady = null;
  }

  // ------------------------------------------------------------------ pairing

  /**
   * Step 1 of pairing: the phone scanned the QR code.
   * @param {string} qrUri contents of the QR code
   * @param {string} deviceName shown on the PC, e.g. "iPhone of Christian"
   * @param {(code: string) => void} onCode called with the 6-digit code to compare with the PC screen
   * @returns {Promise<PairedPc>} resolves when the user pressed Allow on the PC
   */
  startPairing(qrUri, deviceName, onCode) {
    if (this.state !== 'idle') throw new ProtocolError('bad_state');
    const offer = parsePairingUri(qrUri, this.qrOptions);
    if (this.now() > offer.expiresAt) throw new ProtocolError('expired_qr', 'This QR code has expired. Create a new one on the PC.');
    this.offer = offer;
    this.deviceName = deviceName;
    this.deviceKeyPair = generateKeyPair();
    this.onPairingCode = onCode;
    this.hs = new HandshakeInitiator({
      pattern: 'IKpsk2',
      prologue: PROLOGUE_PAIRING,
      staticKey: this.deviceKeyPair,
      remoteStaticPublicKey: offer.pcPublicKey,
      psk: offer.secret,
    });
    this.state = 'pairing-1';
    const first = this.hs.writeFirst(encodeMessage({ v: PROTOCOL_VERSION, ts: this.now() }));
    this.sendFrame(encodeFrame(KIND.PAIR_1, first));
    return new Promise((resolve, reject) => {
      this.pairingDone = { resolve, reject };
    });
  }

  // ------------------------------------------------------------------ session

  /**
   * Opens an encrypted session with the paired PC.
   * @param {PairedPc} record
   * @returns {Promise<void>} resolves when the PC accepted this phone
   */
  startSession(record) {
    if (this.state !== 'idle') throw new ProtocolError('bad_state');
    this.record = record;
    this.hs = new HandshakeInitiator({
      pattern: 'IK',
      prologue: PROLOGUE_SESSION,
      staticKey: {
        publicKey: fromBase64Url(record.deviceKey.publicKey),
        secretKey: fromBase64Url(record.deviceKey.secretKey),
      },
      remoteStaticPublicKey: fromBase64Url(record.pcPublicKey),
    });
    this.state = 'session-1';
    this.sendFrame(encodeFrame(KIND.SESSION_1, this.hs.writeFirst(encodeMessage({ v: PROTOCOL_VERSION, ts: this.now() }))));
    return new Promise((resolve, reject) => {
      this.sessionReady = { resolve, reject };
    });
  }

  /**
   * Sends a request and resolves with its result. For streaming types (chat.ask) `onChunk`
   * receives every chunk and the promise resolves with the final result (citations).
   * @param {string} type @param {Record<string, unknown>} [params]
   * @param {{ onChunk?: (chunk: any) => void, timeoutMs?: number }} [opts] timeoutMs defaults to 120000
   */
  request(type, params = {}, opts = {}) {
    const id = toBase64Url(randomBytesCompat(12));
    const check = parseRequest({ id, type, params });
    if (!check.ok) return Promise.reject(new ProtocolError(check.code, check.message));
    return this._send({ id, type, params }, id, opts.onChunk, opts.timeoutMs);
  }

  /**
   * Sends a document to the PC. The file travels in 32 KiB chunks with a hash check; the user
   * must press Allow on the PC before it is added. Resolves with the final status
   * ("accepted", "denied", "failed", "expired") once the user has decided.
   * @param {{ name: string, bytes: Uint8Array, workspaceId?: string, onProgress?: (sent: number, total: number) => void,
   *   onPending?: () => void, pollMs?: number, timeoutMs?: number }} file
   * @returns {Promise<{ status: string, document_id?: string }>}
   */
  async uploadDocument(file) {
    const uploadId = toBase64Url(randomBytesCompat(12));
    const chunks = Math.ceil(file.bytes.length / UPLOAD_CHUNK_BYTES);
    const result = new Promise((resolve) => this.uploadWaiters.set(uploadId, resolve));
    try {
      await this.request('documents.upload.begin', {
        upload_id: uploadId, name: file.name, size: file.bytes.length, chunks, hash: fileHash(file.bytes),
        ...(file.workspaceId ? { workspace_id: file.workspaceId } : {}),
      });
      let next = 0;
      let sent = 0;
      const worker = async () => {
        while (next < chunks) {
          const i = next++;
          const part = file.bytes.subarray(i * UPLOAD_CHUNK_BYTES, (i + 1) * UPLOAD_CHUNK_BYTES);
          await this.request('documents.upload.chunk', { upload_id: uploadId, index: i, data: toBase64Url(part) });
          file.onProgress?.(++sent, chunks);
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]); // a window of four requests in flight
      await this.request('documents.upload.finish', { upload_id: uploadId });
    } catch (e) {
      this.uploadWaiters.delete(uploadId);
      this.request('documents.upload.cancel', { upload_id: uploadId }).catch(() => {});
      throw e;
    }
    file.onPending?.();
    // The result arrives as an event; polling covers a missed event or a reconnect.
    const poll = setInterval(async () => {
      try {
        const s = await this.request('documents.upload.status', { upload_id: uploadId });
        if (['accepted', 'denied', 'failed', 'cancelled', 'expired'].includes(s.status)) this.#uploadDone(uploadId, s);
      } catch { /* the session may be closed: the caller sees the timeout */ }
    }, file.pollMs ?? 3000);
    poll.unref?.();
    const timer = setTimeout(() => this.#uploadDone(uploadId, { status: 'expired' }), file.timeoutMs ?? 11 * 60_000);
    timer.unref?.();
    try {
      return await result;
    } finally {
      clearInterval(poll);
      clearTimeout(timer);
    }
  }

  #uploadDone(uploadId, data) {
    const resolve = this.uploadWaiters.get(uploadId);
    if (resolve) {
      this.uploadWaiters.delete(uploadId);
      resolve({ status: data.status, ...(data.document_id ? { document_id: data.document_id } : {}) });
    }
  }

  /**
   * Replaces this phone's key pair: announces a new public key to the PC inside the session.
   * The PC accepts both keys until the first session with the new one; persist the returned
   * record and use it for the next session.
   * @returns {Promise<PairedPc>}
   */
  async rotateDeviceKey() {
    const next = generateKeyPair();
    await this.request('device.rotate_key', { public_key: toBase64Url(next.publicKey) });
    this.record = {
      ...this.record,
      deviceKey: { publicKey: toBase64Url(next.publicKey), secretKey: toBase64Url(next.secretKey) },
    };
    this.onRecordChange(this.record);
    return this.record;
  }

  /**
   * Sends an arbitrary message without client-side checks. For tests of the PC's refusals only.
   * @param {Record<string, unknown>} message
   * @param {{ onChunk?: (chunk: any) => void, noReply?: boolean }} [opts] noReply: do not wait for an answer
   */
  _unsafeSend(message, opts = {}) {
    const id = typeof message.id === 'string' ? message.id : toBase64Url(randomBytesCompat(12));
    if (opts.noReply) {
      if (this.state !== 'session') return Promise.reject(new ProtocolError('bad_state', 'No open session.'));
      this.sendFrame(encodeFrame(KIND.DATA, this.transport.seal(encodeMessage({ ...message, id }))));
      return Promise.resolve(undefined);
    }
    return this._send({ ...message, id }, id, opts.onChunk);
  }

  _send(message, id, onChunk, timeoutMs = 120_000) {
    if (this.state !== 'session') return Promise.reject(new ProtocolError('bad_state', 'No open session.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new ProtocolError('timeout', 'The PC did not answer in time.'));
      }, timeoutMs);
      timer.unref?.();
      const done = (fn) => (v) => {
        clearTimeout(timer);
        fn(v);
      };
      this.pendingRequests.set(id, { resolve: done(resolve), reject: done(reject), onChunk });
      try {
        this.sendFrame(encodeFrame(KIND.DATA, this.transport.seal(encodeMessage(message))));
      } catch (e) {
        this.pendingRequests.delete(id);
        reject(e);
      }
    });
  }

  close(reason = 'closed') {
    for (const resolve of this.uploadWaiters.values()) resolve({ status: 'failed' });
    this.uploadWaiters.clear();
    const err = new ProtocolError('closed', reason);
    this.state = 'closed';
    for (const p of this.pendingRequests.values()) p.reject(err);
    this.pendingRequests.clear();
    this.pairingDone?.reject(err);
    this.sessionReady?.reject(err);
    this.pairingDone = this.sessionReady = null;
  }

  // ------------------------------------------------------------------ incoming

  /** @param {Uint8Array} bytes one frame from the PC */
  handleFrame(bytes) {
    try {
      const { kind, body } = decodeFrame(bytes);
      switch (this.state) {
        case 'pairing-1':
          if (kind !== KIND.PAIR_2) throw new ProtocolError('bad_frame');
          return this.#onPair2(body);
        case 'session-1':
          if (kind !== KIND.SESSION_2) throw new ProtocolError('bad_frame');
          return this.#onSession2(body);
        case 'pairing-wait':
        case 'session':
          if (kind !== KIND.DATA) throw new ProtocolError('bad_frame');
          return this.#onData(body);
        default:
          throw new ProtocolError('bad_frame');
      }
    } catch (e) {
      this.close(e instanceof ProtocolError ? e.code : 'internal_error');
    }
  }

  #onPair2(body) {
    const { transport } = this.hs.readSecond(body);
    this.transport = transport;
    this.state = 'pairing-wait';
    // Proof that we know the pairing secret: the first encrypted message can only be built with
    // keys that depend on it.
    this.sendFrame(encodeFrame(KIND.DATA, transport.seal(encodeMessage({ type: 'pair.hello', name: this.deviceName }))));
    this.onPairingCode?.(confirmationCode(transport.handshakeHash));
  }

  #onSession2(body) {
    const { transport } = this.hs.readSecond(body);
    this.transport = transport;
    this.state = 'session';
    this.sessionReady?.resolve();
    this.sessionReady = null;
  }

  #onData(body) {
    const msg = decodeMessage(this.transport.open(body));
    if (this.state === 'pairing-wait') {
      if (msg.type !== 'pair.result') throw new ProtocolError('bad_message');
      const done = this.pairingDone;
      this.pairingDone = null;
      this.state = 'paired';
      if (msg.approved === true && typeof msg.device_id === 'string') {
        done?.resolve(
          /** @type {PairedPc} */ ({
            version: 1,
            relay: this.offer.relay,
            routingId: this.offer.routingId,
            pcPublicKey: toBase64Url(this.offer.pcPublicKey),
            pcName: typeof msg.pc_name === 'string' ? msg.pc_name.slice(0, 48) : (this.offer.pcName ?? 'PC'),
            deviceId: msg.device_id,
            permissions: Array.isArray(msg.permissions) ? msg.permissions.filter((p) => typeof p === 'string') : [],
            deviceKey: {
              publicKey: toBase64Url(this.deviceKeyPair.publicKey),
              secretKey: toBase64Url(this.deviceKeyPair.secretKey),
            },
          }),
        );
      } else {
        done?.reject(new ProtocolError('pairing_denied', 'The PC did not allow this phone.'));
      }
      return;
    }
    const r = parseResponse(msg);
    if (r.kind === 'event') return this.#onHostEvent(r);
    if (r.id === undefined) return;
    const pending = this.pendingRequests.get(r.id);
    if (!pending) return; // answer to something we no longer wait for
    switch (r.kind) {
      case 'chunk':
        pending.onChunk?.(r.chunk);
        break;
      case 'result':
      case 'done':
        this.pendingRequests.delete(r.id);
        pending.resolve(r.result);
        break;
      case 'error':
        this.pendingRequests.delete(r.id);
        pending.reject(new ProtocolError(r.code, r.message));
        break;
    }
  }

  #onHostEvent(r) {
    if (r.event === 'host.key_rotated' && typeof r.data?.public_key === 'string') {
      const pk = fromBase64Url(r.data.public_key);
      if (pk.length === 32) {
        this.record = { ...this.record, pcPublicKey: r.data.public_key };
        this.onRecordChange(this.record);
      }
    }
    if (r.event === 'upload.result' && typeof r.data?.upload_id === 'string' && typeof r.data.status === 'string') {
      this.#uploadDone(r.data.upload_id, r.data);
    }
    this.onEvent({ event: r.event, data: r.data });
  }
}

