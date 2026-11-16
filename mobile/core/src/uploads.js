// Receiving a document from a phone, in the open: size and type limits, chunking, hash check, and
// a quarantine until the user presses Allow on the PC. Pure logic (no network); the host wires it
// to the session.
//
// States: receiving -> pending_confirmation -> accepted | denied | failed
//         (receiving/pending can also end as cancelled or expired)
import { ProtocolError } from './errors.js';
import { equalBytes, fromBase64Url, fromHex } from './bytes.js';
import {
  DEFAULT_UPLOAD_EXTENSIONS, MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES, checkFileName, fileHash, sniffFile,
} from './files.js';

const TERMINAL = new Set(['accepted', 'denied', 'failed', 'cancelled', 'expired']);

/**
 * @typedef {object} UploadOptions
 * @property {boolean} [enabled] master switch; false refuses every upload (PC pairing settings)
 * @property {number} [maxFileBytes]
 * @property {number} [maxStagedBytes] everything held in quarantine at once, all phones together
 * @property {readonly string[]} [allowedExtensions]
 * @property {number} [receiveTtlMs] an upload without a new chunk for this long is dropped
 * @property {number} [pendingTtlMs] how long the user has to answer
 * @property {number} [recordTtlMs] how long the result stays readable by the phone
 */

export class UploadManager {
  /** @param {UploadOptions & { now?: () => number }} [o] */
  constructor(o = {}) {
    this.now = o.now ?? Date.now;
    this.enabled = o.enabled ?? true;
    this.maxFileBytes = Math.min(o.maxFileBytes ?? MAX_UPLOAD_BYTES, MAX_UPLOAD_BYTES);
    this.maxStagedBytes = o.maxStagedBytes ?? 100 * 1024 * 1024;
    this.allowed = o.allowedExtensions ?? DEFAULT_UPLOAD_EXTENSIONS;
    this.receiveTtl = o.receiveTtlMs ?? 10 * 60_000;
    this.pendingTtl = o.pendingTtlMs ?? 10 * 60_000;
    this.recordTtl = o.recordTtlMs ?? 60 * 60_000;
    /** @type {Map<string, any>} */
    this.items = new Map();
  }

