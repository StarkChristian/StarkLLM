// node --test test/  (no Electron needed: app, dialog, shell and net are fakes)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createUpdater, startInstaller, isNewer, parseVersion, decide, DOWNLOAD_PAGE } = require('../updates');

test('version comparison', () => {
  assert.deepStrictEqual(parseVersion('v2.0.3'), [2, 0, 3]);
  assert.strictEqual(parseVersion('latest'), null);
  assert.ok(isNewer('2.0.10', '2.0.9'));
  assert.ok(isNewer('v2.1.0', '2.0.3'));
  assert.ok(!isNewer('2.0.3', '2.0.3'));
  assert.ok(!isNewer('2.0.2', '2.0.3'));
  assert.ok(!isNewer('garbage', '2.0.3'));
});

test('drafts, pre-releases and skipped versions are not offered', () => {
  assert.strictEqual(decide({ tag_name: 'v9.0.0', prerelease: true }, '2.0.3', {}).show, false);
  assert.strictEqual(decide({ tag_name: 'v9.0.0', draft: true }, '2.0.3', {}).show, false);
  assert.strictEqual(decide({ tag_name: 'v2.0.4' }, '2.0.3', { skipVersion: '2.0.4' }).show, false);
  assert.strictEqual(decide({ tag_name: 'v2.0.5' }, '2.0.3', { skipVersion: '2.0.4' }).show, true);
});

function harness({ answers = [], release = { tag_name: 'v2.1.0' }, fail = false, version = '2.0.3', packaged = false, autoUpdater = null, onStatus, spawn } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starkllm-upd-'));
  const calls = { fetch: 0, dialogs: [], opened: [], quit: 0 };
  const deps = {
    app: { getPath: () => dir, getVersion: () => version, isPackaged: packaged },
    dialog: {
      showMessageBox: async (_w, opts) => {
        calls.dialogs.push(opts.message);
        return { response: answers.length ? answers.shift() : 1 };
      }
    },
    shell: { openExternal: (u) => calls.opened.push(u) },
    net: {
      fetch: async (url, opts) => {
        calls.fetch++;
        calls.url = url;
        calls.headers = opts.headers;
        if (fail) throw new Error('offline');
        return { ok: true, status: 200, json: async () => release };
      }
    },
    getWindow: () => null,
    autoUpdater,
    onStatus,
    spawn,
    quit: () => { calls.quit++; }
  };
  return { u: createUpdater(deps), calls, dir };
}

