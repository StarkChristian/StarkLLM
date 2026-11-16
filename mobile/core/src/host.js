// PC side of the remote protocol. Transport-agnostic: the integration (relay connection, Electron
// or engine process) feeds frames in with handleFrame() and receives frames through `send`.
//
// Security properties implemented here (each has a test):
//  * Unknown or revoked phone keys are dropped before any reply is written (no oracle).
//  * A pairing secret is single use, expires after 5 minutes, and a pairing is never "approved"
//    without the user pressing Allow; the 6-digit code comes from the handshake hash.
//  * First handshake messages are rejected when their timestamp is stale or their ephemeral key
//    has been seen before (replay protection).
//  * Every request goes through parseRequest (allow-list + closed schemas) and the permission check
//    before one of five engine methods is called. Everything else is answered with an error and
//    never reaches the engine.
//  * Revocation closes live sessions and is re-checked on every request.
import { ProtocolError } from './errors.js';
import { fromBase64Url, toBase64Url, toHex } from './bytes.js';
import {
  HANDSHAKE_MAX_SKEW_MS,
  KIND,
  MAX_MESSAGE_BYTES,
  PAIRING_TTL_MS,
  PROLOGUE_PAIRING,
  PROLOGUE_SESSION,
  PROTOCOL_VERSION,
  SESSION_IDLE_MS,
  SESSION_MAX_AGE_MS,
} from './constants.js';
import { confirmationCode, HandshakeResponder, isLowOrderPoint, randomSecret } from './noise.js';
import { decodeFrame, encodeFrame } from './wire.js';
import { decodeMessage, encodeMessage, ENGINE_METHODS, INGEST_METHOD, parseRequest, REQUEST_TYPES } from './protocol.js';
import { UploadManager } from './uploads.js';
import { buildPairingUri, parsePairingUri } from './qr.js';
import { isRoutingId } from './routing.js';

const hasPerm = (device, needed) => device.permissions.includes(needed);

/** Remembers values for `ttlMs`; used to refuse a replayed first handshake message. */
export class ReplayCache {
  constructor(ttlMs, maxEntries = 4096) {
    this.ttl = ttlMs;
    this.max = maxEntries;
    /** @type {Map<string, number>} */
    this.seen = new Map();
  }
  /** @returns {boolean} true if the key is new (and now remembered), false if it is a replay */
  add(key, now) {
    for (const [k, t] of this.seen) {
      if (now - t > this.ttl) this.seen.delete(k);
      else break; // Map keeps insertion order, so the rest is newer
    }
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.max) {
      // Full: refuse new handshakes instead of forgetting values (forgetting would allow replays).
      throw new ProtocolError('busy');
    }
    this.seen.set(key, now);
    return true;
  }
}

