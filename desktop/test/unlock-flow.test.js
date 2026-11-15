const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DataKeyManager, createMemoryKeyStore, lockEngine, MIN_PASSPHRASE } = require('../data-key');
const { createUnlockFlow } = require('../unlock-flow');

const PASS = 'a long passphrase 12';
const FAST = { N: 2 ** 10, r: 8, p: 1 };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unlock-'));
  const keys = new DataKeyManager({ dir, keyStore: createMemoryKeyStore(), scrypt: FAST });
  const { recoveryKey } = keys.create();
  const key = keys.load();
  keys.enablePassphrase(PASS, key);
  const delivered = [];
  const sleeps = [];
  const unlockEngine = async (passphrase) => {
    try {
      delivered.push(keys.load(passphrase));
      return { ok: true };
    } catch (e) {
      return { error: e.code, message: e.message };
    }
  };
  let opened = 0;
  const flow = createUnlockFlow({ keys, unlockEngine, onUnlocked: async () => { opened++; }, sleep: async (ms) => { sleeps.push(ms); } });
  return { dir, keys, key, recoveryKey, flow, delivered, sleeps, opened: () => opened };
}

test('the right passphrase hands the key to the engine and opens the app', async () => {
  const s = setup();
  const r = await s.flow.submit(PASS);
  assert.deepStrictEqual(r, { ok: true });
  assert.ok(s.delivered[0].equals(s.key));
  assert.strictEqual(s.opened(), 1);
  assert.deepStrictEqual(s.sleeps, []);
});

test('a wrong passphrase is refused, slowed down more each time, and nothing is opened', async () => {
  const s = setup();
  for (let i = 1; i <= 6; i++) {
    const r = await s.flow.submit('wrong passphrase ' + i);
    assert.strictEqual(r.error, 'wrong-passphrase');
    assert.strictEqual(r.attempts, i);
  }
  assert.deepStrictEqual(s.sleeps, [250, 500, 1000, 2000, 4000, 8000]);
  assert.strictEqual(s.delivered.length, 0);
  assert.strictEqual(s.opened(), 0);
  assert.strictEqual((await s.flow.submit(PASS)).ok, true);          // the right one still works afterwards
  assert.strictEqual(s.flow.attempts(), 0);
});

test('the delay stops growing at the maximum', async () => {
  const s = setup();
  for (let i = 0; i < 12; i++) await s.flow.submit('nope nope nope nope');
  assert.strictEqual(Math.max(...s.sleeps), 8000);
});

test('an empty passphrase is not sent anywhere', async () => {
  const s = setup();
  assert.strictEqual((await s.flow.submit('')).error, 'passphrase-needed');
  assert.strictEqual(s.delivered.length, 0);
});

test('the recovery key opens the data key, switches the passphrase off and opens the app', async () => {
  const s = setup();
  const r = await s.flow.recover(s.recoveryKey);
  assert.deepStrictEqual(r, { ok: true, passphraseOff: true });
  assert.ok(s.delivered[0].equals(s.key));
  assert.strictEqual(s.keys.status().passphrase, false);
  assert.ok(s.keys.load().equals(s.key));                            // no passphrase needed from now on
  assert.strictEqual(s.opened(), 1);
});

test('a mistyped or foreign recovery key is refused and counted', async () => {
  const s = setup();
  const chars = s.recoveryKey.split('');
  const i = chars.findIndex((c) => c !== '-');
  chars[i] = chars[i] === 'A' ? 'B' : 'A';
  assert.strictEqual((await s.flow.recover(chars.join(''))).error, 'bad-recovery-key');
  const other = new DataKeyManager({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'other-')), keyStore: createMemoryKeyStore(), scrypt: FAST });
  assert.strictEqual((await s.flow.recover(other.create().recoveryKey)).error, 'wrong-recovery-key');
  assert.strictEqual(s.flow.attempts(), 2);
  assert.strictEqual(s.keys.status().passphrase, true);              // still protected by the passphrase
  assert.strictEqual(s.opened(), 0);
});

test('no passphrase and no derived key are written anywhere', async () => {
  const s = setup();
  await s.flow.submit(PASS);
  await s.flow.submit('wrong wrong wrong wrong');
  for (const f of fs.readdirSync(s.dir)) {
    const raw = fs.readFileSync(path.join(s.dir, f));
    assert.ok(!raw.includes(PASS) && !raw.includes('wrong wrong wrong wrong'), f);
    assert.ok(!raw.includes(s.key) && !raw.includes(s.key.toString('base64')), f);
  }
});

test('the engine refusing the key is shown, not swallowed', async () => {
  const keys = { recover() {} };
  const flow = createUnlockFlow({ keys, unlockEngine: async () => ({ error: 'engine-refused', message: 'no' }), sleep: async () => {} });
  assert.strictEqual((await flow.submit('whatever passphrase')).error, 'engine-refused');
  assert.strictEqual((await flow.recover('x')).error, 'engine-refused');
});

test('passphrase mode needs a passphrase at start and a weak one cannot be set', () => {
  const s = setup();
  assert.throws(() => s.keys.load(), (e) => e.code === 'passphrase-needed');
  assert.throws(() => s.keys.enablePassphrase('x'.repeat(MIN_PASSPHRASE - 1), s.key), (e) => e.code === 'weak-passphrase');
});

test('lockEngine sends the token and never throws', async () => {
  const seen = [];
  const ok = await lockEngine({ apiUrl: 'http://127.0.0.1:8000', secret: 's', fetchImpl: async (u, o) => { seen.push([u, o.headers['X-StarkLLM-Internal']]); return { ok: true }; } });
  assert.deepStrictEqual(ok, { ok: true });
  assert.strictEqual(seen[0][0], 'http://127.0.0.1:8000/api/v1/system/protection/lock');
  assert.match(seen[0][1], /^[0-9a-f]{64}$/);
  const down = await lockEngine({ apiUrl: 'u', secret: 's', fetchImpl: async () => { throw new Error('refused'); } });
  assert.strictEqual(down.ok, false);
});

test('unlock.html has English and German for every message the app can send, and never sends data anywhere', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'unlock.html'), 'utf8');
  const codes = ['passphrase-needed', 'wrong-passphrase', 'bad-recovery-key', 'wrong-recovery-key', 'engine-refused', 'key-store-failed', 'no-key', 'failed'];
  for (const c of codes) assert.strictEqual(html.split(`'${c}':`).length - 1 + (c === 'failed' ? html.split('failed:').length - 1 : 0) >= 2, true, c);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /https?:\/\/|fetch\(|XMLHttpRequest|localStorage/);
});
