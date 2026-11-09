// StarkLLM without Docker Desktop (roadmap phase 2).
// The engine package (StarkLLM-engine-v<version>-win-x64.zip, built by .github/workflows/native-engine-package.yml and
// attached to every release) holds its own Python, the backend and the built web UI. When Docker Desktop is not
// installed, the app downloads the package of its version once, checks its SHA-256, unpacks it with tar.exe (part of
// Windows) and starts the engine from it. The engine serves the web UI and the API on one port and keeps its data in
// %APPDATA%\StarkLLM\data, the same folder the Docker engine uses, so chats and documents are the same in both.
// No Electron here, so the tests can use it directly.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { download } = require('./ollama-install');
const { formatBytes } = require('./progress');

const RELEASES = process.env.STARKLLM_RELEASES_URL || 'https://github.com/StarkChristian/StarkLLM/releases/download';

function packageName(version) {
  return `StarkLLM-engine-v${version}-win-x64.zip`;
}

function packageUrl(version) {
  return `${RELEASES}/v${version}/${packageName(version)}`;
}

// "native": use the engine package. STARKLLM_ENGINE=native/docker chooses; else native only on Windows without Docker.
function engineMode({ env = process.env, platform = process.platform, dockerFound }) {
  if (env.STARKLLM_ENGINE === 'native' || env.STARKLLM_ENGINE === 'docker') return env.STARKLLM_ENGINE;
  return platform === 'win32' && !dockerFound ? 'native' : 'docker';
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => hash.update(d)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

// "<hex>  <name>" (sha256sum format) -> hex
function parseSha256(text) {
  const m = /^\s*([0-9a-fA-F]{64})\b/.exec(String(text || ''));
  return m ? m[1].toLowerCase() : null;
}

function readText(url, deps) {
  const tmp = path.join(deps.tmpdir(), `starkllm-${process.pid}-${Date.now()}.sha256`);
  return deps.download(url, tmp).then(() => {
    const text = fs.readFileSync(tmp, 'utf8');
    fs.rmSync(tmp, { force: true });
    return text;
  });
}

function unzip(zip, dir) {
  return new Promise((resolve, reject) => {
    execFile('tar.exe', ['-xf', zip, '-C', dir], { windowsHide: true, timeout: 20 * 60 * 1000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`could not unpack the engine (${String(stderr).trim() || err.message})`));
      else resolve();
    });
  });
}

/**
 * Makes sure the engine package of `version` is unpacked under `baseDir` and returns its folder.
 * A local zip (STARKLLM_ENGINE_PACKAGE, for tests) is used instead of the download.
 * onStatus(text, fraction) shows the progress on the start screen.
 */
async function ensurePackage(version, baseDir, { onStatus = () => {}, log = () => {}, env = process.env, deps = {} } = {}) {
  const d = { download, unzip, sha256File, tmpdir: require('os').tmpdir, ...deps };
  const dir = path.join(baseDir, version);
  if (fs.existsSync(path.join(dir, 'engine.json')) && fs.existsSync(path.join(dir, 'runtime', 'python.exe'))) return dir;

  fs.mkdirSync(baseDir, { recursive: true });
  let zip = env.STARKLLM_ENGINE_PACKAGE;
  let fromDownload = false;
  if (!zip) {
    zip = path.join(baseDir, packageName(version) + '.part');
    const url = packageUrl(version);
    log(`downloading the engine package ${url}`);
    const expected = parseSha256(await readText(url + '.sha256', d));
    if (!expected) throw new Error('the checksum of the engine package could not be read');
    onStatus('Downloading the StarkLLM engine...', null);
    await d.download(url, zip, (done, total) => {
      if (total) onStatus(`Downloading the StarkLLM engine: ${Math.floor((done / total) * 100)} % (${formatBytes(done)} of ${formatBytes(total)})`, done / total);
    });
    const actual = await d.sha256File(zip);
    if (actual !== expected) {
      fs.rmSync(zip, { force: true });
      throw new Error('the downloaded engine package is damaged (wrong checksum); please try again');
    }
    fromDownload = true;
  }

  onStatus('Unpacking the StarkLLM engine (about a minute)...', null);
  const tmp = dir + '.unpacking';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  await d.unzip(zip, tmp);
  if (!fs.existsSync(path.join(tmp, 'engine.json'))) throw new Error('the engine package is incomplete (engine.json is missing)');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  if (fromDownload) fs.rmSync(zip, { force: true });
  // older versions are not needed any more
  for (const e of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== version) fs.rmSync(path.join(baseDir, e.name), { recursive: true, force: true });
  }
  log(`engine package ${version} unpacked to ${dir}`);
  return dir;
}

function nativeEnv(dir, { kbDir, secret, build, models = {}, ollamaUrl, env = process.env }) {
  return {
    ...env,
    STARKLLM_STATIC_DIR: path.join(dir, 'ui'),
    KB_DATA_DIR: kbDir,
    HOST_KB_PATH: kbDir,
    OLLAMA_BASE_URL: ollamaUrl,
    SECRET_KEY: secret,
    STARKLLM_ENGINE_BUILD: build,
    DEFAULT_TEXT_MODEL: models.text || env.DEFAULT_TEXT_MODEL || 'qwen2.5:7b',
    DEFAULT_VISION_MODEL: models.vision || env.DEFAULT_VISION_MODEL || 'llava',
    DEFAULT_EMBEDDING_MODEL: models.embedding || env.DEFAULT_EMBEDDING_MODEL || 'nomic-embed-text',
    HF_HUB_DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
    ANONYMIZED_TELEMETRY: 'False',
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8'
  };
}

let engineProcess = null;

// Starts serve_native.py from the package; the engine's output goes to engine-native.log in the user folder.
function startNative(dir, { port, userDir, env, logFile, spawnImpl = spawn }) {
  const out = fs.openSync(logFile, 'a');
  const child = spawnImpl(path.join(dir, 'runtime', 'python.exe'), [path.join(dir, 'backend', 'serve_native.py'), '--port', String(port)], {
    cwd: userDir,
    env,
    windowsHide: true,
    stdio: ['ignore', out, out]
  });
  engineProcess = child;
  child.on('exit', () => {
    if (engineProcess === child) engineProcess = null;
    try { fs.closeSync(out); } catch (e) { /* already closed */ }
  });
  return child;
}

// The engine runs as a child of the app: it stops when StarkLLM quits (and before an update replaces the files).
function stopNative() {
  const child = engineProcess;
  engineProcess = null;
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {});
  else child.kill();
}

module.exports = { packageName, packageUrl, engineMode, parseSha256, ensurePackage, nativeEnv, startNative, stopNative, sha256File };
