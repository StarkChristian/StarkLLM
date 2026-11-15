// Registry of paired phones ("approved devices") on the PC: approval, permissions, revocation and
// key rotation. Pure logic over an injected store, so it runs in tests without disk access.
import { ProtocolError } from './errors.js';
import { toBase64Url } from './bytes.js';
import { PERMISSIONS } from './constants.js';
import { randomSecret } from './noise.js';

/**
 * @typedef {object} Device
 * @property {string} id
 * @property {string} name
 * @property {string} publicKey base64url, the key the phone uses now
 * @property {string} [pendingKey] base64url, a rotation target not yet seen in a session
 * @property {string[]} permissions subset of PERMISSIONS
 * @property {'approved'|'revoked'} status
 * @property {number} createdAt
 * @property {number} [lastSeenAt]
 * @property {number} [revokedAt]
 */

/** @typedef {{ load(): any, save(state: any): void }} DeviceStore */

/** In-memory store (tests, or a PC with remote access switched off). */
export class MemoryDeviceStore {
  constructor(initial = null) {
    this.state = initial;
  }
  load() {
    return this.state ? structuredClone(this.state) : null;
  }
  save(state) {
    this.state = structuredClone(state);
  }
}

function cleanName(name) {
  if (typeof name !== 'string') return 'Phone';
  const n = name.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64);
  return n || 'Phone';
}

function cleanPermissions(p) {
  const list = Array.isArray(p) ? p : ['read', 'chat'];
  const out = PERMISSIONS.filter((x) => list.includes(x));
  // "chat" implies "read"
  if (out.includes('chat') && !out.includes('read')) out.unshift('read');
  return out;
}

export class DeviceRegistry {
  /**
   * @param {DeviceStore} [store]
   * @param {() => number} [now]
   */
  constructor(store = new MemoryDeviceStore(), now = Date.now) {
    this.store = store;
    this.now = now;
    /** @type {Map<string, Device>} */
    this.devices = new Map();
    const s = store.load();
    if (s?.version === 1 && Array.isArray(s.devices)) {
      for (const d of s.devices) this.devices.set(d.id, d);
    }
    /** @type {Array<(e: {type: string, device: Device}) => void>} */
    this.listeners = [];
  }

  /** @param {(e: {type: string, device: Device}) => void} fn */
  onChange(fn) {
    this.listeners.push(fn);
  }

  #persist() {
    this.store.save({ version: 1, devices: [...this.devices.values()] });
  }

  #emit(type, device) {
    for (const fn of this.listeners) fn({ type, device: { ...device } });
  }

  /**
   * Approves a phone (after the user pressed "Allow" on the PC).
   * @param {{ name: string, publicKey: Uint8Array, permissions?: string[] }} o
   * @returns {Device}
   */
  approve({ name, publicKey, permissions }) {
    const pk = toBase64Url(publicKey);
    if (this.#byKey(pk)) throw new ProtocolError('already_paired');
    const device = {
      id: toBase64Url(randomSecret().slice(0, 12)),
      name: cleanName(name),
      publicKey: pk,
      permissions: cleanPermissions(permissions),
      status: /** @type {const} */ ('approved'),
      createdAt: this.now(),
    };
    this.devices.set(device.id, device);
    this.#persist();
    this.#emit('approved', device);
    return { ...device };
  }

  #byKey(pkB64, includePending = false) {
    for (const d of this.devices.values()) {
      if (d.publicKey === pkB64) return d;
      if (includePending && d.pendingKey === pkB64) return d;
    }
    return undefined;
  }

  /**
   * Looks up the device for a key seen in a handshake. Only approved devices are returned; a key
   * that was announced as a rotation target is accepted too (see completeRotation).
   * @param {Uint8Array} publicKey
   * @returns {{ device: Device, viaPendingKey: boolean } | null}
   */
  findByPublicKey(publicKey) {
    const pk = toBase64Url(publicKey);
    const d = this.#byKey(pk, true);
    if (!d || d.status !== 'approved') return null;
    return { device: { ...d }, viaPendingKey: d.publicKey !== pk };
  }

  /** @param {string} id @returns {Device | null} */
  get(id) {
    const d = this.devices.get(id);
    return d ? { ...d } : null;
  }

  /** @returns {Device[]} */
  list() {
    return [...this.devices.values()].map((d) => ({ ...d }));
  }

  /** @param {string} id */
  isApproved(id) {
    return this.devices.get(id)?.status === 'approved';
  }

  /** Marks the phone as revoked. Its key stops working at once; nothing is kept but the record. */
  revoke(id) {
    const d = this.devices.get(id);
    if (!d || d.status === 'revoked') return false;
    d.status = 'revoked';
    d.revokedAt = this.now();
    delete d.pendingKey;
    this.#persist();
    this.#emit('revoked', d);
    return true;
  }

  /** @param {string} id @param {string[]} permissions */
  setPermissions(id, permissions) {
    const d = this.devices.get(id);
    if (!d || d.status !== 'approved') return false;
    d.permissions = cleanPermissions(permissions);
    this.#persist();
    this.#emit('permissions', d);
    return true;
  }

  /**
   * Phone key rotation, step 1: inside an authenticated session the phone announces a new key.
   * @param {string} id @param {Uint8Array} newPublicKey
   */
  beginRotation(id, newPublicKey) {
    const d = this.devices.get(id);
    if (!d || d.status !== 'approved') throw new ProtocolError('forbidden');
    const pk = toBase64Url(newPublicKey);
    if (this.#byKey(pk, true)) throw new ProtocolError('bad_request', 'key already in use');
    d.pendingKey = pk;
    this.#persist();
    this.#emit('rotation-started', d);
  }

  /**
   * Step 2: the phone completed a session with the new key; the old key is retired.
   * @param {string} id
   */
  completeRotation(id) {
    const d = this.devices.get(id);
    if (!d || d.status !== 'approved' || !d.pendingKey) return false;
    d.publicKey = d.pendingKey;
    delete d.pendingKey;
    this.#persist();
    this.#emit('rotated', d);
    return true;
  }

  /** @param {string} id @param {number} [at] */
  touch(id, at = this.now()) {
    const d = this.devices.get(id);
    // persisted at most once a minute: this runs on every session
    if (d && (d.lastSeenAt === undefined || at - d.lastSeenAt > 60_000)) {
      d.lastSeenAt = at;
      this.#persist();
    }
  }
}
