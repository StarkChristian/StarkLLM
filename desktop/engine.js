// Starts everything StarkLLM needs before the window can show the app: Docker Desktop, Ollama with its models,
// and the engine containers (backend + web UI) from the docker-compose.yml shipped inside the app.
// Every step reports progress through onStatus(text) and is written to <userData>/engine.log.
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { probe } = require('./diagnostics');

const OLLAMA_URL = process.env.STARKLLM_OLLAMA_URL || 'http://127.0.0.1:11434';
const TEXT_MODEL = process.env.DEFAULT_TEXT_MODEL || 'qwen2.5:7b';
const EMBEDDING_MODEL = process.env.DEFAULT_EMBEDDING_MODEL || 'nomic-embed-text';
const PROJECT = 'starkllm';
const CONTAINERS = ['starkllm-backend', 'starkllm-frontend'];

const IS_WIN = process.platform === 'win32';
const PROGRAM_FILES = process.env.ProgramFiles || 'C:\\Program Files';
const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const DOCKER_FALLBACK = path.join(PROGRAM_FILES, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe');
const DOCKER_DESKTOP = path.join(PROGRAM_FILES, 'Docker', 'Docker', 'Docker Desktop.exe');
const OLLAMA_APP = path.join(LOCAL_APP_DATA, 'Programs', 'Ollama', 'ollama app.exe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function engineDir() {
  // Packaged: resources/engine (see "extraResources" in package.json). From source: the repository root.
  return app.isPackaged ? path.join(process.resourcesPath, 'engine') : path.join(__dirname, '..');
}

function userPaths() {
  const base = app.getPath('userData');
  const p = {
    log: path.join(base, 'engine.log'),
    data: path.join(base, 'data'),
    kb: path.join(app.getPath('documents'), 'StarkLLM Knowledge Base'),
    secret: path.join(base, 'secret.key')
  };
  fs.mkdirSync(p.data, { recursive: true });
  fs.mkdirSync(p.kb, { recursive: true });
  return p;
}

function log(line) {
  try {
    fs.appendFileSync(userPaths().log, `[${new Date().toISOString()}] ${line}\n`);
  } catch (e) {
    // logging must never stop the start
  }
}

function secretKey(file) {
  // The compose file's fallback key is public; every installation gets its own.
  try {
    const k = fs.readFileSync(file, 'utf8').trim();
    if (k.length >= 32) return k;
  } catch (e) {
    // first start
  }
  const k = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, k, { mode: 0o600 });
  return k;
}

// Runs a command, streams its output lines to onLine, resolves { code, lines } (never rejects).
function run(cmd, args, { env, timeoutMs = 60000, onLine } = {}) {
  return new Promise((resolve) => {
    const lines = [];
    let child;
    try {
      child = spawn(cmd, args, { env: env || process.env, windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, lines: [String(e.message)], enoent: e.code === 'ENOENT' });
    }
    const timer = setTimeout(() => {
      lines.push(`timed out after ${Math.round(timeoutMs / 1000)} s`);
      child.kill();
    }, timeoutMs);
    const feed = (buf) => {
      for (const raw of String(buf).split(/\r?\n|\r/)) {
        const line = raw.trim();
        if (!line) continue;
        lines.push(line);
        if (lines.length > 400) lines.shift();
        if (onLine) onLine(line);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, lines: [String(e.message)], enoent: e.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, lines });
    });
  });
}

// Something answering on the UI port is not enough: Vite dev servers use 5173 too.
async function isStarkLLM(appUrl) {
  const r = await probe(appUrl);
  return r.ok && r.body.includes('<title>StarkLLM</title>');
}

// Found on Windows (8 Nov 2026): after installing a new version the old engine kept running ("StarkLLM is already
// running"), so an update never reached the engine. The app now passes a fingerprint of its engine files to the
// backend, which reports it at /health; a running engine is reused only when the fingerprints match.
const API_URL = `http://127.0.0.1:${process.env.STARKLLM_API_PORT || 8000}`;
const BIG_FILE = 1024 * 1024; // large files (voice models) count by name and size only

function engineFingerprint(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) files.push(full);
    }
  };
  walk(dir);
  const hash = crypto.createHash('sha256');
  for (const f of files.map((f) => path.relative(dir, f).split(path.sep).join('/')).sort()) {
    const full = path.join(dir, f);
    const size = fs.statSync(full).size;
    hash.update(`${f}\0${size}\0`);
    if (size <= BIG_FILE) hash.update(fs.readFileSync(full));
  }
  return hash.digest('hex').slice(0, 16);
}

async function engineHealth() {
  const r = await probe(API_URL + '/health');
  if (!r.ok) return null;
  try {
    return JSON.parse(r.body);
  } catch (e) {
    return null;
  }
}

function engineIsCurrent(health, fingerprint) {
  return Boolean(health && health.build) && health.build === fingerprint;
}

async function waitFor(check, timeoutMs, intervalMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(intervalMs);
  }
  return false;
}

