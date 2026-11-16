const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BackupScheduler, BACKUP_NAME } = require('../backup-schedule');
const { createMemoryKeyStore } = require('../data-key');

const PASS = 'correct horse battery staple';
const DAY = 24 * 3600 * 1000;

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A stand-in for the engine's three backup endpoints.
function fakeEngine({ createError, verifyError, blob = Buffer.from('SLLMBKP-fake-encrypted-bytes') } = {}) {
  const calls = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    assert.match(opts.headers.Authorization, /^Bearer /);
    if (url.endsWith('/create')) {
      assert.strictEqual(JSON.parse(opts.body).passphrase, PASS);
      return createError ? json(createError.status, { detail: createError.detail }) : json(200, { id: 'a'.repeat(32), filename: 'x.starkbackup', report: { ok: true } });
    }
    if (url.includes('/download/')) return new Response(blob, { status: 200 });
    if (url.endsWith('/verify')) {
      assert.strictEqual(opts.body.get('passphrase'), PASS);
      const sent = Buffer.from(await opts.body.get('file').arrayBuffer());
      assert.ok(sent.equals(blob), 'the copy from the folder is what gets verified');
      return verifyError ? json(400, { detail: verifyError }) : json(200, { ok: true, documents: 3, rows: 40, protected: true, size: blob.length });
    }
    throw new Error('unexpected ' + url);
  };
  return { fetchImpl, calls };
}

function setup({ engine = fakeEngine(), start = Date.UTC(2026, 10, 15, 10, 30), keyStore = createMemoryKeyStore(), api = { url: 'http://127.0.0.1:8000', token: 't' } } = {}) {
  const dir = tmp('sched-');
  const folder = tmp('backups-');
  const clock = { t: start };
  const notes = [];
  const s = new BackupScheduler({ dir, keyStore, getApi: () => api, fetchImpl: engine.fetchImpl, now: () => clock.t, notify: (a, b) => notes.push([a, b]) });
  return { s, dir, folder, clock, notes, engine, keyStore };
}

test('a backup is made, saved under a safe name, tested again from the folder and reported', async () => {
  const { s, folder, engine } = setup();
  s.configure({ folder, passphrase: PASS });
  const r = await s.runNow();
  assert.strictEqual(r.ok, true);
  const files = fs.readdirSync(folder);
  assert.strictEqual(files.length, 1);
  assert.match(files[0], BACKUP_NAME);
  assert.deepStrictEqual(engine.calls.map((c) => c.url.split('/').pop().replace(/[0-9a-f]{32}/, 'ID')), ['create', 'ID', 'verify']);
  const st = s.status();
  assert.strictEqual(st.lastError, null);
  assert.strictEqual(st.lastFile, files[0]);
  assert.deepStrictEqual(st.lastReport, { documents: 3, rows: 40, protected: true, size: 28 });
});

test('the passphrase is stored wrapped, never in plain text', () => {
  const { s, dir, folder } = setup();
  s.configure({ folder, passphrase: PASS });
  for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f)).includes(PASS), f);
  assert.strictEqual(s.status().hasPassphrase, true);
  // another Windows account cannot read it
  const other = new BackupScheduler({ dir, keyStore: createMemoryKeyStore(), getApi: () => null });
  assert.strictEqual(other.passphrase(), null);
});

test('only the newest N copies of this program are kept; other files are never touched', async () => {
  const { s, folder, clock } = setup();
  s.configure({ folder, passphrase: PASS, keep: 3 });
  const foreign = ['notes.txt', 'starkllm-old.zip', 'starkllm-2020-01-01_00-00.starkbackup.part', 'holiday.starkbackup', 'starkllm-2020-01-01.starkbackup'];
  for (const f of foreign) fs.writeFileSync(path.join(folder, f), 'mine');
  fs.mkdirSync(path.join(folder, 'starkllm-2020-01-01_00-00.starkbackup-folder'));
  for (let i = 0; i < 5; i++) {
    clock.t += 7 * DAY;
    assert.strictEqual((await s.runNow()).ok, true);
  }
  const ours = fs.readdirSync(folder).filter((n) => BACKUP_NAME.test(n));
  assert.strictEqual(ours.length, 3);
  assert.deepStrictEqual(ours, [...ours].sort());
  assert.ok(ours.includes(s.status().lastFile));
  for (const f of foreign) assert.ok(fs.existsSync(path.join(folder, f)), `${f} must still be there`);
  assert.ok(fs.existsSync(path.join(folder, 'starkllm-2020-01-01_00-00.starkbackup-folder')));
});

test('keep = 1 keeps only the new copy', async () => {
  const { s, folder, clock } = setup();
  s.configure({ folder, passphrase: PASS, keep: 1 });
  for (let i = 0; i < 3; i++) { clock.t += DAY; await s.runNow(); }
  assert.strictEqual(fs.readdirSync(folder).length, 1);
});

test('a copy that fails the restore test is removed, older copies stay, the user is told', async () => {
  const good = setup();
  good.s.configure({ folder: good.folder, passphrase: PASS });
  await good.s.runNow();
  const before = fs.readdirSync(good.folder);
  const bad = new BackupScheduler({
    dir: good.dir, keyStore: good.keyStore, getApi: () => ({ url: 'u', token: 't' }), now: () => good.clock.t + 8 * DAY,
    fetchImpl: fakeEngine({ verifyError: { code: 'damaged', message: 'damaged' } }).fetchImpl, notify: (a, b) => good.notes.push([a, b])
  });
  const r = await bad.runNow();
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'copy-failed');
  assert.deepStrictEqual(fs.readdirSync(good.folder), before);
  assert.match(bad.status().lastError.message, /restore test/);
  assert.strictEqual(good.notes.length, 1);
});