class Bucket {
  constructor(ratePerSec, burst, now) {
    this.rate = ratePerSec;
    this.burst = burst;
    this.tokens = burst;
    this.last = now;
  }
  take(now) {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * @typedef {object} EngineAdapter
 * @property {(params: object, ctx: object) => Promise<object>} inboxList
 * @property {(params: object, ctx: object) => Promise<object>} deadlinesList
 * @property {(params: object, ctx: object) => Promise<object>} casesList
 * @property {(params: object, ctx: object) => Promise<object>} sourceOpen
 * @property {(params: object, ctx: object) => Promise<object>} kbSearch
 * @property {(params: object, ctx: object) => Promise<object>} workspacesList
 * @property {(params: object, ctx: object) => Promise<object>} chatsList
 * @property {(file: { name: string, bytes: Uint8Array, size: number, hash: string, workspace_id?: string, origin: 'phone-upload', untrusted: true }, ctx: object) => Promise<{ document_id?: string }>} documentIngest called only after the user confirmed on the PC
 * @property {(params: object, ctx: object) => AsyncIterable<{ delta?: string, citations?: object[] }>} chatAsk
 */

/**
 * @typedef {object} HostOptions
 * @property {{ current: import('./noise.js').KeyPair, previous?: { keyPair: import('./noise.js').KeyPair, until: number } }} identity
 * @property {import('./devices.js').DeviceRegistry} devices
 * @property {EngineAdapter} engine the only thing the phone can reach, and only through ENGINE_METHODS
 * @property {(peerId: string, frame: Uint8Array) => void} send deliver a frame to one phone
 * @property {(peerId: string) => void} [closePeer] ask the link layer to disconnect a phone
 * @property {() => number} [now]
 * @property {string} [pcName]
 * @property {(event: object) => void} [onEvent] for the UI: pairing-pending, session-opened, ...
 * @property {import('./uploads.js').UploadOptions} [uploads] document upload settings; `enabled: false` switches uploads off for every phone
 * @property {{ requestsPerSecond?: number, burst?: number, maxInflight?: number, maxStreamBytes?: number, maxPeers?: number }} [limits]
 */

export class RemoteHost {
  /** @param {HostOptions} o */
  constructor(o) {
    this.identity = o.identity;
    this.devices = o.devices;
    this.engine = o.engine;
    this.sendFrame = o.send;
    this.closePeerCb = o.closePeer ?? (() => {});
    this.now = o.now ?? Date.now;
    this.pcName = o.pcName ?? 'StarkLLM PC';
    this.onEvent = o.onEvent ?? (() => {});
    this.limits = {
      requestsPerSecond: 10,
      burst: 30,
      maxInflight: 4,
      maxStreamBytes: 4 * 1024 * 1024,
      maxPeers: 64,
      ...o.limits,
    };
    /** @type {Map<string, any>} */
    this.peers = new Map();
    /** @type {null | { secret: Uint8Array, expiresAt: number, used: boolean, halfOpen: Set<string> }} */
    this.offer = null;
    /** @type {Map<string, any>} */
    this.pending = new Map();
    this.uploads = new UploadManager({ now: this.now, ...o.uploads });
    this.replay = new ReplayCache(2 * HANDSHAKE_MAX_SKEW_MS);
    this.devices.onChange((e) => {
      if (e.type === 'revoked') {
        this.uploads.dropDevice(e.device.id); // quarantined files of a removed phone are deleted
        this.#dropDevice(e.device.id);
      }
    });
  }

  // ------------------------------------------------------------------ pairing (PC side API)

  /**
   * Starts pairing: creates a one-use secret and the QR payload. A new offer replaces the old one.
   * @param {{ relay: string, routingId: string, pcName?: string, ttlMs?: number }} o
   * @returns {{ uri: string, expiresAt: number }}
   */
  createPairingOffer(o) {
    if (!isRoutingId(o.routingId)) throw new TypeError('invalid routing id');
    const expiresAt = this.now() + (o.ttlMs ?? PAIRING_TTL_MS);
    this.#discardOffer();
    this.offer = { secret: randomSecret(), expiresAt, used: false, halfOpen: new Set() };
    const uri = buildPairingUri({
      relay: o.relay,
      routingId: o.routingId,
      pcPublicKey: this.identity.current.publicKey,
      secret: this.offer.secret,
      expiresAt,
      pcName: o.pcName ?? this.pcName,
    });
    // Make sure that what we put into the QR code is what the phone parser accepts.
    parsePairingUri(uri, { allowInsecure: true });
    return { uri, expiresAt };
  }

  #discardOffer() {
    if (this.offer) for (const id of this.offer.halfOpen) this.#closePeer(id);
    this.offer = null;
  }

  /** @returns {Array<{ pairingId: string, deviceName: string, code: string, expiresAt: number }>} */
  pendingPairings() {
    this.#expire();
    return [...this.pending.values()].map((p) => ({
      pairingId: p.pairingId,
      deviceName: p.deviceName,
      code: p.code,
      expiresAt: p.expiresAt,
    }));
  }

  /**
   * The user's answer on the PC: "Allow iPhone of Christian? Code 482913".
   * @param {string} pairingId
   * @param {boolean} approve
   * @param {{ permissions?: string[], name?: string }} [opts]
   * @returns {import('./devices.js').Device | null}
   */
  confirmPairing(pairingId, approve, opts = {}) {
    this.#expire();
    const p = this.pending.get(pairingId);
    if (!p) throw new ProtocolError('unknown_pairing');
    this.pending.delete(pairingId);
    const peer = this.peers.get(p.peerId);
    let device = null;
    if (approve) {
      device = this.devices.approve({
        name: opts.name ?? p.deviceName,
        publicKey: p.publicKey,
        permissions: opts.permissions,
      });
    }
    if (peer && !peer.transport.dead) {
      this.#sendData(
        peer,
        approve && device
          ? { type: 'pair.result', approved: true, device_id: device.id, permissions: device.permissions, pc_name: this.pcName }
          : { type: 'pair.result', approved: false },
      );
    }
    this.#closePeer(p.peerId);
    this.onEvent({ type: approve ? 'pairing-approved' : 'pairing-denied', pairingId });
    return device;
  }

