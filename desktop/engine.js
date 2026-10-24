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

const OLLAMA_URL = 'http://127.0.0.1:11434';
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

function gb(bytes) {
  return (bytes / 1e9).toFixed(1);
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
            onStatus(`Downloading AI model ${name}: ${Math.floor((msg.completed / msg.total) * 100)} % (${gb(msg.completed)} of ${gb(msg.total)} GB)`);
          } else if (msg.status) onStatus(`AI model ${name}: ${msg.status}`);
        }
      });
      res.on('end', () => (failed || res.statusCode >= 400 ? reject(new Error(failed || `HTTP ${res.statusCode}`)) : resolve()));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ name, stream: true }));
  });
}

async function ensureOllama(onStatus, warnings) {
  onStatus('Checking Ollama (the local AI runtime)...');
  let models = await ollamaModels();
  if (models === null && IS_WIN && launchDetached(OLLAMA_APP)) {
    onStatus('Starting Ollama...');
    await waitFor(async () => (models = await ollamaModels()) !== null, 45000);
  }
  if (models === null) {
    log('Ollama not reachable');
    return false;
  }
  for (const name of [EMBEDDING_MODEL, TEXT_MODEL]) {
    if (hasModel(models, name)) continue;
    log(`pulling ${name}`);
    try {
      await pullModel(name, onStatus);
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
  if (!docker) return { ok: false, stage: 'docker-missing' };
  if (!(await dockerRunning(docker))) {
    if (IS_WIN && launchDetached(DOCKER_DESKTOP)) {
      status('Starting Docker Desktop (this can take a minute)...');
      if (!(await waitFor(() => dockerRunning(docker), 240000, 4000))) return { ok: false, stage: 'docker-stopped' };
    } else {
      return { ok: false, stage: 'docker-stopped' };
    }
  }

  const ollama = await ensureOllama(status, warnings);

  if ((await probe(appUrl)).ok) {
    status('StarkLLM is already running.');
    return { ok: true, ollama, warnings };
  }

  const compose = path.join(engineDir(), 'docker-compose.yml');
  if (!fs.existsSync(compose)) return { ok: false, stage: 'engine', detail: `Engine files are missing: ${compose}` };
  const env = {
    ...process.env,
    STARKLLM_DATA_DIR: paths.data,
    STARKLLM_KB_DIR: paths.kb,
    HOST_KB_PATH: paths.kb,
    SECRET_KEY: process.env.SECRET_KEY || secretKey(paths.secret)
  };
  status('Starting the StarkLLM engine. The first start downloads and builds its components (10-20 minutes, needs internet)...');
  let up = await run(docker, ['compose', '-p', PROJECT, '-f', compose, 'up', '-d', '--build'], {
    env,
    timeoutMs: 60 * 60 * 1000,
    onLine: (line) => onStatus('Engine: ' + line.slice(0, 140))
  });
  if (up.code !== 0 && up.lines.some((l) => l.includes('is already in use by container'))) {
    // Containers from an earlier installation (e.g. a source checkout) carry the same names: reuse them.
    status('Starting the existing StarkLLM containers...');
    up = await run(docker, ['start', ...CONTAINERS], { timeoutMs: 120000 });
  }
  up.lines.slice(-60).forEach((l) => log('compose: ' + l));
  if (up.code !== 0) return { ok: false, stage: 'engine', detail: 'The engine could not be started.', log: up.lines.slice(-20) };

  status('Waiting for StarkLLM to answer...');
  if (!(await waitFor(async () => (await probe(appUrl)).ok, 180000))) {
    const logs = await run(docker, ['compose', '-p', PROJECT, '-f', compose, 'logs', '--tail', '20'], { env, timeoutMs: 30000 });
    return { ok: false, stage: 'engine', detail: 'The engine started but the web UI does not answer.', log: logs.lines.slice(-20) };
  }
  status('Ready.');
  return { ok: true, ollama, warnings };
}

module.exports = { startEngine, userPaths, TEXT_MODEL, EMBEDDING_MODEL };
