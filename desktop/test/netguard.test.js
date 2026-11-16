// Roadmap phase 3, "provable privacy": every connection of the desktop app goes through netguard.js, is recorded, and
// is refused while the app is fully offline. node --test test/  (no Electron needed: everything outside is a fake)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGuard, classify, OfflineError, hostOf, FEATURES } = require('../netguard');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'starkllm-net-'));

test('destinations: this PC, the local network, the internet', () => {
  for (const h of ['localhost', '127.0.0.1', '[::1]', '127.5.5.5']) assert.strictEqual(classify(h), 'this_pc', h);
  for (const h of ['192.168.1.5', '10.0.0.2', '172.20.1.1', 'nas.local', 'printer.lan']) assert.strictEqual(classify(h), 'lan', h);
  for (const h of ['api.github.com', '93.184.216.34', 'ollama.com', '172.32.0.1']) assert.strictEqual(classify(h), 'internet', h);
  assert.strictEqual(hostOf('https://API.GitHub.com:443/repos/x?q=secret'), 'api.github.com');
});

test('a connection is recorded with host, purpose and size but never with a path or a query', () => {
  const g = createGuard({ dir: null });
  const h = g.begin('update_check', 'https://api.github.com/repos/StarkChristian/StarkLLM/releases/latest?token=abc', '', {});
  h.finish({ status: 200, bytesIn: 4321 });
  const [e] = g.list();
  assert.strictEqual(e.host, 'api.github.com');
  assert.strictEqual(e.feature, 'update_check');
  assert.strictEqual(e.bytes_in, 4321);
  assert.strictEqual(e.status, 200);
  assert.strictEqual(e.source, 'app');
  assert.ok(e.purpose && e.time);
  assert.ok(!JSON.stringify(e).includes('token') && !JSON.stringify(e).includes('StarkChristian'));
  assert.strictEqual(g.list().length, 1, 'the finished entry replaces the first line');
});

test('connections to this PC are counted, not listed', () => {
  const g = createGuard({ dir: null });
  g.begin('local_engine', 'http://127.0.0.1:8000/health').finish({});
  assert.deepStrictEqual(g.list(), []);
  assert.strictEqual(g.localCounts().local_engine, 1);
});

test('offline: everything but this PC is refused, and the attempt is listed as blocked', () => {
  const g = createGuard({ dir: null });
  g.setOffline(true);
  for (const f of Object.keys(FEATURES)) assert.throws(() => g.begin(f, 'https://example.org/x'), (e) => e instanceof OfflineError && e.code === 'STARKLLM_OFFLINE');
  assert.throws(() => g.begin('model_download', 'http://127.0.0.1:11434/api/pull', 'x', { via: 'https://registry.ollama.ai' }), OfflineError);
  assert.doesNotThrow(() => g.begin('local_engine', 'http://127.0.0.1:8000/health'));
  assert.doesNotThrow(() => g.begin('model_download', 'http://127.0.0.1:11434/api/tags'));
  assert.ok(g.list().every((e) => e.outcome === 'blocked'));
  assert.strictEqual(g.list().length, Object.keys(FEATURES).length + 1);
});

test('wrapFetch announces a request, counts the answer and refuses while offline', async () => {
  const g = createGuard({ dir: null });
  let calls = 0;
  const fake = async () => {
    calls++;
    return { status: 200, headers: { get: () => '77' } };
  };
  const f = g.wrapFetch(fake, 'update_check', 'x');
  await f('https://api.github.com/x');
  assert.strictEqual(g.list()[0].bytes_in, 77);
  g.setOffline(true);
  await assert.rejects(() => f('https://api.github.com/x'), OfflineError);
  assert.strictEqual(calls, 1, 'nothing was sent while offline');
});

test('a failed request is listed as an error', async () => {
  const g = createGuard({ dir: null });
  await assert.rejects(() => g.wrapFetch(async () => { throw new Error('ECONNRESET'); }, 'update_check')('https://a.example/'));
  assert.strictEqual(g.list()[0].outcome, 'error');
  assert.match(g.list()[0].error, /ECONNRESET/);
});

