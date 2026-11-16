// The data key of protection at rest (docs/encryption-design.md): a random 32-byte key that the engine uses to protect
// documents and text. This file creates it, keeps it wrapped, and hands it to the engine. The engine never stores it.
//
// Wrapping goes through a KeyStore, so the same code runs with the real Windows key store and with a fake in tests:
//   { name, isAvailable(), wrap(Buffer) -> Buffer, unwrap(Buffer) -> Buffer }
// The real one (createSafeStorageKeyStore) uses Electron's safeStorage, which on Windows is protected by DPAPI: only
// the same Windows user on the same PC can unwrap. Wrapped copies of the key in this folder:
//   data-key.wrapped          key store (DPAPI) wrapped: the normal way to start without typing anything
//   data-key.recovery.json    wrapped with the recovery key shown once: for a new PC or a new Windows account
//   data-key.passphrase.json  optional: wrapped with a passphrase (scrypt); then data-key.wrapped is removed
// Everything uses AES-256-GCM and scrypt/HKDF from Node's own crypto module; nothing is home-made.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const KEY_BYTES = 32;
const MIN_PASSPHRASE = 12;
const AAD = Buffer.from('starkllm-data-key-v1');
const SCRYPT = { N: 2 ** 15, r: 8, p: 1 };
const UNLOCK_CONTEXT = 'starkllm-protection-unlock';

class DataKeyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// --- key stores --------------------------------------------------------------------------------------------------

function createSafeStorageKeyStore(safeStorage) {
  return {
    name: 'electron-safe-storage',
    isAvailable() {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) return false;
      // Linux without a keyring falls back to a fixed password ("basic_text"): that is not protection.
      if (typeof safeStorage.getSelectedStorageBackend === 'function' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
      return true;
    },
    wrap(buf) {
      return safeStorage.encryptString(buf.toString('base64'));
    },
    unwrap(buf) {
      return Buffer.from(safeStorage.decryptString(buf), 'base64');
    }
  };
}

// For tests: the same interface, AES-GCM under a secret that lives only in memory.
function createMemoryKeyStore({ secret = crypto.randomBytes(32), available = true } = {}) {
  return {
    name: 'memory (test)',
    isAvailable: () => available,
    wrap(buf) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', secret, iv);
      return Buffer.concat([iv, c.update(buf), c.final(), c.getAuthTag()]);
    },
    unwrap(buf) {
      const d = crypto.createDecipheriv('aes-256-gcm', secret, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(buf.length - 16));
      return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
    }
  };
}

// --- envelopes ---------------------------------------------------------------------------------------------------

const b64 = (buf) => buf.toString('base64');

function seal(kek, key, extra = {}) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', kek, iv);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(key), c.final()]);
  return { v: 1, alg: 'aes-256-gcm', iv: b64(iv), ct: b64(ct), tag: b64(c.getAuthTag()), ...extra };
}

function open(kek, env) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(env.iv, 'base64'));
    d.setAAD(AAD);
    d.setAuthTag(Buffer.from(env.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(env.ct, 'base64')), d.final()]);
  } catch (e) {
    return null;
  }
}

// --- recovery key: 256 random bits + 16 checksum bits as 55 base32 characters in groups of 5 ---------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(text) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of text) {
    const i = B32.indexOf(ch);
    if (i < 0) return null;
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const checksum = (buf) => crypto.createHash('sha256').update(buf).digest().subarray(0, 2);

function formatRecoveryKey(raw) {
  return base32(Buffer.concat([raw, checksum(raw)])).match(/.{1,5}/g).join('-');
}

// Returns the 32 bytes, or null if the text is not a recovery key (typo, wrong length, failed checksum).
function parseRecoveryKey(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');
  if (clean.length !== 55) return null;
  const bytes = unbase32(clean);
  if (!bytes || bytes.length < KEY_BYTES + 2) return null;
  const raw = bytes.subarray(0, KEY_BYTES);
  return checksum(raw).equals(bytes.subarray(KEY_BYTES, KEY_BYTES + 2)) ? Buffer.from(raw) : null;
}

