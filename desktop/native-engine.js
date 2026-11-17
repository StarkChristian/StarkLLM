// StarkLLM without Docker Desktop (roadmap phase 1; the default on Windows since 2.2).
// The engine package (StarkLLM-engine-v<version>-win-x64.zip, built by .github/workflows/native-engine-package.yml and
// attached to every release) holds its own Python, the backend and the built web UI. The installer carries it unpacked
// (resources\engine-native). Builds without it download the package of their version once, check its SHA-256, unpack
// it with tar.exe (part of Windows) and start the engine from it. The download is announced to the network layer (netguard.js, feature
// engine_download) like the Docker image pull: listed in Settings > Privacy, and refused while "fully offline" is on. The engine serves the web UI and the API on one port and keeps its data in
// %APPDATA%\StarkLLM\data, the same folder the Docker engine uses, so chats and documents are the same in both.
// No Electron here, so the tests can use it directly.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');
const { download } = require('./ollama-install');
const { formatBytes } = require('./progress');
const { getShared } = require('./netguard');
const { t } = require('./i18n');

const RELEASES = process.env.STARKLLM_RELEASES_URL || 'https://github.com/StarkChristian/StarkLLM/releases/download';

function packageName(version) {
  return `StarkLLM-engine-v${version}-win-x64.zip`;
}

function packageUrl(version) {
  return `${RELEASES}/v${version}/${packageName(version)}`;
}

// "native": use the engine package. Since 2.2 (owner decision 2026-11-16) it is the default on Windows for everyone, new
// and existing installs, with or without Docker Desktop; Docker is an advanced choice (tray menu, saved as "engine" in
// settings.json). STARKLLM_ENGINE=native/docker overrides both. Other systems keep Docker: the package is for Windows.
function engineMode({ env = process.env, platform = process.platform, choice = null } = {}) {
  if (env.STARKLLM_ENGINE === 'native' || env.STARKLLM_ENGINE === 'docker') return env.STARKLLM_ENGINE;
  if (platform !== 'win32') return 'docker';
  return choice === 'docker' ? 'docker' : 'native';
}

// The engine choice lives in the app's settings.json (the same file as the update setting), key "engine".
function readEngineChoice(settingsFile) {
  try {
    const v = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).engine;
    return v === 'docker' || v === 'native' ? v : null;
  } catch (e) {
    return null;
  }
}

function writeEngineChoice(settingsFile, choice) {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) || {}; } catch (e) { /* new file */ }
  s.engine = choice === 'docker' ? 'docker' : 'native';
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify(s, null, 2));
  return s.engine;
}

// The installer ships the unpacked engine package in resources\engine-native (built by native-engine-package.yml in
// the release pipeline), so the engine works right after the install, without a download. Returns that folder or null
// (development builds and builds without the package: then the package is downloaded as before).
function bundledPackage(resourcesPath) {
  if (!resourcesPath) return null;
  const dir = path.join(resourcesPath, 'engine-native');
  return fs.existsSync(path.join(dir, 'engine.json')) && fs.existsSync(path.join(dir, 'runtime', 'python.exe')) ? dir : null;
}

function packageVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'engine.json'), 'utf8')).version || null;
  } catch (e) {
    return null;
  }
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