test('first start asks; declining means GitHub is never contacted', async () => {
  const { u, calls, dir } = harness({ answers: [1] });
  await u.onStart();
  assert.strictEqual(calls.dialogs.length, 1);
  assert.match(calls.dialogs[0], /Check for new StarkLLM versions/);
  assert.strictEqual(calls.fetch, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'))).updateCheck, false);
  await u.onStart();
  assert.strictEqual(calls.dialogs.length, 1, 'the question is asked only once');
  assert.strictEqual(calls.fetch, 0);
});

test('agreeing checks and offers the download page for a newer version', async () => {
  const { u, calls } = harness({ answers: [0, 0] });
  await u.onStart();
  assert.strictEqual(calls.fetch, 1);
  assert.match(calls.url, /api\.github\.com\/repos\/StarkChristian\/StarkLLM\/releases\/latest/);
  assert.match(calls.headers['User-Agent'], /^StarkLLM-Desktop\/2\.0\.3$/, 'no personal data in the request');
  assert.match(calls.dialogs[1], /2\.1\.0 is available/);
  assert.deepStrictEqual(calls.opened, [DOWNLOAD_PAGE]);
});

test('no dialog when up to date, and a failed check stays silent on start', async () => {
  const a = harness({ answers: [0], release: { tag_name: 'v2.0.3' } });
  await a.u.onStart();
  assert.strictEqual(a.calls.dialogs.length, 1);
  const b = harness({ answers: [0], fail: true });
  await b.u.onStart();
  assert.strictEqual(b.calls.dialogs.length, 1);
});

test('skip this version is remembered; the manual check still reports it', async () => {
  const { u, calls } = harness({ answers: [0, 2] });
  await u.onStart();
  await u.onStart();
  assert.strictEqual(calls.dialogs.length, 2, 'skipped version is not offered again on start');
  await u.check({ manual: true });
  assert.strictEqual(calls.dialogs.length, 3);
});

test('STARKLLM_UPDATE_CHECK=0 turns the automatic check off', async () => {
  process.env.STARKLLM_UPDATE_CHECK = '0';
  try {
    const { u, calls } = harness();
    await u.onStart();
    assert.strictEqual(calls.dialogs.length + calls.fetch, 0);
  } finally {
    delete process.env.STARKLLM_UPDATE_CHECK;
  }
});

// A stand-in for electron-updater's autoUpdater.
function fakeUpdater({ version = '2.1.0', failDownload = false } = {}) {
  const f = { calls: [], listeners: {} };
  f.on = (ev, cb) => { f.listeners[ev] = cb; };
  f.removeListener = (ev) => { delete f.listeners[ev]; };
  f.checkForUpdates = async () => { f.calls.push('check'); return { updateInfo: { version } }; };
  f.downloadUpdate = async () => {
    f.calls.push('download');
    if (f.listeners['download-progress']) f.listeners['download-progress']({ percent: 50 });
    if (failDownload) throw new Error('404 latest.yml');
  };
  f.quitAndInstall = () => { f.calls.push('quitAndInstall'); };
  f.installerPath = 'C:\\Users\\u\\AppData\\Local\\starkllm-desktop-updater\\pending\\StarkLLM-v2.1.0-Setup.exe';
  return f;
}

// A stand-in for child_process.spawn: Windows starts the file, or refuses it like Smart App Control did
// ("spawn UNKNOWN", error code UNKNOWN).
function fakeSpawn({ refuse = false } = {}) {
  const runs = [];
  const spawn = (file, args, opts) => {
    runs.push({ file, args, opts });
    const p = new EventEmitter();
    p.unref = () => { p.unrefed = true; };
    process.nextTick(() => {
      if (refuse) p.emit('error', Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN' }));
      else p.emit('spawn');
    });
    return p;
  };
  return { spawn, runs };
}
const flush = () => new Promise((r) => setImmediate(r));

test('the installed app downloads and installs the update after the user agrees, with a database backup', async () => {
  const au = fakeUpdater();
  const sp = fakeSpawn();
  const { u, calls, dir } = harness({ answers: [0, 0, 0], packaged: true, autoUpdater: au, spawn: sp.spawn });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'starkllm.db'), 'db');
  await u.onStart();
  await flush();
  assert.match(calls.dialogs[1], /2\.1\.0 is available/);
  assert.match(calls.dialogs[2], /ready to install/);
  assert.deepStrictEqual(au.calls, ['check', 'download'], 'StarkLLM starts the installer itself, not quitAndInstall');
  assert.strictEqual(sp.runs.length, 1);
  assert.strictEqual(sp.runs[0].file, au.installerPath);
  assert.deepStrictEqual(sp.runs[0].args, ['--updated', '/S', '--force-run']);
  assert.strictEqual(sp.runs[0].opts.detached, true, 'the installer outlives the app');
  assert.strictEqual(calls.quit, 1, 'the app quits so the installer can replace it');
  assert.deepStrictEqual(calls.opened, [], 'no website needed');
  assert.strictEqual(au.autoDownload, false, 'nothing is downloaded without the click');
  const backups = fs.readdirSync(path.join(dir, 'backups'));
  assert.strictEqual(backups.length, 1);
  assert.match(backups[0], /^starkllm-2\.0\.3-.*\.db$/);
});

test('"Later" downloads nothing', async () => {
  const au = fakeUpdater();
  const { u } = harness({ answers: [0, 1], packaged: true, autoUpdater: au });
  await u.onStart();
  assert.deepStrictEqual(au.calls, []);
});