test('the switch and the log are kept in the profile folder and survive a restart', () => {
  const dir = tmp();
  const g = createGuard({ dir });
  g.begin('update_check', 'https://api.github.com/x').finish({ status: 200 });
  g.setOffline(true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'privacy.json'), 'utf8')), { offline: true, asked: false });
  const again = createGuard({ dir });
  assert.strictEqual(again.isOffline(), true);
  assert.strictEqual(again.list().length, 1);
  again.clear();
  assert.deepStrictEqual(createGuard({ dir }).list(), []);
});

test('the log is trimmed to the newest entries', () => {
  const dir = tmp();
  const g = createGuard({ dir, maxBytes: 3000, maxKeep: 5 });
  for (let i = 0; i < 40; i++) g.record({ feature: 'ui', host: `h${i}.example` });
  assert.ok(fs.statSync(path.join(dir, 'network-log.jsonl')).size < 6000);
  assert.strictEqual(g.list(1)[0].host, 'h39.example');
});

test('CSV export is a spreadsheet-safe table', () => {
  const g = createGuard({ dir: null });
  g.record({ feature: 'ui', host: '=evil.example', purpose: 'a, "quoted" purpose' });
  const csv = g.toCsv();
  assert.ok(csv.startsWith('time,source,feature,purpose,host'));
  assert.ok(csv.includes("'=evil.example") && csv.includes('"a, ""quoted"" purpose"'));
});

// ---- the window: webRequest hook ----
function fakeSession() {
  const h = {};
  return {
    h,
    webRequest: {
      onBeforeRequest: (_f, cb) => { h.before = cb; },
      onCompleted: (_f, cb) => { h.done = cb; },
      onErrorOccurred: (_f, cb) => { h.err = cb; }
    }
  };
}
const ask = (s, url, id = 1) => new Promise((resolve) => s.h.before({ url, id, method: 'GET' }, resolve));

test('the window: requests to this PC pass, others are recorded, and offline they are cancelled', async () => {
  const g = createGuard({ dir: null });
  const s = fakeSession();
  g.attachSession(s);
  assert.deepStrictEqual(await ask(s, 'http://localhost:5173/index.html'), {});
  assert.deepStrictEqual(await ask(s, 'https://cdn.example.net/lib.js?x=1', 7), {});
  s.h.done({ id: 7, statusCode: 200, responseHeaders: { 'Content-Length': ['900'] } });
  const [e] = g.list();
  assert.deepStrictEqual([e.host, e.feature, e.status, e.bytes_in], ['cdn.example.net', 'ui', 200, 900]);
  g.setOffline(true);
  assert.deepStrictEqual(await ask(s, 'https://cdn.example.net/lib.js', 8), { cancel: true });
  assert.deepStrictEqual(await ask(s, 'wss://evil.example/socket', 9), { cancel: true });
  assert.deepStrictEqual(await ask(s, 'http://127.0.0.1:8000/api/v1/x', 10), {});
  assert.strictEqual(g.list().filter((x) => x.outcome === 'blocked').length, 2);
});

// ---- the exit test: with the switch on, the real modules send nothing ----
test('offline: the update check, the Ollama installer and the engine download send nothing', async () => {
  const netguard = require('../netguard');
  const real = netguard.getShared();
  real.setOffline(true);
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (...a) => { sent.push(a[0]); throw new Error('network used'); };
  try {
    // update check (tray menu or start): no fetch, no dialog about an error
    const { createUpdater } = require('../updates');
    const fakeNet = { fetch: async (...a) => { sent.push(a[0]); throw new Error('network used'); } };
    const dialog = { showMessageBox: async () => ({ response: 0 }) };
    const u = createUpdater({ app: { getVersion: () => '2.0.15', getPath: () => tmp(), isPackaged: false }, dialog, shell: {}, net: fakeNet, getWindow: () => null, guard: real });
    assert.deepStrictEqual(await u.check({ manual: false }), { error: 'offline' });
    assert.deepStrictEqual(await u.check({ manual: true }), { error: 'offline' });
    await u.onStart();
    // Ollama installer
    const { installOllama } = require('../ollama-install');
    let downloaded = 0;
    await assert.rejects(() => installOllama({ deps: { guard: real, download: async () => { downloaded++; return { bytes: 1 }; } } }), OfflineError);
    assert.strictEqual(downloaded, 0);
    // layer sizes of the engine images
    const { imageLayerSizes } = require('../engine');
    const sizes = await imageLayerSizes('ghcr.io/starkchristian/starkllm-backend:2.0.15');
    assert.strictEqual(sizes.size, 0);
    assert.deepStrictEqual(sent, [], 'nothing was sent');
    assert.ok(real.list().length >= 2 && real.list().every((e) => e.outcome === 'blocked'));
  } finally {
    global.fetch = realFetch;
    real.setOffline(false);
    real.clear();
  }
});