  #key(deviceId, uploadId) {
    return `${deviceId}/${uploadId}`;
  }

  #staged() {
    let n = 0;
    for (const u of this.items.values()) if (u.state === 'receiving' || u.state === 'pending_confirmation') n += u.size;
    return n;
  }

  #wipe(u) {
    u.parts = [];
    u.bytes = undefined;
  }

  #end(u, state) {
    u.state = state;
    u.endedAt = this.now();
    this.#wipe(u);
  }

  /**
   * @param {{ id: string, name: string }} device
   * @param {{ upload_id: string, name: string, size: number, chunks: number, hash: string, workspace_id?: string }} p validated params
   */
  begin(device, p) {
    if (!this.enabled) throw new ProtocolError('forbidden', 'Uploads from phones are switched off on the PC.');
    this.expire();
    const key = this.#key(device.id, p.upload_id);
    if (this.items.has(key)) throw new ProtocolError('duplicate_id', 'This upload id was already used.');
    for (const u of this.items.values()) {
      if (u.deviceId === device.id && (u.state === 'receiving' || u.state === 'pending_confirmation')) {
        throw new ProtocolError('rate_limited', 'Another upload from this phone is still open.');
      }
    }
    const name = checkFileName(p.name, this.allowed);
    if (!name.ok) throw new ProtocolError('bad_request', name.reason);
    if (p.size > this.maxFileBytes) throw new ProtocolError('too_large', 'The file is too large for the phone upload.');
    if (p.chunks !== Math.ceil(p.size / UPLOAD_CHUNK_BYTES)) throw new ProtocolError('bad_request', 'The chunk count does not match the size.');
    if (!/^[0-9a-f]{64}$/.test(p.hash)) throw new ProtocolError('bad_request', 'The hash is invalid.');
    if (this.#staged() + p.size > this.maxStagedBytes) throw new ProtocolError('rate_limited', 'The PC is busy receiving other files.');
    const now = this.now();
    this.items.set(key, {
      key, uploadId: p.upload_id, deviceId: device.id, deviceName: device.name, name: name.name, ext: name.ext,
      size: p.size, chunks: p.chunks, hash: p.hash, workspaceId: p.workspace_id,
      state: 'receiving', parts: [], received: 0, receivedBytes: 0, createdAt: now, updatedAt: now,
    });
    return { upload_id: p.upload_id, chunk_bytes: UPLOAD_CHUNK_BYTES, chunks: p.chunks };
  }

  #get(device, uploadId) {
    const u = this.items.get(this.#key(device.id, uploadId));
    if (!u) throw new ProtocolError('not_found', 'Unknown upload.');
    return u;
  }

  /** @param {{ id: string }} device @param {{ upload_id: string, index: number, data: string }} p */
  chunk(device, p) {
    this.expire();
    const u = this.#get(device, p.upload_id);
    if (u.state !== 'receiving') throw new ProtocolError('bad_request', 'This upload is not receiving data.');
    if (p.index !== u.received) throw new ProtocolError('bad_request', 'Chunks must arrive in order.');
    let bytes;
    try {
      bytes = fromBase64Url(p.data);
    } catch {
      this.#end(u, 'failed');
      throw new ProtocolError('bad_request', 'The chunk is not valid base64.');
    }
    const expected = u.received === u.chunks - 1 ? u.size - UPLOAD_CHUNK_BYTES * (u.chunks - 1) : UPLOAD_CHUNK_BYTES;
    if (bytes.length !== expected) {
      this.#end(u, 'failed');
      throw new ProtocolError('bad_request', 'The chunk has the wrong size.');
    }
    u.parts.push(bytes);
    u.received++;
    u.receivedBytes += bytes.length;
    u.updatedAt = this.now();
    return { received: u.received };
  }

  /**
   * Verifies the complete file and puts it into quarantine until the user decides.
   * @param {{ id: string }} device @param {{ upload_id: string }} p
   */
  finish(device, p) {
    this.expire();
    const u = this.#get(device, p.upload_id);
    if (u.state !== 'receiving') throw new ProtocolError('bad_request', 'This upload is not receiving data.');
    if (u.received !== u.chunks || u.receivedBytes !== u.size) throw new ProtocolError('bad_request', 'The upload is incomplete.');
    const bytes = new Uint8Array(u.size);
    let o = 0;
    for (const part of u.parts) {
      bytes.set(part, o);
      o += part.length;
    }
    u.parts = [];
    if (!equalBytes(fromHex(fileHash(bytes)), fromHex(u.hash))) {
      this.#end(u, 'failed');
      throw new ProtocolError('bad_request', 'The hash does not match: the file was damaged on the way.');
    }
    const sniff = sniffFile(u.ext, bytes);
    if (!sniff.ok) {
      this.#end(u, 'failed');
      throw new ProtocolError('bad_request', sniff.reason);
    }
    u.bytes = bytes;
    u.kind = sniff.kind;
    u.state = 'pending_confirmation';
    u.updatedAt = this.now();
    return { upload_id: u.uploadId, status: 'pending_confirmation' };
  }

  /** @param {{ id: string }} device @param {{ upload_id: string }} p */
  cancel(device, p) {
    const u = this.#get(device, p.upload_id);
    if (!TERMINAL.has(u.state)) this.#end(u, 'cancelled');
    return { upload_id: u.uploadId, status: u.state };
  }

  /** @param {{ id: string }} device @param {{ upload_id: string }} p */
  status(device, p) {
    this.expire();
    const u = this.#get(device, p.upload_id);
    return {
      upload_id: u.uploadId,
      status: u.state,
      ...(u.state === 'receiving' ? { received: u.received, chunks: u.chunks } : {}),
      ...(u.documentId ? { document_id: u.documentId } : {}),
      ...(u.failure ? { reason: u.failure } : {}),
    };
  }

  /** @returns {Array<{ ref: string, deviceId: string, deviceName: string, name: string, size: number, kind: string, hash: string, workspaceId?: string }>} */
  pending() {
    this.expire();
    return [...this.items.values()]
      .filter((u) => u.state === 'pending_confirmation')
      .map((u) => ({ ref: u.key, deviceId: u.deviceId, deviceName: u.deviceName, name: u.name, size: u.size, kind: u.kind, hash: u.hash, workspaceId: u.workspaceId }));
  }

  /** The user's decision. Returns the item with its bytes when approved, otherwise null. */
  decide(ref, approve) {
    this.expire();
    const u = this.items.get(ref);
    if (!u || u.state !== 'pending_confirmation') throw new ProtocolError('not_found', 'No such upload is waiting for a decision.');
    if (!approve) {
      this.#end(u, 'denied');
      return { item: u, bytes: null };
    }
    const bytes = u.bytes;
    u.bytes = undefined;
    u.state = 'ingesting';
    return { item: u, bytes };
  }

  /** @param {any} item @param {{ ok: boolean, documentId?: string, reason?: string }} r */
  finishIngest(item, r) {
    if (r.ok) {
      item.documentId = r.documentId;
      this.#end(item, 'accepted');
    } else {
      item.failure = r.reason ?? 'The PC could not add the file.';
      this.#end(item, 'failed');
    }
  }

  /** A phone was removed: its quarantined files are deleted at once. */
  dropDevice(deviceId) {
    for (const u of this.items.values()) {
      if (u.deviceId === deviceId && !TERMINAL.has(u.state)) this.#end(u, 'cancelled');
    }
  }

  /** @returns {Array<any>} items that just expired (so the host can tell the phone) */
  expire() {
    const now = this.now();
    const expired = [];
    for (const [k, u] of this.items) {
      if (u.state === 'receiving' && now - u.updatedAt > this.receiveTtl) {
        this.#end(u, 'expired');
        expired.push(u);
      } else if (u.state === 'pending_confirmation' && now - u.updatedAt > this.pendingTtl) {
        this.#end(u, 'expired');
        expired.push(u);
      } else if (TERMINAL.has(u.state) && now - (u.endedAt ?? now) > this.recordTtl) {
        this.items.delete(k);
      }
    }
    return expired;
  }
}
