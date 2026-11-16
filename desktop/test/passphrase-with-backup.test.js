// The start-up passphrase together with the weekly backup (both live in the same key folder and use the same key store).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DataKeyManager, createMemoryKeyStore } = require('../data-key');
const { BackupScheduler } = require('../backup-schedule');
const { createUnlockFlow } = require('../unlock-flow');

const PASS = 'a long passphrase 12';
const BACKUP_PASS = 'correct horse battery staple';
const FAST = { N: 2 ** 10, r: 8, p: 1 };

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'both-'));
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bk-'));
  const keyStore = createMemoryKeyStore();
  const keys = new DataKeyManager({ dir, keyStore, scrypt: FAST });
  const { recoveryKey } = keys.create();
  const key = keys.load();
  keys.enablePassphrase(PASS, key);
  let engineUnlocked = false;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const blob = Buffer.from('SLLMBKP-bytes');
  const fetchImpl = async (url, opts = {}) => {            // the engine: refuses while it has no key
    if (!engineUnlocked) return json(423, { detail: { code: 'locked', message: 'locked' } });
    if (url.endsWith('/create')) return json(200, { id: 'b'.repeat(32), filename: 'x', report: {} });
    if (url.includes('/download/')) return new Response(blob);
    return json(200, { ok: true, documents: 1, rows: 2, protected: true, size: blob.length });
  };
  const notes = [];
  const scheduler = new BackupScheduler({ dir, keyStore, getApi: () => ({ url: 'u', token: 't' }), fetchImpl, notify: (a, b) => notes.push([a, b]) });
  scheduler.configure({ folder, passphrase: BACKUP_PASS });
  return { dir, folder, keys, key, recoveryKey, scheduler, notes, unlockEngine: () => { engineUnlocked = true; } };
}

test('before the passphrase is entered the engine is locked: the backup waits quietly and succeeds after the unlock', async () => {
  const w = world();
  const early = await w.scheduler.runNow();
  assert.strictEqual(early.code, 'locked');
  assert.deepStrictEqual(fs.readdirSync(w.folder), []);
  assert.strictEqual(w.notes.length, 1);                       // a real message once; the retry is not immediate
  assert.ok(w.scheduler.nextDue() > Date.now());
  const flow = createUnlockFlow({ keys: w.keys, unlockEngine: async (p) => { w.keys.load(p); w.unlockEngine(); return { ok: true }; } });
  assert.deepStrictEqual(await flow.submit(PASS), { ok: true });
  const later = await w.scheduler.runNow();
  assert.strictEqual(later.ok, true);
  assert.strictEqual(fs.readdirSync(w.folder).length, 1);
});

test('the backup passphrase does not depend on the start-up passphrase and is never stored in plain text', () => {
  const w = world();
  assert.strictEqual(w.scheduler.passphrase(), BACKUP_PASS);   // readable without typing the start-up passphrase (Windows key store)
  for (const f of fs.readdirSync(w.dir)) {
    const raw = fs.readFileSync(path.join(w.dir, f));
    assert.ok(!raw.includes(BACKUP_PASS) && !raw.includes(PASS), f);
  }
});

test('restoring a protected backup installs its key and switches the start-up passphrase off (the old key is kept)', () => {
  const w = world();
  assert.strictEqual(w.keys.status().passphrase, true);
  const restored = crypto.randomBytes(32);
  const { recoveryKey } = w.keys.install(restored);
  assert.strictEqual(w.keys.status().passphrase, false);
  assert.ok(w.keys.load().equals(restored));
  // the older key was only wrapped with the passphrase: that locked envelope is kept, and still opens with the passphrase
  const kept = JSON.parse(fs.readFileSync(path.join(w.dir, 'data-key.previous-passphrase.json'), 'utf8'));
  fs.writeFileSync(path.join(w.dir, 'data-key.passphrase.json'), JSON.stringify(kept));
  assert.ok(w.keys.load(PASS).equals(w.key));
  fs.unlinkSync(path.join(w.dir, 'data-key.passphrase.json'));
  assert.ok(w.keys.recover(recoveryKey).equals(restored));
  assert.strictEqual(w.scheduler.passphrase(), BACKUP_PASS);   // the weekly backup keeps working after a restore
});