// ---- no code opens a connection by itself ----
const DESKTOP = path.join(__dirname, '..');
const sources = fs.readdirSync(DESKTOP).filter((f) => f.endsWith('.js') && f !== 'netguard.js')
  .map((f) => [f, fs.readFileSync(path.join(DESKTOP, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')]);

// What may talk to the network, and the proof it goes through the network layer. A new file or a new way of
// connecting fails this test until it is announced to netguard (and listed in docs/privacy-network.md).
const NETWORK_USERS = {
  'updates.js': /guard\.wrapFetch\(.*net\.fetch|guard\.wrapFetch/s,
  'ollama-install.js': /guard\.begin\(/,
  'engine.js': /getShared\(\)\.wrapFetch|guard\.begin\(/,
  'native-engine.js': /guard\.begin\('engine_download'/,
  'main.js': /guard\.wrapFetch/
};

test('code that connects to the internet announces itself to the network layer', () => {
  const patterns = [
    [/require\((['"])https\1\)/, 'https module'],
    [/\bnet\.(fetch|request)\s*\(/, 'electron net'],
    [/(^|[^\w.])fetch\s*\(/, 'global fetch'],
    [/require\((['"])electron-updater\1\)/, 'electron-updater'],
    [/\b(autoUpdater|updater)\.(checkForUpdates|downloadUpdate)\s*\(/, 'update download'],
    [/require\((['"])(net|tls|dgram|dns|http2|node-fetch|axios|got|undici|ws)\1\)/, 'other network module'],
    [/\bnew\s+WebSocket\b|\bXMLHttpRequest\b/, 'socket / XHR']
  ];
  const problems = [];
  for (const [file, text] of sources) {
    for (const [re, label] of patterns) {
      if (!re.test(text)) continue;
      const proof = NETWORK_USERS[file];
      if (!proof || !proof.test(text)) problems.push(`${file}: ${label} without the network layer`);
    }
  }
  assert.deepStrictEqual(problems, []);
});

test('every web address in the code is one that docs/privacy-network.md knows', () => {
  const known = new Set(['127.0.0.1', 'localhost', 'api.github.com', 'github.com', 'ollama.com', 'ghcr.io', 'www.docker.com', 'www.starkllm.com',
    'registry.ollama.ai', 'registry-1.docker.io', 'pypi.org', 'deb.debian.org', 'starkllm.com']);
  const doc = fs.readFileSync(path.join(DESKTOP, '..', 'docs', 'privacy-network.md'), 'utf8');
  const unknown = [];
  for (const [file, text] of sources) {
    for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      const host = m[1].toLowerCase().replace(/\.$/, '');
      if (!known.has(host)) unknown.push(`${file}: ${host}`);
    }
  }
  assert.deepStrictEqual(unknown, [], 'a new host in the desktop code: add it to docs/privacy-network.md and to this list');
  for (const h of known) if (h !== 'localhost' && h !== '127.0.0.1') assert.ok(doc.includes(h), `${h} is missing from docs/privacy-network.md`);
});

test('local probes of the app stay on this PC', () => {
  for (const f of ['engine.js', 'diagnostics.js', 'main.js']) {
    const text = fs.readFileSync(path.join(DESKTOP, f), 'utf8');
    for (const m of text.matchAll(/(OLLAMA_URL|API_URL|HEALTH_URL)\s*=\s*([^;\n]+)/g)) {
      assert.ok(/127\.0\.0\.1|localhost/.test(m[2]), `${f}: ${m[0]}`);
    }
  }
});