function readText(url, deps, onHop) {
  const tmp = path.join(deps.tmpdir(), `starkllm-${process.pid}-${Date.now()}.sha256`);
  return deps.download(url, tmp, undefined, 5, onHop).then(() => {
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
async function ensurePackage(version, baseDir, { onStatus = () => {}, log = () => {}, env = process.env, deps = {}, bundled = null } = {}) {
  const d = { download, unzip, sha256File, tmpdir: require('os').tmpdir, ...deps };
  const guard = d.guard || getShared();
  // the package inside the installer: nothing to download or unpack. Copies downloaded by older versions are removed.
  if (bundled && !env.STARKLLM_ENGINE_PACKAGE) {
    const v = packageVersion(bundled);
    if (v !== version) log(`note: the bundled engine package is version ${v}, the app ${version}`);
    removeDownloadedPackages(baseDir, log);
    return bundled;
  }
  const dir = path.join(baseDir, version);
  if (fs.existsSync(path.join(dir, 'engine.json')) && fs.existsSync(path.join(dir, 'runtime', 'python.exe'))) return dir;

  fs.mkdirSync(baseDir, { recursive: true });
  let zip = env.STARKLLM_ENGINE_PACKAGE;
  let fromDownload = false;
  if (!zip) {
    zip = path.join(baseDir, packageName(version) + '.part');
    const url = packageUrl(version);
    log(`downloading the engine package ${url}`);
    // recorded in the network list, and refused (OfflineError, before anything is sent) while fully offline
    const purpose = `Download of the StarkLLM engine ${version} (engine package without Docker)`;
    const onHop = (next) => {
      try {
        guard.begin('engine_download', next, purpose + ' (redirect)').finish({});
      } catch (e) {
        // the switch was turned on during the download: the next start refuses; this callback must not throw
      }
    };
    const sum = guard.begin('engine_download', url + '.sha256', purpose);
    let expected;
    try {
      expected = parseSha256(await readText(url + '.sha256', d, onHop));
      sum.finish({ status: 200 });
    } catch (e) {
      sum.fail(e);
      throw e;
    }
    if (!expected) throw new Error('the checksum of the engine package could not be read');
    onStatus(t('Downloading the StarkLLM engine...'), null);
    const dl = guard.begin('engine_download', url, purpose);
    try {
      const got = await d.download(url, zip, (done, total) => {
        if (total) onStatus(t('Downloading the StarkLLM engine: {percent} % ({done} of {total})', { percent: Math.floor((done / total) * 100), done: formatBytes(done), total: formatBytes(total) }), done / total);
      }, 5, onHop);
      dl.finish({ status: 200, bytesIn: (got && got.bytes) || null });
    } catch (e) {
      dl.fail(e);
      throw e;
    }
    const actual = await d.sha256File(zip);
    if (actual !== expected) {
      fs.rmSync(zip, { force: true });
      throw new Error('the downloaded engine package is damaged (wrong checksum); please try again');
    }
    fromDownload = true;
  }

  onStatus(t('Unpacking the StarkLLM engine (about a minute)...'), null);
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

// Unpacked packages downloaded by versions before the installer carried one (about 870 MB each). Only version folders
// and unfinished downloads are removed; the folder also holds the Python cache (pycache), which stays.
function removeDownloadedPackages(baseDir, log = () => {}) {
  let entries = [];
  try { entries = fs.readdirSync(baseDir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    const p = path.join(baseDir, e.name);
    const isVersion = e.isDirectory() && /^\d+\.\d+\.\d+/.test(e.name);
    const isPart = e.isFile() && /^StarkLLM-engine-v.+\.zip(\.part)?$/.test(e.name);
    if (isVersion || isPart) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
        log(`removed the downloaded engine copy ${p} (the installer carries the engine now)`);
      } catch (err) {
        log(`could not remove ${p}: ${err.message}`);
      }
    }
  }
}

// The same settings docker-compose.yml gives the Docker engine (except TZ: see engine.js startNativeEngine).
// Two differences on purpose:
// - STARKLLM_CODE_RUNNER=off: the chat's "Run" button for Python needs the isolation of the Docker container. Without
//   Docker it is off until a real sandbox exists (owner decision 2026-11-16).
// - STARKLLM_PYCACHE: Python's cache goes to the user's folder, never into the installed (signed) program folder
//   (serve_native.py sets sys.pycache_prefix: the package's python311._pth makes Python ignore PYTHON* variables).
function nativeEnv(dir, { kbDir, secret, build, models = {}, ollamaUrl, offline = false, kbSync = '', pycache = null, env = process.env }) {
  const extra = pycache ? { STARKLLM_PYCACHE: pycache } : {};
  return {
    ...env,
    ...extra,
    STARKLLM_CODE_RUNNER: 'off',
    STARKLLM_STATIC_DIR: path.join(dir, 'ui'),
    KB_DATA_DIR: kbDir,
    HOST_KB_PATH: kbDir,
    OLLAMA_BASE_URL: ollamaUrl,
    SECRET_KEY: secret,
    STARKLLM_ENGINE_BUILD: build,
    // the "fully offline" switch: the engine starts with it on and refuses every connection except to this PC
    STARKLLM_OFFLINE: offline ? '1' : '',
    STARKLLM_KB_SYNC: kbSync || '',
    DEFAULT_TEXT_MODEL: models.text || env.DEFAULT_TEXT_MODEL || 'qwen2.5:7b',
    DEFAULT_VISION_MODEL: models.vision || env.DEFAULT_VISION_MODEL || 'llava',
    DEFAULT_EMBEDDING_MODEL: models.embedding || env.DEFAULT_EMBEDDING_MODEL || 'nomic-embed-text',
    HF_HUB_DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
    ANONYMIZED_TELEMETRY: 'False',
    RAGAS_DO_NOT_TRACK: 'true',
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8'
  };
}

let engineProcess = null;

// Every start writes this line first, so the log shows when each run began (and an old error is not read as new).
const START_MARKER = '--- engine start ';

// The lines of the last start only (the whole text if there is no marker yet).
function lastRun(lines) {
  const all = [].concat(lines || []);
  let i = all.length - 1;
  while (i >= 0 && !String(all[i]).startsWith(START_MARKER)) i--;
  return i >= 0 ? all.slice(i + 1) : all;
}

// Starts serve_native.py from the package; the engine's output goes to engine-native.log in the user folder.
function startNative(dir, { port, userDir, env, logFile, spawnImpl = spawn }) {
  const out = fs.openSync(logFile, 'a');
  try { fs.writeSync(out, `${START_MARKER}${new Date().toISOString()} (port ${port})\n`); } catch (e) { /* log not writable */ }
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
// On Windows it waits for taskkill: the installer of an update replaces resources\engine-native and cannot overwrite
// a python.exe that is still running.
function stopNative() {
  const child = engineProcess;
  engineProcess = null;
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 15000, stdio: 'ignore' });
    } catch (e) {
      // already gone, or taskkill timed out: nothing more to do here
    }
  } else child.kill();
}

// What the engine's log says about a failed start. Windows refuses to load a program file it does not trust
// (Smart App Control, or another application control rule): Python then reports
//   ImportError: DLL load failed while importing _ext: An Application Control policy has blocked this file.
// in the language of Windows. Returns the blocked package and module ("ctranslate2 / _ext"), or null.
const APP_CONTROL = /Anwendungssteuerungsrichtlinie|Application Control policy|application control|WinError 4551/i;
function blockedFile(lines) {
  const text = [].concat(lines || []);
  const hit = text.findIndex((l) => APP_CONTROL.test(l));
  if (hit < 0) return null;
  const mod = (text[hit].match(/importing (\S+?):/) || [])[1];
  let pkg = null;
  for (let i = hit; i >= 0 && !pkg; i--) {
    const m = text[i].match(/site-packages[\\/]([^\\/"]+)[\\/]/);
    if (m) pkg = m[1];
  }
  return [pkg, mod].filter(Boolean).join(' / ') || 'unknown file';
}

module.exports = { START_MARKER, lastRun, blockedFile, packageName, packageUrl, engineMode, readEngineChoice, writeEngineChoice, bundledPackage, packageVersion, removeDownloadedPackages, parseSha256, ensurePackage, nativeEnv, startNative, stopNative, sha256File };