test('folder problems are reported before anything is made', async () => {
  const { s, folder, engine } = setup();
  s.configure({ folder, passphrase: PASS });
  fs.rmSync(folder, { recursive: true });
  const r = await s.runNow();
  assert.strictEqual(r.code, 'folder-missing');
  assert.match(r.message, /USB drive or network folder/);
  assert.strictEqual(engine.calls.length, 0);
});

test('engine refusals give clear messages and a later retry, not a notification storm', async () => {
  for (const [detail, status, code] of [[{ code: 'busy' }, 409, 'busy'], [{ code: 'locked' }, 423, 'locked']]) {
    const { s, folder, notes, clock } = setup({ engine: fakeEngine({ createError: { status, detail } }) });
    s.configure({ folder, passphrase: PASS });
    const r = await s.runNow();
    assert.strictEqual(r.code, code);
    assert.deepStrictEqual(fs.readdirSync(folder), []);
    assert.ok(s.nextDue() > clock.t);
    if (code === 'busy') assert.strictEqual(notes.length, 0);
  }
});

test('the engine not being ready (no token, no connection) is a quiet retry', async () => {
  const { s, folder, notes } = setup({ api: { url: 'u', token: null } });
  s.configure({ folder, passphrase: PASS });
  assert.strictEqual((await s.runNow()).code, 'engine-not-ready');
  assert.strictEqual(notes.length, 0);
});

test('due logic: weekly, retry after a failure, nothing when off', async () => {
  const { s, folder, clock } = setup();
  assert.strictEqual(await s.tick(), null);                      // not configured
  s.configure({ folder, passphrase: PASS });
  assert.strictEqual((await s.tick()).ok, true);                 // first backup is due at once
  assert.strictEqual(await s.tick(), null);
  clock.t += 6 * DAY;
  assert.strictEqual(await s.tick(), null);
  clock.t += 1.1 * DAY;
  assert.strictEqual((await s.tick()).ok, true);
  fs.rmSync(folder, { recursive: true });
  clock.t += 8 * DAY;
  assert.strictEqual((await s.tick()).code, 'folder-missing');
  assert.strictEqual(await s.tick(), null);                      // waits an hour before trying again
  clock.t += 1.1 * 3600 * 1000;
  fs.mkdirSync(folder);
  assert.strictEqual((await s.tick()).ok, true);
  s.disable();
  clock.t += 30 * DAY;
  assert.strictEqual(await s.tick(), null);
  assert.strictEqual(s.status().hasPassphrase, false);           // the passphrase is forgotten when it is switched off
});

test('two runs at the same time make one backup', async () => {
  const { s, folder, engine } = setup();
  s.configure({ folder, passphrase: PASS });
  const [a, b] = await Promise.all([s.runNow(), s.runNow()]);
  assert.deepStrictEqual([a.ok, b.code], [true, 'running']);
  assert.strictEqual(engine.calls.filter((c) => c.url.endsWith('/create')).length, 1);
});

test('settings are checked: short passphrase, no folder, no key store, limits', () => {
  const { s, folder } = setup();
  assert.throws(() => s.configure({ folder, passphrase: 'short' }), (e) => e.code === 'weak-passphrase');
  assert.throws(() => s.configure({ passphrase: PASS }), (e) => e.code === 'no-folder');
  assert.throws(() => s.configure({ folder, keep: 4 }), (e) => e.code === 'no-passphrase');
  const none = setup({ keyStore: createMemoryKeyStore({ available: false }) });
  assert.throws(() => none.s.configure({ folder: none.folder, passphrase: PASS }), (e) => e.code === 'no-key-store');
  const st = s.configure({ folder, passphrase: PASS, keep: 500, intervalDays: 0 });
  assert.deepStrictEqual([st.keep, st.intervalDays], [52, 7]);
  assert.strictEqual(s.status().enabled, true);
});

test('a cloud-synced folder is recognised so the page can say it is fine', () => {
  const { s } = setup();
  s.configure({ folder: tmp('OneDrive-'), passphrase: PASS });
  assert.strictEqual(s.status().cloud, null);                    // the name alone is not enough
  const od = path.join(tmp('home-'), 'OneDrive', 'Backups');
  fs.mkdirSync(od, { recursive: true });
  s.configure({ folder: od });
  assert.strictEqual(s.status().cloud, 'OneDrive');
});

test('a write error while saving leaves no partial file', async () => {
  const { s, folder } = setup({ engine: fakeEngine({ blob: Buffer.alloc(10) }) });
  s.configure({ folder, passphrase: PASS });
  const real = s.fs.createWriteStream;
  s.fs = Object.create(fs, { createWriteStream: { value: () => { const e = new Error('full'); e.code = 'ENOSPC'; const w = new (require('stream').Writable)({ write(c, enc, cb) { cb(e); } }); return w; } } });
  const r = await s.runNow();
  assert.strictEqual(r.code, 'disk-full');
  assert.deepStrictEqual(fs.readdirSync(folder), []);
  s.fs = fs;
  assert.ok(real);
});