const recoveryKek = (raw, salt) => Buffer.from(crypto.hkdfSync('sha256', raw, salt, 'starkllm/recovery/v1', KEY_BYTES));

function passphraseKek(passphrase, kdf) {
  return crypto.scryptSync(String(passphrase), Buffer.from(kdf.salt, 'base64'), KEY_BYTES, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
}

// --- the manager -------------------------------------------------------------------------------------------------

class DataKeyManager {
  constructor({ dir, keyStore, scrypt = SCRYPT }) {
    this.dir = dir;
    this.keyStore = keyStore;
    this.scrypt = scrypt;
  }

  file(name) {
    return path.join(this.dir, name);
  }

  write(name, data) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file(name) + '.tmp';
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, this.file(name));          // a crash leaves the old file or the new one, never half of one
  }

  readJson(name) {
    try {
      return JSON.parse(fs.readFileSync(this.file(name), 'utf8'));
    } catch (e) {
      return null;
    }
  }

  remove(name) {
    try {
      fs.unlinkSync(this.file(name));
    } catch (e) {
      // not there
    }
  }

  status() {
    return {
      keyStoreAvailable: this.keyStore.isAvailable(),
      hasKey: fs.existsSync(this.file('data-key.wrapped')) || fs.existsSync(this.file('data-key.passphrase.json')),
      passphrase: fs.existsSync(this.file('data-key.passphrase.json')),
      hasRecovery: fs.existsSync(this.file('data-key.recovery.json'))
    };
  }

  requireKeyStore() {
    if (!this.keyStore.isAvailable()) {
      throw new DataKeyError('no-key-store', 'This PC has no safe place for the key (the Windows key store is not available).');
    }
  }

  // New key: wrapped in the key store, plus a recovery key. The recovery key is returned once and never stored.
  create() {
    this.requireKeyStore();
    if (this.status().hasKey) throw new DataKeyError('exists', 'There is already a key.');
    return this.install(crypto.randomBytes(KEY_BYTES));
  }

  // Use this key (new, or from a restored backup): wrap it, make a new recovery key. A key that was there is kept
  // as data-key.previous so an undone restore can still open the older data.
  install(key) {
    this.requireKeyStore();
    if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new DataKeyError('bad-key', 'The key must be 32 bytes.');
    if (fs.existsSync(this.file('data-key.wrapped'))) fs.copyFileSync(this.file('data-key.wrapped'), this.file('data-key.previous'));
    // in passphrase mode the older key is only wrapped with the passphrase: keep that envelope (still locked) for an undone restore
    if (fs.existsSync(this.file('data-key.passphrase.json'))) fs.copyFileSync(this.file('data-key.passphrase.json'), this.file('data-key.previous-passphrase.json'));
    const recovery = crypto.randomBytes(KEY_BYTES);
    const salt = crypto.randomBytes(16);
    this.write('data-key.recovery.json', JSON.stringify(seal(recoveryKek(recovery, salt), key, { salt: b64(salt) })));
    this.write('data-key.wrapped', this.keyStore.wrap(key));
    this.remove('data-key.passphrase.json');
    return { recoveryKey: formatRecoveryKey(recovery) };
  }

  // The key, for handing to the engine. Throws DataKeyError('passphrase-needed') in passphrase mode.
  load(passphrase) {
    if (fs.existsSync(this.file('data-key.passphrase.json'))) {
      if (passphrase == null) throw new DataKeyError('passphrase-needed', 'Enter your passphrase to unlock StarkLLM.');
      const env = this.readJson('data-key.passphrase.json');
      const key = env && open(passphraseKek(passphrase, env.kdf), env);
      if (!key) throw new DataKeyError('wrong-passphrase', 'The passphrase is not right.');
      return key;
    }
    let wrapped;
    try {
      wrapped = fs.readFileSync(this.file('data-key.wrapped'));
    } catch (e) {
      throw new DataKeyError('no-key', 'There is no key on this PC.');
    }
    try {
      const key = this.keyStore.unwrap(wrapped);
      if (key.length !== KEY_BYTES) throw new Error('length');
      return key;
    } catch (e) {
      throw new DataKeyError('key-store-failed', 'The key cannot be opened with this Windows account. Use your recovery key.');
    }
  }

  // New PC or new Windows account: the recovery key opens the data key, which is then wrapped for this account.
  recover(recoveryText) {
    this.requireKeyStore();
    const raw = parseRecoveryKey(recoveryText);
    if (!raw) throw new DataKeyError('bad-recovery-key', 'The recovery key is not right. Check every character.');
    const env = this.readJson('data-key.recovery.json');
    const key = env && open(recoveryKek(raw, Buffer.from(env.salt, 'base64')), env);
    if (!key) throw new DataKeyError('wrong-recovery-key', 'This recovery key does not belong to the data on this PC.');
    this.write('data-key.wrapped', this.keyStore.wrap(key));
    this.remove('data-key.passphrase.json');
    return key;
  }

  // Optional: also ask for a passphrase at every start. The key store copy is removed, so someone using the open
  // Windows session still cannot start StarkLLM's protected data without the passphrase.
  enablePassphrase(passphrase, currentKey) {
    if (String(passphrase || '').length < MIN_PASSPHRASE) throw new DataKeyError('weak-passphrase', 'Use a passphrase of at least 12 characters.');
    const kdf = { name: 'scrypt', ...this.scrypt, salt: b64(crypto.randomBytes(16)) };
    this.write('data-key.passphrase.json', JSON.stringify(seal(passphraseKek(passphrase, kdf), currentKey, { kdf })));
    this.remove('data-key.wrapped');
  }

  disablePassphrase(passphrase) {
    this.requireKeyStore();
    const key = this.load(passphrase);
    this.write('data-key.wrapped', this.keyStore.wrap(key));
    this.remove('data-key.passphrase.json');
  }

  // Protection is off for good and the user wants the key gone (the recovery key stops working as well).
  forget() {
    for (const f of ['data-key.wrapped', 'data-key.recovery.json', 'data-key.passphrase.json', 'data-key.previous', 'data-key.previous-passphrase.json']) this.remove(f);
  }
}

