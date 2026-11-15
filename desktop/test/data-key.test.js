const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  DataKeyManager, DataKeyError, createMemoryKeyStore, createSafeStorageKeyStore,
  formatRecoveryKey, parseRecoveryKey, unlockToken, deliverKey
} = require('../data-key');

const FAST = { N: 2 ** 10, r: 8, p: 1 };           // scrypt settings that are cheap enough for tests

function manager(keyStore = createMemoryKeyStore()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'datakey-'));
  return { dir, keyStore, m: new DataKeyManager({ dir, keyStore, scrypt: FAST }) };
}

function allFilesContain(dir, needle) {
  return fs.readdirSync(dir).some((f) => {
    const raw = fs.readFileSync(path.join(dir, f));
    return raw.includes(needle) || raw.includes(Buffer.from(needle.toString('base64')));
  });
}

test('a new key is created, wrapped and can be loaded again; the key itself is never written', () => {
  const { dir, m } = manager();
  const { recoveryKey } = m.create();
  const key = m.load();
  assert.strictEqual(key.length, 32);
  assert.match(recoveryKey, /^([A-Z2-7]{5}-){10}[A-Z2-7]{5}$/);
  assert.ok(!allFilesContain(dir, key), 'plain key found on disk');
  assert.deepStrictEqual(m.status(), { keyStoreAvailable: true, hasKey: true, passphrase: false, hasRecovery: true });
  assert.throws(() => m.create(), (e) => e.code === 'exists');
});

test('the recovery key is not stored and opens the key on a new PC', () => {
  const a = manager();
  const { recoveryKey } = a.m.create();
  const key = a.m.load();
  assert.ok(!allFilesContain(a.dir, Buffer.from(recoveryKey)));
  // new PC: the data folder (with the recovery envelope) is there, but the Windows key store is a different one
  const b = manager(createMemoryKeyStore());
  fs.copyFileSync(path.join(a.dir, 'data-key.recovery.json'), path.join(b.dir, 'data-key.recovery.json'));
  assert.throws(() => b.m.load(), (e) => e.code === 'no-key');
  const again = b.m.recover(recoveryKey.toLowerCase().replace(/-/g, ' '));   // typed in lower case with spaces
  assert.ok(again.equals(key));
  assert.ok(b.m.load().equals(key));                                          // now wrapped for this PC
});

test('a key store that cannot open the wrapped key gives a clear error', () => {
  const a = manager();
  a.m.create();
  const other = new DataKeyManager({ dir: a.dir, keyStore: createMemoryKeyStore(), scrypt: FAST });   // other Windows user
  assert.throws(() => other.load(), (e) => e instanceof DataKeyError && e.code === 'key-store-failed' && /recovery key/.test(e.message));
});

test('typos and foreign recovery keys are refused', () => {
  const a = manager();
  const { recoveryKey } = a.m.create();
  const chars = recoveryKey.split('');
  const i = chars.findIndex((c) => c !== '-');
  chars[i] = chars[i] === 'A' ? 'B' : 'A';
  assert.strictEqual(parseRecoveryKey(chars.join('')), null);                 // checksum catches one wrong character
  assert.strictEqual(parseRecoveryKey('too short'), null);
  assert.throws(() => a.m.recover(chars.join('')), (e) => e.code === 'bad-recovery-key');
  const other = manager();
  const foreign = other.m.create().recoveryKey;
  assert.throws(() => a.m.recover(foreign), (e) => e.code === 'wrong-recovery-key');
});

test('recovery key text round trip', () => {
  for (let i = 0; i < 50; i++) {
    const raw = crypto.randomBytes(32);
    assert.ok(parseRecoveryKey(formatRecoveryKey(raw)).equals(raw));
  }
});

test('without a key store nothing is created', () => {
  const { m } = manager(createMemoryKeyStore({ available: false }));
  assert.throws(() => m.create(), (e) => e.code === 'no-key-store');
});