function launchDetached(file) {
  try {
    if (!fs.existsSync(file)) return false;
    spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return true;
  } catch (e) {
    log(`could not launch ${file}: ${e.message}`);
    return false;
  }
}

// Docker Desktop puts docker.exe on PATH, but a process started before the install does not see that PATH yet.
async function findDocker() {
  const r = await run('docker', ['--version'], { timeoutMs: 15000 });
  if (r.code === 0) return 'docker';
  if (IS_WIN && fs.existsSync(DOCKER_FALLBACK)) return DOCKER_FALLBACK;
  return null;
}

async function dockerRunning(docker) {
  return (await run(docker, ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 20000 })).code === 0;
}

// Docker Desktop can run Windows containers instead of Linux containers; StarkLLM's images are Linux images.
// Found on a GitHub Windows runner: the build then fails with "no matching manifest for windows(...)".
async function dockerOsType(docker) {
  const r = await run(docker, ['info', '--format', '{{.OSType}}'], { timeoutMs: 20000 });
  return r.code === 0 && r.lines.length ? r.lines[r.lines.length - 1].trim().toLowerCase() : '';
}

const WINDOWS_CONTAINERS = /no matching manifest for windows|image operating system "linux" cannot be used on this platform/i;

async function ollamaModels() {
  const r = await probe(OLLAMA_URL + '/api/tags');
  if (!r.ok) return null;
  try {
    return (JSON.parse(r.body).models || []).map((m) => m.name);
  } catch (e) {
    return [];
  }
}

function hasModel(available, name) {
  const norm = (n) => (n.includes(':') ? n : n + ':latest');
  return available.map(norm).includes(norm(name));
}

function size(bytes) {
  return bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' GB' : Math.max(1, Math.round(bytes / 1e6)) + ' MB';
}

// Streams Ollama's /api/pull and reports the download progress.
function pullModel(name, onStatus) {
  return new Promise((resolve, reject) => {
    const req = http.request(OLLAMA_URL + '/api/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      let failed = null;
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          let msg;
          try {
            msg = JSON.parse(line);
          } catch (e) {
            continue;
          }
          if (msg.error) failed = msg.error;
          else if (msg.total && msg.completed) {
            onStatus(`Downloading AI model ${name}: ${Math.floor((msg.completed / msg.total) * 100)} % (${size(msg.completed)} of ${size(msg.total)})`);
          } else if (msg.status) onStatus(`AI model ${name}: ${msg.status}`);
        }
      });
      let ended = false;
      res.on('end', () => {
        ended = true;
        failed || res.statusCode >= 400 ? reject(new Error(failed || `HTTP ${res.statusCode}`)) : resolve();
      });
      // A dropped connection ends the response without 'end'; without this the start would wait forever.
      res.on('close', () => {
        if (!ended) reject(new Error('the connection to Ollama was interrupted'));
      });
      res.on('error', () => {});
    });
    req.on('error', reject);
    // No data for 2 minutes: treat the download as stalled (it is resumed on the next attempt).
    req.setTimeout(120000, () => req.destroy(new Error('no progress for 2 minutes')));
    req.end(JSON.stringify({ name, stream: true }));
  });
}

// Ollama resumes a partial download, so a dropped connection costs little. A wrong model name is not retried.
const PULL_DELAYS_MS = [5000, 15000];

async function pullWithRetry(name, onStatus, { pull = pullModel, wait = sleep, delays = PULL_DELAYS_MS, log: write = log } = {}) {
  const attempts = delays.length + 1;
  for (let i = 1; ; i++) {
    try {
      await pull(name, onStatus);
      return;
    } catch (e) {
      const permanent = /does not exist|not found|manifest unknown|invalid model name/i.test(e.message);
      write(`pull ${name} attempt ${i} of ${attempts} failed: ${e.message}`);
      if (permanent || i >= attempts) throw e;
      const secs = Math.round(delays[i - 1] / 1000);
      onStatus(`Download of ${name} was interrupted (${e.message}). Trying again in ${secs} s (attempt ${i + 1} of ${attempts})...`);
      await wait(delays[i - 1]);
    }
  }
}

// status() also writes the log; progress() only updates the splash screen (download progress is too chatty for the log).
async function ensureOllama(status, progress, warnings) {
  status('Checking Ollama (the local AI runtime)...');
  let models = await ollamaModels();
  if (models === null && IS_WIN && launchDetached(OLLAMA_APP)) {
    status('Starting Ollama...');
    await waitFor(async () => (models = await ollamaModels()) !== null, 45000);
  }
  if (models === null) {
    log('Ollama not reachable');
    return false;
  }
  for (const name of [EMBEDDING_MODEL, TEXT_MODEL]) {
    if (hasModel(models, name)) continue;
    status(`Downloading AI model ${name}...`);
    try {
      await pullWithRetry(name, progress);
      log(`pulled ${name}`);
    } catch (e) {
      log(`pull ${name} failed: ${e.message}`);
      warnings.push(`The AI model ${name} could not be downloaded (${e.message}). Run "ollama pull ${name}" in a terminal.`);
    }
  }
  return true;
}