// The engine accepts the key only with a token derived from its secret (the same idea as the local session).
function unlockToken(secret) {
  return crypto.createHmac('sha256', secret).update(UNLOCK_CONTEXT).digest('hex');
}

async function deliverKey({ apiUrl, secret, key, fetchImpl = fetch }) {
  const res = await fetchImpl(`${apiUrl}/api/v1/system/protection/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-StarkLLM-Internal': unlockToken(secret) },
    body: JSON.stringify({ key: key.toString('base64') }),
    signal: AbortSignal.timeout(8000)
  });
  if (res.ok) return { ok: true };
  let detail = '';
  try {
    detail = (await res.json()).detail || '';
  } catch (e) {
    // no body
  }
  return { ok: false, status: res.status, detail };
}

async function lockEngine({ apiUrl, secret, fetchImpl = fetch, timeoutMs = 3000 }) {
  try {
    const res = await fetchImpl(`${apiUrl}/api/v1/system/protection/lock`, {
      method: 'POST', headers: { 'X-StarkLLM-Internal': unlockToken(secret) }, signal: AbortSignal.timeout(timeoutMs)
    });
    return { ok: res.ok };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  lockEngine,
  MIN_PASSPHRASE, DataKeyManager, DataKeyError, createSafeStorageKeyStore, createMemoryKeyStore,
  formatRecoveryKey, parseRecoveryKey, unlockToken, deliverKey, KEY_BYTES
};
