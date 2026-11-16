// Roadmap phase 2: StarkLLM without Docker Desktop. The engine package is downloaded, checked, unpacked and started.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { packageName, packageUrl, engineMode, parseSha256, ensurePackage, nativeEnv } = require('../native-engine');
const { createGuard } = require('../netguard');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'native-engine-'));
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

// stand-ins: "download" writes a known zip text (or the checksum file), "unzip" lays out a package
function fakeDeps({ zipText = 'zip-bytes', shaText, unzipOk = true, hop = null } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      tmpdir: os.tmpdir,
      download: async (url, target, onProgress = () => {}, redirects = 5, onHop = () => {}) => {
        calls.push(url);
        if (hop) onHop(hop);
        fs.writeFileSync(target, url.endsWith('.sha256') ? (shaText ?? `${sha(zipText)}  pkg.zip\n`) : zipText);
        onProgress(zipText.length, zipText.length);
      },
      unzip: async (zip, dir) => {
        if (!unzipOk) return;
        fs.mkdirSync(path.join(dir, 'runtime'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'runtime', 'python.exe'), '');
        fs.writeFileSync(path.join(dir, 'engine.json'), '{"version":"2.1.0"}');
      }
    }
  };
}

test('package name and URL follow the release', () => {
  assert.strictEqual(packageName('2.1.0'), 'StarkLLM-engine-v2.1.0-win-x64.zip');
  assert.match(packageUrl('2.1.0'), /\/releases\/download\/v2\.1\.0\/StarkLLM-engine-v2\.1\.0-win-x64\.zip$/);
});

test('without Docker on Windows the engine runs without Docker', () => {
  assert.strictEqual(engineMode({ env: {}, platform: 'win32', dockerFound: false }), 'native');
  assert.strictEqual(engineMode({ env: {}, platform: 'win32', dockerFound: true }), 'docker', 'Docker users keep Docker');
  assert.strictEqual(engineMode({ env: {}, platform: 'linux', dockerFound: false }), 'docker', 'the package is for Windows');
  assert.strictEqual(engineMode({ env: { STARKLLM_ENGINE: 'native' }, platform: 'win32', dockerFound: true }), 'native');
  assert.strictEqual(engineMode({ env: { STARKLLM_ENGINE: 'docker' }, platform: 'win32', dockerFound: false }), 'docker');
});

test('the checksum file is read in sha256sum format', () => {
  const h = 'a'.repeat(64);
  assert.strictEqual(parseSha256(`${h}  StarkLLM-engine.zip\n`), h);
  assert.strictEqual(parseSha256(h.toUpperCase()), h);
  assert.strictEqual(parseSha256('not a checksum'), null);
});

test('downloads, checks and unpacks the package of the app version, with progress', async () => {
  const base = tmp();
  const { deps, calls } = fakeDeps();
  const seen = [];
  const dir = await ensurePackage('2.1.0', base, { env: {}, deps, onStatus: (t, f) => seen.push([t, f]) });
  assert.strictEqual(dir, path.join(base, '2.1.0'));
  assert.ok(fs.existsSync(path.join(dir, 'engine.json')));
  assert.deepStrictEqual(calls, [packageUrl('2.1.0') + '.sha256', packageUrl('2.1.0')]);
  assert.ok(seen.some(([t, f]) => /Downloading the StarkLLM engine: 100 %/.test(t) && f === 1));
  assert.deepStrictEqual(fs.readdirSync(base), ['2.1.0'], 'the downloaded zip is removed');
});

test('an unpacked package is used again without a download', async () => {
  const base = tmp();
  const first = fakeDeps();
  await ensurePackage('2.1.0', base, { env: {}, deps: first.deps });
  const second = fakeDeps();
  await ensurePackage('2.1.0', base, { env: {}, deps: second.deps });
  assert.deepStrictEqual(second.calls, []);
});

test('a damaged download is refused and not unpacked', async () => {
  const base = tmp();
  const { deps } = fakeDeps({ shaText: `${'0'.repeat(64)}  pkg.zip` });
  await assert.rejects(ensurePackage('2.1.0', base, { env: {}, deps }), /damaged/);
  assert.ok(!fs.existsSync(path.join(base, '2.1.0')));
});

test('an incomplete package is refused', async () => {
  const base = tmp();
  const { deps } = fakeDeps({ unzipOk: false });
  await assert.rejects(ensurePackage('2.1.0', base, { env: {}, deps }), /incomplete/);
  assert.ok(!fs.existsSync(path.join(base, '2.1.0')));
});

test('a new version replaces the old package', async () => {
  const base = tmp();
  await ensurePackage('2.0.9', base, { env: {}, deps: fakeDeps().deps });
  await ensurePackage('2.1.0', base, { env: {}, deps: fakeDeps().deps });
  assert.deepStrictEqual(fs.readdirSync(base), ['2.1.0']);
});

