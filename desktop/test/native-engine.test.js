// Roadmap phase 2: StarkLLM without Docker Desktop. The engine package is downloaded, checked, unpacked and started.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { packageName, packageUrl, engineMode, readEngineChoice, writeEngineChoice, bundledPackage, removeDownloadedPackages, parseSha256, ensurePackage, nativeEnv } = require('../native-engine');
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
  // owner decision 2026-11-16: the engine without Docker is the default for everyone on Windows, Docker users too
  assert.strictEqual(engineMode({ env: {}, platform: 'win32' }), 'native');
  assert.strictEqual(engineMode({ env: {}, platform: 'win32', choice: null }), 'native', 'existing Docker installs switch too');
  assert.strictEqual(engineMode({ env: {}, platform: 'win32', choice: 'docker' }), 'docker', 'Docker is the advanced choice');
  assert.strictEqual(engineMode({ env: {}, platform: 'win32', choice: 'native' }), 'native');
  assert.strictEqual(engineMode({ env: {}, platform: 'linux' }), 'docker', 'the package is for Windows');
  assert.strictEqual(engineMode({ env: { STARKLLM_ENGINE: 'native' }, platform: 'win32', choice: 'docker' }), 'native');
  assert.strictEqual(engineMode({ env: { STARKLLM_ENGINE: 'docker' }, platform: 'win32', choice: 'native' }), 'docker');
});

test('the engine choice is kept in settings.json next to the other settings', () => {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  assert.strictEqual(readEngineChoice(file), null, 'no file: no choice');
  fs.writeFileSync(file, JSON.stringify({ updateCheck: true }));
  assert.strictEqual(readEngineChoice(file), null);
  assert.strictEqual(writeEngineChoice(file, 'docker'), 'docker');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { updateCheck: true, engine: 'docker' }, 'other settings stay');
  assert.strictEqual(readEngineChoice(file), 'docker');
  writeEngineChoice(file, 'native');
  assert.strictEqual(readEngineChoice(file), 'native');
  fs.writeFileSync(file, JSON.stringify({ engine: 'kubernetes' }));
  assert.strictEqual(readEngineChoice(file), null, 'unknown values are ignored');
  fs.writeFileSync(file, '{broken');
  assert.strictEqual(readEngineChoice(file), null);
});

function fakeBundle(resources, version = '9.9.9') {
  const dir = path.join(resources, 'engine-native');
  fs.mkdirSync(path.join(dir, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'runtime', 'python.exe'), 'exe');
  fs.writeFileSync(path.join(dir, 'engine.json'), JSON.stringify({ version }));
  return dir;
}

test('the engine package inside the installer is found, an incomplete one is not', () => {
  const resources = tmp();
  assert.strictEqual(bundledPackage(resources), null);
  assert.strictEqual(bundledPackage(null), null);
  const dir = fakeBundle(resources);
  assert.strictEqual(bundledPackage(resources), dir);
  fs.rmSync(path.join(dir, 'runtime', 'python.exe'));
  assert.strictEqual(bundledPackage(resources), null, 'no python.exe: not usable');
});

test('with the package in the installer nothing is downloaded, and old downloaded copies are removed', async () => {
  const resources = tmp();
  const bundled = fakeBundle(resources, '9.9.9');
  const base = tmp();
  fs.mkdirSync(path.join(base, '2.1.2', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(base, 'StarkLLM-engine-v2.1.2-win-x64.zip.part'), 'half');
  fs.mkdirSync(path.join(base, 'pycache'));
  const f = fakeDeps();
  const logs = [];
  const dir = await ensurePackage('9.9.9', base, { deps: f.deps, env: {}, bundled, log: (l) => logs.push(l) });
  assert.strictEqual(dir, bundled);
  assert.deepStrictEqual(f.calls, [], 'no download, no unpacking');
  assert.ok(!fs.existsSync(path.join(base, '2.1.2')), 'the old unpacked copy is gone');
  assert.ok(!fs.existsSync(path.join(base, 'StarkLLM-engine-v2.1.2-win-x64.zip.part')), 'the unfinished download is gone');
  assert.ok(fs.existsSync(path.join(base, 'pycache')), 'the Python cache stays');
  assert.ok(logs.some((l) => /removed the downloaded engine copy/.test(l)));
});

test('a test package (STARKLLM_ENGINE_PACKAGE) still wins over the bundled one', async () => {
  const resources = tmp();
  const bundled = fakeBundle(resources, '9.9.9');
  const base = tmp();
  const f = fakeDeps();
  fs.writeFileSync(path.join(base, 'local.zip'), 'zip');
  const dir = await ensurePackage('9.9.9', base, { deps: f.deps, env: { STARKLLM_ENGINE_PACKAGE: path.join(base, 'local.zip') }, bundled });
  assert.notStrictEqual(dir, bundled);
});

test('removing downloaded copies leaves other things alone and copes with a missing folder', () => {
  removeDownloadedPackages(path.join(tmp(), 'does-not-exist'));
  const base = tmp();
  fs.mkdirSync(path.join(base, '2.0.16'));
  fs.writeFileSync(path.join(base, 'notes.txt'), 'x');
  removeDownloadedPackages(base);
  assert.deepStrictEqual(fs.readdirSync(base), ['notes.txt']);
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
  // owner decision 2026-11-16: no code runner without Docker's isolation
  assert.strictEqual(off.STARKLLM_CODE_RUNNER, 'off');
  assert.strictEqual(nativeEnv('C:\\pkg', { kbDir: 'C:\\kb', secret: 's', build: 'b', env: { STARKLLM_CODE_RUNNER: 'on' } }).STARKLLM_CODE_RUNNER, 'off', 'not even when set outside');
  assert.ok(!('STARKLLM_PYCACHE' in off));
  assert.strictEqual(nativeEnv('C:\\pkg', { kbDir: 'C:\\kb', secret: 's', build: 'b', pycache: 'C:\\cache', env: {} }).STARKLLM_PYCACHE, 'C:\\cache');
});
