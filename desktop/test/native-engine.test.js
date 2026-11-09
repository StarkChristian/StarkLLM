// Roadmap phase 2: StarkLLM without Docker Desktop. The engine package is downloaded, checked, unpacked and started.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { packageName, packageUrl, engineMode, parseSha256, ensurePackage, nativeEnv } = require('../native-engine');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'native-engine-'));
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

// stand-ins: "download" writes a known zip text (or the checksum file), "unzip" lays out a package
function fakeDeps({ zipText = 'zip-bytes', shaText, unzipOk = true } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      tmpdir: os.tmpdir,
      download: async (url, target, onProgress = () => {}) => {
        calls.push(url);
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