// Returns { ok, ollama, warnings } or { ok: false, stage, detail, log }.
async function startEngine(appUrl, onStatus) {
  const status = (text) => {
    log(text);
    onStatus(text);
  };
  const warnings = [];
  const paths = userPaths();
  log(`--- start, app ${app.getVersion()}, engine ${engineDir()}`);

  status('Checking Docker...');
  const docker = await findDocker();
  if (!docker) {
    log('Docker not found (not installed or not on PATH)');
    return { ok: false, stage: 'docker-missing' };
  }
  if (!(await dockerRunning(docker))) {
    if (IS_WIN && launchDetached(DOCKER_DESKTOP)) {
      status('Starting Docker Desktop (this can take a minute)...');
      if (!(await waitFor(() => dockerRunning(docker), 240000, 4000))) {
        log('Docker Desktop was started but its engine did not come up within 4 minutes');
        return { ok: false, stage: 'docker-stopped' };
      }
    } else {
      log('Docker is installed but its engine is not running');
      return { ok: false, stage: 'docker-stopped' };
    }
  }

  if ((await dockerOsType(docker)) === 'windows') {
    log('Docker runs Windows containers; StarkLLM needs Linux containers');
    return { ok: false, stage: 'docker-windows-containers' };
  }

  const ollama = await ensureOllama(status, onStatus, warnings);

  const compose = path.join(engineDir(), 'docker-compose.yml');
  if (!fs.existsSync(compose)) return { ok: false, stage: 'engine', detail: `Engine files are missing: ${compose}` };
  const fingerprint = engineFingerprint(engineDir());

  let updating = false;
  let reusedOther = false;
  if (await isStarkLLM(appUrl)) {
    const running = await engineHealth();
    if (engineIsCurrent(running, fingerprint)) {
      status('StarkLLM is already running.');
      return { ok: true, ollama, warnings };
    }
    log(`running engine ${(running && running.version) || 'unknown'} (build ${(running && running.build) || 'none'}), app ${app.getVersion()} (build ${fingerprint}): updating the engine`);
    updating = true;
  }
  const env = {
    ...process.env,
    STARKLLM_DATA_DIR: paths.data,
    STARKLLM_KB_DIR: paths.kb,
    HOST_KB_PATH: paths.kb,
    SECRET_KEY: process.env.SECRET_KEY || secretKey(paths.secret),
    STARKLLM_ENGINE_BUILD: fingerprint
  };
  status(updating
    ? `Updating the StarkLLM engine to version ${app.getVersion()} (a few minutes)...`
    : 'Starting the StarkLLM engine. The first start downloads and builds its components (10-20 minutes, needs internet)...');
  let up = await run(docker, ['compose', '-p', PROJECT, '-f', compose, 'up', '-d', '--build'], {
    env,
    timeoutMs: 60 * 60 * 1000,
    onLine: (line) => onStatus('Engine: ' + line.slice(0, 140))
  });
  if (up.code !== 0 && up.lines.some((l) => l.includes('is already in use by container'))) {
    // Containers from an earlier installation (e.g. a source checkout) carry the same names: reuse them.
    status('Starting the existing StarkLLM containers...');
    up = await run(docker, ['start', ...CONTAINERS], { timeoutMs: 120000 });
    reusedOther = true; // their version can differ from the app's
  }
  up.lines.slice(-60).forEach((l) => log('compose: ' + l));
  if (up.code !== 0 && up.lines.some((l) => WINDOWS_CONTAINERS.test(l))) {
    return { ok: false, stage: 'docker-windows-containers' };
  }
  if (up.code !== 0) {
    const portBusy = up.lines.some((l) => /address already in use|port is already allocated|ports are not available/i.test(l));
    const detail = portBusy
      ? `Another program on this PC already uses port ${process.env.STARKLLM_UI_PORT || 5173} or ${process.env.STARKLLM_API_PORT || 8000}. Close it and press Retry.`
      : 'The engine could not be started.';
    return { ok: false, stage: 'engine', detail, log: up.lines.slice(-8) };
  }

  status('Waiting for StarkLLM to answer...');
  // After an update the old containers can answer for a moment while compose replaces them.
  const answers = async () => (await isStarkLLM(appUrl)) && (reusedOther || engineIsCurrent(await engineHealth(), fingerprint));
  if (!(await waitFor(answers, 180000))) {
    const logs = await run(docker, ['compose', '-p', PROJECT, '-f', compose, 'logs', '--tail', '20'], { env, timeoutMs: 30000 });
    return { ok: false, stage: 'engine', detail: 'The engine started but the web UI does not answer.', log: logs.lines.slice(-20) };
  }
  status('Ready.');
  return { ok: true, ollama, warnings };
}

module.exports = { startEngine, userPaths, pullWithRetry, engineIsCurrent, engineFingerprint, TEXT_MODEL, EMBEDDING_MODEL };