test('a failed download offers the download page instead', async () => {
  const au = fakeUpdater({ failDownload: true });
  const { u, calls } = harness({ answers: [0, 0, 0], packaged: true, autoUpdater: au });
  await u.onStart();
  assert.match(calls.dialogs[2], /could not be downloaded/);
  assert.deepStrictEqual(calls.opened, [DOWNLOAD_PAGE]);
});

test('the portable exe keeps the download page (it cannot replace itself)', async () => {
  process.env.PORTABLE_EXECUTABLE_DIR = 'C:\\Tools';
  try {
    const au = fakeUpdater();
    const { u, calls } = harness({ answers: [0, 0], packaged: true, autoUpdater: au });
    await u.onStart();
    assert.deepStrictEqual(au.calls, []);
    assert.deepStrictEqual(calls.opened, [DOWNLOAD_PAGE]);
  } finally {
    delete process.env.PORTABLE_EXECUTABLE_DIR;
  }
});

test('the page hears the download progress and its end (Settings showed "Checking..." for the whole download)', async () => {
  const au = fakeUpdater();
  const seen = [];
  const { u } = harness({ answers: [0, 0, 1], packaged: true, autoUpdater: au, onStatus: (st) => seen.push(st) });
  await u.onStart();
  assert.deepStrictEqual(seen, [{ phase: 'downloading', percent: 0 }, { phase: 'downloading', percent: 50 }, { phase: 'done' }]);
});

test('Windows refuses the new installer: no admin prompt, the app keeps running and says why', async () => {
  const au = fakeUpdater();
  const sp = fakeSpawn({ refuse: true });
  const { u, calls } = harness({ answers: [0, 0, 0, 0], packaged: true, autoUpdater: au, spawn: sp.spawn });
  await u.onStart();
  assert.strictEqual(sp.runs.length, 1, 'tried once');
  assert.ok(!sp.runs.some((r) => /elevate\.exe$/i.test(r.file)), 'never retried through elevate.exe');
  assert.ok(!au.calls.includes('quitAndInstall'));
  assert.strictEqual(calls.quit, 0, 'StarkLLM stays open');
  assert.match(calls.dialogs[3], /Windows has not started the StarkLLM 2\.1\.0 installer yet/);
  assert.strictEqual(au.autoInstallOnAppQuit, false, 'electron-updater does not try again on quit');
  // quitting later tries once more (Windows may trust the file by then), again without admin rights
  u.installOnQuit();
  assert.strictEqual(sp.runs.length, 2);
  assert.deepStrictEqual(sp.runs[1].args, ['--updated', '/S']);
  assert.ok(!/elevate\.exe$/i.test(sp.runs[1].file));
});

test('"When I quit" starts the installer while the app closes, without restarting it', async () => {
  const au = fakeUpdater();
  const sp = fakeSpawn();
  const { u, calls } = harness({ answers: [0, 0, 1], packaged: true, autoUpdater: au, spawn: sp.spawn });
  await u.onStart();
  assert.strictEqual(sp.runs.length, 0, 'nothing starts before the user quits');
  u.installOnQuit();
  assert.strictEqual(sp.runs.length, 1, 'the start happens at once, before the app is gone');
  assert.deepStrictEqual(sp.runs[0].args, ['--updated', '/S']);
  u.installOnQuit();
  assert.strictEqual(sp.runs.length, 1, 'only once');
  assert.strictEqual(calls.quit, 0, 'the app was already quitting');
});

test('startInstaller reports a start and a refusal', async () => {
  assert.deepStrictEqual(await startInstaller('a.exe', [], fakeSpawn().spawn), { ok: true });
  const r = await startInstaller('a.exe', [], fakeSpawn({ refuse: true }).spawn);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'UNKNOWN');
  const thrown = await startInstaller('a.exe', [], () => { throw new Error('EINVAL'); });
  assert.strictEqual(thrown.ok, false);
});