test('a local package (tests) is unpacked without a download and kept', async () => {
  const base = tmp();
  const zip = path.join(tmp(), 'local.zip');
  fs.writeFileSync(zip, 'local');
  const { deps, calls } = fakeDeps();
  await ensurePackage('2.1.0', base, { env: { STARKLLM_ENGINE_PACKAGE: zip }, deps });
  assert.deepStrictEqual(calls, []);
  assert.ok(fs.existsSync(zip));
});

test('the engine gets the UI, the knowledge base folder, Ollama and the chosen models', () => {
  const env = nativeEnv('C:\\pkg', {
    kbDir: 'C:\\Users\\a\\Documents\\StarkLLM Knowledge Base', secret: 's', build: 'native-1', ollamaUrl: 'http://127.0.0.1:11434',
    env: { DEFAULT_TEXT_MODEL: 'qwen3.8:27b', DEFAULT_EMBEDDING_MODEL: 'nomic-embed-text', DEFAULT_VISION_MODEL: 'qwen3.8:27b' }
  });
  assert.strictEqual(env.STARKLLM_STATIC_DIR, path.join('C:\\pkg', 'ui'));
  assert.strictEqual(env.KB_DATA_DIR, 'C:\\Users\\a\\Documents\\StarkLLM Knowledge Base');
  assert.strictEqual(env.OLLAMA_BASE_URL, 'http://127.0.0.1:11434');
  assert.strictEqual(env.STARKLLM_ENGINE_BUILD, 'native-1');
  assert.strictEqual(env.DEFAULT_TEXT_MODEL, 'qwen3.8:27b');
  assert.strictEqual(env.SECRET_KEY, 's');
  assert.strictEqual(env.DO_NOT_TRACK, '1');
});

test('the engine package download is announced to the network layer and listed', async () => {
  const base = tmp();
  const guard = createGuard({ dir: null });
  const { deps } = fakeDeps({ hop: 'https://release-assets.githubusercontent.com/x' });
  await ensurePackage('2.1.0', base, { env: {}, deps: { ...deps, guard } });
  const rows = guard.list();
  assert.ok(rows.length >= 2);
  assert.ok(rows.every((r) => r.feature === 'engine_download' && r.outcome === 'ok'), JSON.stringify(rows));
  assert.ok(rows.some((r) => r.host === 'github.com'));
  assert.ok(rows.some((r) => r.host === 'release-assets.githubusercontent.com'), 'the host GitHub redirects to is listed too');
});

test('fully offline: the engine package is not downloaded, and the refusal is listed', async () => {
  const base = tmp();
  const guard = createGuard({ dir: null });
  guard.setOffline(true);
  const { deps, calls } = fakeDeps();
  await assert.rejects(ensurePackage('2.1.0', base, { env: {}, deps: { ...deps, guard } }), (e) => e.code === 'STARKLLM_OFFLINE');
  assert.deepStrictEqual(calls, [], 'nothing was sent');
  const rows = guard.list();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].outcome, 'blocked');
  assert.strictEqual(rows[0].feature, 'engine_download');
  assert.ok(!fs.existsSync(path.join(base, '2.1.0')));
});

test('fully offline: an engine package already on this PC starts without any connection', async () => {
  const base = tmp();
  await ensurePackage('2.1.0', base, { env: {}, deps: fakeDeps().deps });
  const guard = createGuard({ dir: null });
  guard.setOffline(true);
  const second = fakeDeps();
  const dir = await ensurePackage('2.1.0', base, { env: {}, deps: { ...second.deps, guard } });
  assert.strictEqual(dir, path.join(base, '2.1.0'));
  assert.deepStrictEqual(second.calls, []);
  assert.deepStrictEqual(guard.list(), []);
});

test('the engine without Docker gets the offline switch and the cloud-sync note like the Docker engine', () => {
  const on = nativeEnv('C:\\pkg', { kbDir: 'C:\\kb', secret: 's', build: 'native-1', ollamaUrl: 'http://127.0.0.1:11434', offline: true, kbSync: 'OneDrive', env: {} });
  assert.strictEqual(on.STARKLLM_OFFLINE, '1');
  assert.strictEqual(on.STARKLLM_KB_SYNC, 'OneDrive');
  const off = nativeEnv('C:\\pkg', { kbDir: 'C:\\kb', secret: 's', build: 'native-1', ollamaUrl: 'http://127.0.0.1:11434', env: {} });
  assert.strictEqual(off.STARKLLM_OFFLINE, '');
  assert.ok(!('TZ' in off), 'Python on Windows uses the PC time zone itself');
});