test('passphrase mode: the key store copy is removed and the passphrase is needed', () => {
  const { dir, m } = manager();
  m.create();
  const key = m.load();
  m.enablePassphrase('a long passphrase', key);
  assert.ok(!fs.existsSync(path.join(dir, 'data-key.wrapped')));
  assert.ok(!allFilesContain(dir, key));
  assert.throws(() => m.load(), (e) => e.code === 'passphrase-needed');
  assert.throws(() => m.load('wrong passphrase'), (e) => e.code === 'wrong-passphrase');
  assert.ok(m.load('a long passphrase').equals(key));
  assert.throws(() => m.enablePassphrase('short', key), (e) => e.code === 'weak-passphrase');
  m.disablePassphrase('a long passphrase');
  assert.ok(m.load().equals(key));
  assert.strictEqual(m.status().passphrase, false);
});

test('installing a key from a restored backup keeps the previous one', () => {
  const { dir, m } = manager();
  m.create();
  const old = m.load();
  const restored = crypto.randomBytes(32);
  const { recoveryKey } = m.install(restored);
  assert.ok(m.load().equals(restored));
  assert.ok(fs.existsSync(path.join(dir, 'data-key.previous')));
  assert.ok(m.recover(recoveryKey).equals(restored));                         // the new recovery key matches the new key
  assert.ok(!m.load().equals(old));
  assert.throws(() => m.install(Buffer.alloc(5)), (e) => e.code === 'bad-key');
});

test('forget removes every copy of the key', () => {
  const { dir, m } = manager();
  m.create();
  m.forget();
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('a damaged wrapped key is not mistaken for a key', () => {
  const { dir, m } = manager();
  m.create();
  const f = path.join(dir, 'data-key.wrapped');
  const bytes = fs.readFileSync(f);
  bytes[20] ^= 1;
  fs.writeFileSync(f, bytes);
  assert.throws(() => m.load(), (e) => e.code === 'key-store-failed');
});

test('safeStorage key store: refuses the Linux plain-text fallback and wraps through Electron', () => {
  const fake = (backend, avail = true) => ({
    isEncryptionAvailable: () => avail,
    getSelectedStorageBackend: () => backend,
    encryptString: (s) => Buffer.from('enc:' + s),
    decryptString: (b) => b.toString().slice(4)
  });
  assert.strictEqual(createSafeStorageKeyStore(fake('basic_text')).isAvailable(), false);
  assert.strictEqual(createSafeStorageKeyStore(fake('gnome_libsecret', false)).isAvailable(), false);
  const ks = createSafeStorageKeyStore(fake('gnome_libsecret'));
  assert.strictEqual(ks.isAvailable(), true);
  const k = crypto.randomBytes(32);
  assert.ok(ks.unwrap(ks.wrap(k)).equals(k));
});

test('the unlock token matches the engine (same HMAC as backend/app/api/protection.py)', () => {
  assert.strictEqual(unlockToken('test-secret-for-unlock'), 'b69f9c3abf79e9a34f37e485a935c1483b0ce1a9090ee53ad5ac047ac2ad8efd');
});

test('deliverKey sends the key with the token and reports a refusal', async () => {
  const seen = [];
  const key = crypto.randomBytes(32);
  const ok = await deliverKey({
    apiUrl: 'http://127.0.0.1:8000', secret: 's', key,
    fetchImpl: async (url, opts) => { seen.push({ url, opts }); return { ok: true }; }
  });
  assert.deepStrictEqual(ok, { ok: true });
  assert.strictEqual(seen[0].url, 'http://127.0.0.1:8000/api/v1/system/protection/unlock');
  assert.strictEqual(seen[0].opts.headers['X-StarkLLM-Internal'], unlockToken('s'));
  assert.strictEqual(JSON.parse(seen[0].opts.body).key, key.toString('base64'));
  const no = await deliverKey({ apiUrl: 'u', secret: 's', key, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ detail: 'not the key' }) }) });
  assert.deepStrictEqual(no, { ok: false, status: 403, detail: 'not the key' });
});