  // ------------------------------------------------------------------ identity / revocation

  /**
   * PC key rotation. Phones that connect with the old key during `graceMs` are accepted and told
   * the new key inside their (authenticated) session.
   * @param {import('./noise.js').KeyPair} newKeyPair
   * @param {number} [graceMs]
   */
  rotateIdentity(newKeyPair, graceMs = 14 * 24 * 3600_000) {
    this.identity = {
      current: newKeyPair,
      previous: { keyPair: this.identity.current, until: this.now() + graceMs },
    };
    for (const peer of this.peers.values()) {
      if (peer.state === 'session' && !peer.transport.dead) this.#sendKeyRotated(peer);
    }
    this.#discardOffer();
  }

  #sendKeyRotated(peer) {
    this.#sendData(peer, { event: 'host.key_rotated', data: { public_key: toBase64Url(this.identity.current.publicKey) } });
  }

  /** @param {string} deviceId */
  revokeDevice(deviceId) {
    return this.devices.revoke(deviceId); // the onChange listener drops its sessions
  }

  #dropDevice(deviceId) {
    for (const [id, peer] of this.peers) {
      if (peer.device?.id === deviceId) this.#closePeer(id);
    }
  }

  // ------------------------------------------------------------------ housekeeping

  /** Call about once a second (or before inspecting state in tests). */
  tick() {
    this.#expire();
    for (const u of this.uploads.expire()) this.#notifyUpload(u, 'expired');
    const now = this.now();
    for (const [id, peer] of this.peers) {
      if (peer.state === 'session') {
        if (now - peer.lastActive > SESSION_IDLE_MS || now - peer.openedAt > SESSION_MAX_AGE_MS) {
          if (!peer.transport.dead && now - peer.openedAt > SESSION_MAX_AGE_MS) {
            this.#sendData(peer, { event: 'host.session_expired' });
          }
          this.#closePeer(id);
        }
      } else if (peer.state !== 'pairing' && now - peer.openedAt > 60_000) {
        this.#closePeer(id); // a handshake that never finished ('pairing' waits for the user: see #expire)
      }
    }
  }

  #expire() {
    const now = this.now();
    if (this.offer && now > this.offer.expiresAt) this.#discardOffer();
    for (const [pid, p] of this.pending) {
      if (now > p.expiresAt) {
        this.pending.delete(pid);
        const peer = this.peers.get(p.peerId);
        if (peer && !peer.transport.dead) this.#sendData(peer, { type: 'pair.result', approved: false });
        this.#closePeer(p.peerId);
      }
    }
  }

  /** The link to one phone went away. */
  peerClosed(peerId) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);
    this.offer?.halfOpen.delete(peerId);
    for (const [pid, p] of this.pending) if (p.peerId === peerId) this.pending.delete(pid);
    if (peer.state === 'session') this.onEvent({ type: 'session-closed', deviceId: peer.device.id });
  }

  #closePeer(peerId) {
    const peer = this.peers.get(peerId);
    this.peerClosed(peerId);
    if (peer) peer.transport && (peer.transport.dead = true);
    this.closePeerCb(peerId);
  }

  close() {
    for (const id of [...this.peers.keys()]) this.#closePeer(id);
    this.#discardOffer();
  }

  // ------------------------------------------------------------------ incoming frames

  /**
   * Feed one frame received from one phone. Never throws: a bad frame ends that phone's link.
   * @param {string} peerId opaque id of the phone's connection (from the relay)
   * @param {Uint8Array} bytes
   */
  async handleFrame(peerId, bytes) {
    try {
      const { kind, body } = decodeFrame(bytes);
      let peer = this.peers.get(peerId);
      if (!peer) {
        if (this.peers.size >= this.limits.maxPeers) throw new ProtocolError('busy');
        peer = {
          id: peerId,
          state: 'new',
          openedAt: this.now(),
          lastActive: this.now(),
          bucket: new Bucket(this.limits.requestsPerSecond, this.limits.burst, this.now()),
          uploadBucket: new Bucket(40, 80, this.now()),
          inflight: 0,
          seenIds: new Set(),
          seenOrder: [],
        };
        this.peers.set(peerId, peer);
      }
      peer.lastActive = this.now();
      if (peer.state === 'new') {
        if (kind === KIND.PAIR_1) return this.#onPair1(peer, body);
        if (kind === KIND.SESSION_1) return this.#onSession1(peer, body);
        throw new ProtocolError('bad_frame');
      }
      if (kind !== KIND.DATA) throw new ProtocolError('bad_frame');
      if (peer.state === 'pairing-half') return this.#onPairHello(peer, body);
      if (peer.state === 'session') return await this.#onSessionData(peer, body);
      throw new ProtocolError('bad_frame'); // 'pairing' (waiting for the user) accepts nothing more
    } catch (e) {
      // Drop silently: no error frame is sent for handshake failures (no oracle for attackers).
      if (!(e instanceof ProtocolError)) this.onEvent({ type: 'internal-error', message: String(e?.message ?? e).slice(0, 200) });
      this.#closePeer(peerId);
    }
  }

  #checkTimestamp(payload) {
    const hello = decodeMessage(payload);
    if (hello.v !== PROTOCOL_VERSION || typeof hello.ts !== 'number' || !Number.isSafeInteger(hello.ts)) throw new ProtocolError('handshake_failed');
    if (Math.abs(this.now() - /** @type {number} */ (hello.ts)) > HANDSHAKE_MAX_SKEW_MS) throw new ProtocolError('stale_handshake');
  }

  #onPair1(peer, body) {
    const offer = this.offer;
    if (!offer || offer.used || this.now() > offer.expiresAt) throw new ProtocolError('no_offer');
    if (offer.halfOpen.size >= 3) throw new ProtocolError('busy');
    const hs = new HandshakeResponder({
      pattern: 'IKpsk2',
      prologue: PROLOGUE_PAIRING,
      staticKey: this.identity.current,
      psk: offer.secret,
    });
    const first = hs.readFirst(body);
    if (!this.replay.add(toHex(first.remoteEphemeralPublicKey), this.now())) throw new ProtocolError('replay');
    this.#checkTimestamp(first.payload);
    const second = hs.writeSecond(encodeMessage({ v: PROTOCOL_VERSION, status: 'ok' }));
    peer.state = 'pairing-half';
    peer.transport = second.transport;
    peer.phoneKey = first.remoteStaticPublicKey;
    peer.code = confirmationCode(second.transport.handshakeHash);
    peer.offer = offer;
    offer.halfOpen.add(peer.id);
    this.sendFrame(peer.id, encodeFrame(KIND.PAIR_2, second.packet));
  }

  /** The phone proves it knows the pairing secret by sending the first encrypted message. */
  #onPairHello(peer, body) {
    const msg = decodeMessage(peer.transport.open(body));
    if (msg.type !== 'pair.hello' || typeof msg.name !== 'string' || msg.name.length > 64) {
      throw new ProtocolError('bad_message');
    }
    const offer = peer.offer;
    if (this.offer !== offer || offer.used || this.now() > offer.expiresAt) throw new ProtocolError('no_offer');
    // From here on the secret is spent: it can be used by exactly one phone.
    offer.used = true;
    for (const other of [...offer.halfOpen]) if (other !== peer.id) this.#closePeer(other);
    offer.halfOpen.clear();
    this.offer = null;
    const pairingId = toBase64Url(randomSecret().slice(0, 9));
    const expiresAt = this.now() + PAIRING_TTL_MS;
    peer.state = 'pairing';
    this.pending.set(pairingId, {
      pairingId,
      peerId: peer.id,
      deviceName: msg.name.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() || 'Phone',
      publicKey: peer.phoneKey,
      code: peer.code,
      expiresAt,
    });
    this.onEvent({ type: 'pairing-pending', pairingId, deviceName: msg.name, code: peer.code });
  }

  #findPcKey() {
    const keys = [this.identity.current];
    const prev = this.identity.previous;
    if (prev && this.now() <= prev.until) keys.push(prev.keyPair);
    return keys;
  }

  #onSession1(peer, body) {
    /** @type {any} */
    let first;
    /** @type {any} */
    let hs;
    let usedPrevious = false;
    const keys = this.#findPcKey();
    for (let i = 0; i < keys.length; i++) {
      try {
        hs = new HandshakeResponder({ pattern: 'IK', prologue: PROLOGUE_SESSION, staticKey: keys[i] });
        first = hs.readFirst(body);
        usedPrevious = i > 0;
        break;
      } catch (e) {
        if (i === keys.length - 1) throw e;
      }
    }
    // Unknown or revoked key: drop without any reply.
    const found = this.devices.findByPublicKey(first.remoteStaticPublicKey);
    if (!found) throw new ProtocolError('unknown_device');
    if (!this.replay.add(toHex(first.remoteEphemeralPublicKey), this.now())) throw new ProtocolError('replay');
    this.#checkTimestamp(first.payload);
    if (found.viaPendingKey) this.devices.completeRotation(found.device.id);
    const second = hs.writeSecond(
      encodeMessage({ v: PROTOCOL_VERSION, max_message: MAX_MESSAGE_BYTES, idle_ms: SESSION_IDLE_MS, max_age_ms: SESSION_MAX_AGE_MS }),
    );
    peer.state = 'session';
    peer.transport = second.transport;
    peer.device = found.device;
    peer.openedAt = this.now();
    this.devices.touch(found.device.id, this.now());
    this.sendFrame(peer.id, encodeFrame(KIND.SESSION_2, second.packet));
    if (usedPrevious) this.#sendKeyRotated(peer);
    this.onEvent({ type: 'session-opened', deviceId: found.device.id });
  }

  // ------------------------------------------------------------------ requests

  #sendData(peer, obj) {
    this.sendFrame(peer.id, encodeFrame(KIND.DATA, peer.transport.seal(encodeMessage(obj))));
  }

  #error(peer, id, code, message) {
    this.#sendData(peer, { id, ok: false, error: { code, message } });
  }

  async #onSessionData(peer, body) {
    const msg = decodeMessage(peer.transport.open(body));
    const now = this.now();
    if (now - peer.openedAt > SESSION_MAX_AGE_MS) {
      this.#sendData(peer, { event: 'host.session_expired' });
      throw new ProtocolError('session_expired');
    }
    // Re-checked on every request, so a revoked phone is cut off immediately.
    const device = this.devices.get(peer.device.id);
    if (!device || device.status !== 'approved') throw new ProtocolError('revoked');
    peer.device = device;

    const parsed = parseRequest(msg);
    // Upload chunks have their own, larger budget; everything else shares the normal one.
    const bucket = parsed.ok && parsed.request.type === 'documents.upload.chunk' ? peer.uploadBucket : peer.bucket;
    if (!bucket.take(now)) {
      return this.#error(peer, parsed.ok ? parsed.request.id : parsed.id, 'rate_limited', 'Too many requests.');
    }
    if (!parsed.ok) return this.#error(peer, parsed.id, parsed.code, parsed.message);
    const { id, type, params } = parsed.request;

    if (peer.seenIds.has(id)) return this.#error(peer, id, 'duplicate_id', 'Request id was already used in this session.');
    peer.seenIds.add(id);
    peer.seenOrder.push(id);
    if (peer.seenOrder.length > 2048) peer.seenIds.delete(peer.seenOrder.shift());

    const spec = REQUEST_TYPES[/** @type {keyof typeof REQUEST_TYPES} */ (type)];
    if (!hasPerm(device, spec.permission)) {
      return this.#error(peer, id, 'forbidden', 'This phone does not have the permission for this request.');
    }
    if (peer.inflight >= this.limits.maxInflight) return this.#error(peer, id, 'rate_limited', 'Too many open requests.');

    if (spec.method === null) return this.#localRequest(peer, device, type, id, params);

    peer.inflight++;
    try {
      await this.#callEngine(peer, device, spec, id, params);
    } finally {
      peer.inflight--;
    }
  }

  /** Requests the host answers itself, from the device registry. */
  #localRequest(peer, device, type, id, params) {
    if (type === 'device.info') {
      return this.#sendData(peer, {
        id,
        ok: true,
        result: { device_id: device.id, name: device.name, permissions: device.permissions, pc_name: this.pcName },
      });
    }
    if (type === 'device.rotate_key') {
      try {
        const pk = fromBase64Url(/** @type {string} */ (params.public_key));
        if (pk.length !== 32 || isLowOrderPoint(pk)) throw new ProtocolError('bad_request', 'invalid key');
        this.devices.beginRotation(device.id, pk);
      } catch {
        return this.#error(peer, id, 'bad_request', 'The new key was refused.');
      }
      return this.#sendData(peer, { id, ok: true, result: { accepted: true } });
    }
    if (type.startsWith('documents.upload.')) return this.#uploadRequest(peer, device, type, id, params);
    return this.#error(peer, id, 'unknown_type', 'This request type is not available on the phone.');
  }

  #uploadRequest(peer, device, type, id, params) {
    try {
      let result;
      switch (type) {
        case 'documents.upload.begin':
          result = this.uploads.begin(device, /** @type {any} */ (params));
          break;
        case 'documents.upload.chunk':
          result = this.uploads.chunk(device, /** @type {any} */ (params));
          break;
        case 'documents.upload.finish': {
          result = this.uploads.finish(device, /** @type {any} */ (params));
          const item = this.uploads.items.get(`${device.id}/${params.upload_id}`);
          // The user sees: which phone, which file, how big, which type: and decides.
          this.onEvent({
            type: 'upload-pending',
            ref: item.key,
            deviceId: device.id,
            deviceName: device.name,
            name: item.name,
            size: item.size,
            kind: item.kind,
            hash: item.hash,
          });
          break;
        }
        case 'documents.upload.status':
          result = this.uploads.status(device, /** @type {any} */ (params));
          break;
        case 'documents.upload.cancel':
          result = this.uploads.cancel(device, /** @type {any} */ (params));
          break;
        default:
          return this.#error(peer, id, 'unknown_type', 'This request type is not available on the phone.');
      }
      return this.#sendData(peer, { id, ok: true, result });
    } catch (e) {
      if (e instanceof ProtocolError) return this.#error(peer, id, e.code, e.message);
      throw e;
    }
  }

  /** Files waiting for the user's decision: show name, size, type and phone, then call confirmUpload. */
  pendingUploads() {
    return this.uploads.pending();
  }

  /**
   * The user's answer to "Add *Bescheid.pdf* from iPhone of Christian to your documents?".
   * Only an approved upload is handed to the engine, and only through the one ingest method,
   * flagged as untrusted phone input so the prompt-injection defences apply.
   * @param {string} ref value of `ref` in the 'upload-pending' event
   * @param {boolean} approve
   */
  async confirmUpload(ref, approve) {
    const { item, bytes } = this.uploads.decide(ref, approve);
    let status = 'denied';
    let documentId;
    if (approve && bytes) {
      const device = this.devices.get(item.deviceId);
      if (!device || device.status !== 'approved') {
        this.uploads.finishIngest(item, { ok: false, reason: 'The phone was removed.' });
        status = 'failed';
      } else {
        const ctx = Object.freeze({ deviceId: device.id, deviceName: device.name, permissions: Object.freeze([...device.permissions]) });
        try {
          if (!ENGINE_METHODS.includes(INGEST_METHOD) || typeof this.engine[INGEST_METHOD] !== 'function') throw new Error('no ingest');
          const r = await this.engine[INGEST_METHOD](
            { name: item.name, bytes, size: item.size, hash: item.hash, workspace_id: item.workspaceId, origin: 'phone-upload', untrusted: true },
            ctx,
          );
          documentId = typeof r?.document_id === 'string' ? r.document_id.slice(0, 128) : undefined;
          this.uploads.finishIngest(item, { ok: true, documentId });
          status = 'accepted';
        } catch (e) {
          this.onEvent({ type: 'engine-error', method: INGEST_METHOD, message: String(e?.message ?? e).slice(0, 200) });
          this.uploads.finishIngest(item, { ok: false, reason: 'The PC could not add the file.' });
          status = 'failed';
        }
      }
    }
    this.#notifyUpload(item, status, documentId);
    this.onEvent({ type: `upload-${status}`, ref });
    return status;
  }

  #notifyUpload(item, status, documentId) {
    for (const peer of this.peers.values()) {
      if (peer.state === 'session' && peer.device?.id === item.deviceId && !peer.transport.dead) {
        this.#sendData(peer, { event: 'upload.result', data: { upload_id: item.uploadId, status, ...(documentId ? { document_id: documentId } : {}) } });
      }
    }
  }

  async #callEngine(peer, device, spec, id, params) {
    const method = spec.method;
    // Defence in depth: `method` comes from our own table, and the table is checked against
    // ENGINE_METHODS, so nothing a phone sends can select a different engine function.
    if (!ENGINE_METHODS.includes(method) || typeof this.engine[method] !== 'function') {
      return this.#error(peer, id, 'engine_error', 'This request is not available.');
    }
    const ctx = Object.freeze({ deviceId: device.id, deviceName: device.name, permissions: Object.freeze([...device.permissions]) });
    try {
      if (!spec.stream) {
        const result = await this.engine[method](params, ctx);
        return this.#sendResult(peer, id, result);
      }
      let bytes = 0;
      let citations;
      for await (const part of this.engine[method](params, ctx)) {
        if (peer.transport.dead || !this.peers.has(peer.id)) return; // phone left: stop answering
        if (!this.devices.isApproved(device.id)) return;
        if (typeof part?.delta === 'string' && part.delta.length > 0) {
          bytes += part.delta.length;
          if (bytes > this.limits.maxStreamBytes) return this.#error(peer, id, 'too_large', 'The answer is too long.');
          for (let i = 0; i < part.delta.length; i += 16_000) {
            this.#sendData(peer, { id, chunk: { delta: part.delta.slice(i, i + 16_000) } });
          }
        }
        if (Array.isArray(part?.citations)) citations = part.citations;
      }
      this.#sendData(peer, { id, done: true, result: { citations: citations ?? [] } });
    } catch (e) {
      if (e instanceof ProtocolError && e.code === 'too_large') return this.#error(peer, id, 'too_large', 'The answer is too large for the phone.');
      this.onEvent({ type: 'engine-error', type_: spec.method, message: String(e?.message ?? e).slice(0, 200) });
      if (!peer.transport.dead) this.#error(peer, id, 'engine_error', 'The PC could not answer this request.');
    }
  }

  #sendResult(peer, id, result) {
    let bytes;
    try {
      bytes = encodeMessage({ id, ok: true, result: result ?? null });
    } catch {
      return this.#error(peer, id, 'too_large', 'The answer is too large for the phone; ask for fewer items.');
    }
    this.sendFrame(peer.id, encodeFrame(KIND.DATA, peer.transport.seal(bytes)));
  }
}

