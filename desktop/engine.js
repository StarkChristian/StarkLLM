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
const { chooseModels } = require('./models');
const { createPullProgress, createModelProgress, throttle, formatBytes } = require('./progress');

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
function run(cmd, args, { env, cwd, timeoutMs = 60000, onLine } = {}) {
  return new Promise((resolve) => {
    const lines = [];
    let child;
    try {
      // stdin closed: an open, never-written pipe is not what a console run gives the Docker tools
      child = spawn(cmd, args, { env: env || process.env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
const FINGERPRINT_SKIP = new Set(['node_modules', '.git', 'dist', '__pycache__', '.pytest_cache', 'data', 'desktop', '.github', 'knowledge_base_data']);

function engineFingerprint(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        // From a source checkout the engine folder is the repository; only the engine's own files count.
        if (!FINGERPRINT_SKIP.has(e.name)) walk(full);
      }
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

// Found on a real Windows PC (8 Nov 2026, Docker Desktop, Compose v2 with Bake): started from the app, the build
// stopped at "load local bake definitions" / "failed to execute bake: exit status 1", while the same command in
// PowerShell worked. Without Bake the two images are built one by one with plain `docker build`.
const BAKE_FAILED = /failed to execute bake/i;

async function buildWithoutBake(docker, dir, env, onStatus) {
  for (const service of ['backend', 'frontend']) {
    // the tag compose expects: the published image name if one is set, else the default local name
    const tag = (env && env[`STARKLLM_${service.toUpperCase()}_IMAGE`]) || `${PROJECT}-${service}`;
    const r = await run(docker, ['build', '-t', tag, path.join(dir, service)], {
      env,
      cwd: dir,
      timeoutMs: 45 * 60 * 1000,
      onLine: (line) => onStatus(`Engine (${service}): ` + line.slice(0, 130))
    });
    if (r.code !== 0) return r;
  }
  return { code: 0, lines: [] };
}

// Published engine images (built by .github/workflows/engine-images.yml for every release). Only the installed app
// uses them: its engine files are those of the release. A run from source always builds.
// STARKLLM_PREBUILT=0 always builds; =1 also pulls when running from source (tests). STARKLLM_REGISTRY is for tests.
function engineImages(version, registry = process.env.STARKLLM_REGISTRY || 'ghcr.io/starkchristian') {
  return { backend: `${registry}/starkllm-backend:${version}`, frontend: `${registry}/starkllm-frontend:${version}` };
}
// Compressed layer sizes of a published image, keyed by the short layer id that `docker compose pull` prints,
// so the start screen can show real overall progress. Returns an empty map if the registry cannot be asked.
async function imageLayerSizes(image, { fetchImpl = fetch } = {}) {
  const sizes = new Map();
  try {
    const m = image.match(/^([^/]+)\/(.+):([^:]+)$/);
    if (!m) return sizes;
    const [, host, repo, tag] = m;
    const base = (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? 'http://' : 'https://') + host;
    const headers = { Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' };
    if (host === 'ghcr.io') {
      const t = await (await fetchImpl(`https://ghcr.io/token?scope=repository:${repo}:pull`, { signal: AbortSignal.timeout(10000) })).json();
      if (t.token) headers.Authorization = `Bearer ${t.token}`;
    }
    const get = async (ref) => (await fetchImpl(`${base}/v2/${repo}/manifests/${ref}`, { headers, signal: AbortSignal.timeout(10000) })).json();
    let manifest = await get(tag);
    if (manifest.manifests) {
      const amd = manifest.manifests.find((x) => x.platform && x.platform.os === 'linux' && x.platform.architecture === 'amd64');
      if (!amd) return sizes;
      manifest = await get(amd.digest);
    }
    for (const l of manifest.layers || []) sizes.set(String(l.digest).replace(/^sha256:/, '').slice(0, 12), l.size);
  } catch (e) {
    log(`layer sizes of ${image} unknown: ${e.message}`);
  }
  return sizes;
}

const usePrebuilt = () => process.env.STARKLLM_PREBUILT === '1' || (app.isPackaged && process.env.STARKLLM_PREBUILT !== '0');

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

function postJson(url, body, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const req = http.request(url.replace('//localhost:', '//127.0.0.1:'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', (c) => { if (buf.length < 1e6) buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { resolve(null); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(JSON.stringify(body));
  });
}

// Installed models with size, family and what they can do (chat, tools, vision, embedding).
async function ollamaDetails() {
  const r = await probe(OLLAMA_URL + '/api/tags');
  if (!r.ok) return null;
  let models = [];
  try {
    models = JSON.parse(r.body).models || [];
  } catch (e) {
    return [];
  }
  return Promise.all(models.map(async (m) => {
    const show = await postJson(OLLAMA_URL + '/api/show', { model: m.name });
    return {
      name: m.name,
      size: m.size || 0,
      family: (m.details && m.details.family) || '',
      parameterSize: (m.details && m.details.parameter_size) || '',
      capabilities: (show && show.capabilities) || [],
    };
  }));
}

// Total RAM, and the video memory of an NVIDIA card if nvidia-smi is there (0 otherwise).
async function hardware() {
  const hw = { ramBytes: os.totalmem(), vramBytes: 0 };
  const r = await run('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { timeoutMs: 8000 });
  if (r.code === 0) {
    const mib = Math.max(0, ...r.lines.map((l) => parseInt(l, 10)).filter(Number.isFinite));
    hw.vramBytes = mib * 1024 * 1024;
  }
  return hw;
}

// Documents were indexed before if the vector store has collections; their search model must then stay.
function hasIndex(dataDir) {
  try {
    return fs.readdirSync(path.join(dataDir, 'chroma'), { withFileTypes: true }).some((e) => e.isDirectory());
  } catch (e) {
    return false;
  }
}

const modelsFile = () => path.join(app.getPath('userData'), 'models.json');
function readSavedModels() {
  try {
    return JSON.parse(fs.readFileSync(modelsFile(), 'utf8'));
  } catch (e) {
    return null;
  }
}

// The models the engine uses; set by ensureOllama and passed to the backend through the environment.
let chosen = { text: TEXT_MODEL, embedding: EMBEDDING_MODEL, vision: process.env.DEFAULT_VISION_MODEL || 'llava' };
function useModels(m) {
  chosen = { text: m.text, embedding: m.embedding, vision: m.vision };
  process.env.DEFAULT_TEXT_MODEL = m.text;
  process.env.DEFAULT_EMBEDDING_MODEL = m.embedding;
  process.env.DEFAULT_VISION_MODEL = m.vision;
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
  const progress = createModelProgress();
  const show = throttle((text, f) => onStatus(text, f), 250);
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
          else if (progress.feed(msg)) {
            // one figure for the whole model (it arrives as a few small files and one large one)
            const t = progress.totals();
            show(`Downloading AI model ${name}: ${Math.floor((t.completed / t.total) * 100)} % (${size(t.completed)} of ${size(t.total)})`, t.completed / t.total);
          } else if (msg.status) show(`AI model ${name}: ${msg.status}`);
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
    const saved = readSavedModels();
    if (saved) useModels(saved);
    return false;
  }
  status('Looking at the AI models on this PC...');
  const installed = (await ollamaDetails()) || [];
  const hw = await hardware();
  const choice = chooseModels({ installed, hw, saved: readSavedModels(), existingIndex: hasIndex(userPaths().data) });
  log(`models: ${installed.length} installed; RAM ${size(hw.ramBytes)}, video memory ${hw.vramBytes ? size(hw.vramBytes) : 'unknown'}`);
  choice.notes.forEach((n) => log('models: ' + n));
  log(`models: chat ${choice.text}, search ${choice.embedding}, images ${choice.vision}; downloading: ${choice.pull.join(', ') || 'nothing'}`);
  useModels(choice);
  try {
    fs.writeFileSync(modelsFile(), JSON.stringify({ text: choice.text, embedding: choice.embedding, vision: choice.vision }, null, 2));
  } catch (e) {
    log('could not save the model choice: ' + e.message);
  }
  if (!choice.pull.length) status(`Using ${choice.text} (already installed)`);
  for (const name of choice.pull) {
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

// Going back to the previous engine when an updated engine does not start (roadmap phase 1).
// Before the update the images of the running engine get a "rollback" tag, so they stay on the PC even when the new
// engine replaces the "starkllm-backend" image or uses other images. If the new engine does not start or does not
// answer, StarkLLM starts the tagged images again. The failed build is remembered for a day, so StarkLLM does not
// spend several minutes on the same failing update at every start.
const ROLLBACK_RETRY_MS = 24 * 60 * 60 * 1000;
const ENGINE_ANSWER_MS = Number(process.env.STARKLLM_ENGINE_ANSWER_MS) || 180000;

function rollbackFile() {
  return path.join(app.getPath('userData'), 'engine-rollback.json');
}

function readRollback(file = rollbackFile()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function forgetFailedUpdate() {
  try {
    fs.rmSync(rollbackFile(), { force: true });
  } catch (e) {
    log('could not remove ' + rollbackFile() + ': ' + e.message);
  }
}

// true: the update to this build failed less than a day ago and the previous engine is still running
function skipFailedUpdate(state, fingerprint, runningBuild, now = Date.now()) {
  return Boolean(state && state.failedBuild === fingerprint && state.previousBuild && state.previousBuild === runningBuild
    && now - state.at < ROLLBACK_RETRY_MS);
}

async function keepRollbackImages(docker, runningBuild, { runCmd = run } = {}) {
  const images = {};
  for (const service of ['backend', 'frontend']) {
    const r = await runCmd(docker, ['inspect', '-f', '{{.Image}}', `${PROJECT}-${service}`], { timeoutMs: 20000 });
    const id = r.code === 0 && r.lines.length ? r.lines[r.lines.length - 1].trim() : '';
    if (!id) return null;
    const tag = `${PROJECT}-${service}:rollback`;
    if ((await runCmd(docker, ['tag', id, tag], { timeoutMs: 20000 })).code !== 0) return null;
    images[service] = tag;
  }
  return { ...images, build: runningBuild || '' };
}

function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

async function rollbackEngine({ docker, compose, env, previous, answers, runCmd = run, wait = waitFor, cwd = engineDir() }) {
  const back = { ...env, STARKLLM_BACKEND_IMAGE: previous.backend, STARKLLM_FRONTEND_IMAGE: previous.frontend, STARKLLM_ENGINE_BUILD: previous.build };
  const up = await runCmd(docker, ['compose', '-p', PROJECT, '-f', compose, 'up', '-d', '--no-build'], { env: back, cwd, timeoutMs: 10 * 60 * 1000 });
  up.lines.slice(-20).forEach((l) => log('compose (previous engine): ' + l));
  return up.code === 0 && (await wait(answers, 180000));
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
  // The chosen models are part of the build: another model needs a recreated backend (its settings change).
  const fingerprint = crypto.createHash('sha256').update(engineFingerprint(engineDir()) + JSON.stringify(chosen)).digest('hex').slice(0, 16);

  let updating = false;
  let reusedOther = false;
  let previous = null;
  if (await isStarkLLM(appUrl)) {
    const running = await engineHealth();
    if (engineIsCurrent(running, fingerprint)) {
      status('StarkLLM is already running.');
      return { ok: true, ollama, warnings };
    }
    if (skipFailedUpdate(readRollback(), fingerprint, running && running.build)) {
      log(`the update to engine build ${fingerprint} failed less than a day ago; using the previous engine`);
      warnings.push({ title: 'Still using the previous engine', detail: `The engine of StarkLLM ${app.getVersion()} did not start on this PC, so StarkLLM uses the previous engine. It tries the new engine again tomorrow. The details are in ${paths.log}.` });
      return { ok: true, ollama, warnings };
    }
    log(`running engine ${(running && running.version) || 'unknown'} (build ${(running && running.build) || 'none'}), app ${app.getVersion()} (build ${fingerprint}): updating the engine`);
    updating = true;
    previous = await keepRollbackImages(docker, running && running.build);
    log(previous ? `kept the previous engine as ${previous.backend} and ${previous.frontend}` : 'could not keep the previous engine images');
  }
  const env = {
    ...process.env,
    STARKLLM_DATA_DIR: paths.data,
    STARKLLM_KB_DIR: paths.kb,
    HOST_KB_PATH: paths.kb,
    SECRET_KEY: process.env.SECRET_KEY || secretKey(paths.secret),
    STARKLLM_ENGINE_BUILD: fingerprint,
    // without it the container runs on UTC, and around midnight "today" in answers and on the home page is a day off
    STARKLLM_TZ: process.env.STARKLLM_TZ || localTimeZone()
  };
  let up = null;
  if (usePrebuilt()) {
    const images = engineImages(app.getVersion());
    env.STARKLLM_BACKEND_IMAGE = images.backend;
    env.STARKLLM_FRONTEND_IMAGE = images.frontend;
    const label = updating ? `Downloading the StarkLLM engine ${app.getVersion()}` : 'Downloading the StarkLLM engine';
    status(label + '...');
    const sizes = new Map([...(await imageLayerSizes(images.backend)), ...(await imageLayerSizes(images.frontend))]);
    const progress = createPullProgress(sizes);
    if (sizes.size) log(`engine download: ${sizes.size} layers, ${formatBytes(progress.total())}`);
    const show = throttle(() => onStatus(progress.text(label), progress.fraction()), 250);
    const pulled = await run(docker, ['compose', '-p', PROJECT, '-f', compose, 'pull'], {
      env,
      cwd: engineDir(),
      timeoutMs: 45 * 60 * 1000,
      onLine: (line) => { if (progress.feed(line)) show(); }
    });
    if (pulled.code === 0) {
      log(`pulled ${images.backend} and ${images.frontend}`);
      up = await run(docker, ['compose', '-p', PROJECT, '-f', compose, 'up', '-d', '--no-build'], { env, cwd: engineDir(), timeoutMs: 10 * 60 * 1000 });
    } else {
      pulled.lines.slice(-8).forEach((l) => log('compose pull: ' + l));
      log('the published engine could not be downloaded; building it on this PC instead');
    }
  }
  if (!up) {
    status(updating
      ? `Updating the StarkLLM engine to version ${app.getVersion()} (a few minutes)...`
      : 'Starting the StarkLLM engine. The first start downloads and builds its components (10-20 minutes, needs internet)...');
    up = await run(docker, ['compose', '-p', PROJECT, '-f', compose, 'up', '-d', '--build'], {
      env,
      cwd: engineDir(),
      timeoutMs: 60 * 60 * 1000,
      onLine: (line) => onStatus('Engine: ' + line.slice(0, 140))
    });
  }
  if (up.code !== 0 && up.lines.some((l) => BAKE_FAILED.test(l))) {
    up.lines.slice(-20).forEach((l) => log('compose (bake): ' + l));
    status('Building the engine without Docker Bake...');
    const built = await buildWithoutBake(docker, engineDir(), env, onStatus);
    up = built.code !== 0
      ? built
      : await run(docker, ['compose', '-p', PROJECT, '-f', compose, 'up', '-d', '--no-build'], { env, cwd: engineDir(), timeoutMs: 10 * 60 * 1000 });
  }
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
  const goBack = async (reason) => {
    if (!previous) return false;
    status('The new engine did not start; going back to the previous engine...');
    const ok = await rollbackEngine({ docker, compose, env, previous, answers: () => isStarkLLM(appUrl) });
    log(ok ? `went back to the previous engine (${reason})` : 'the previous engine did not start either');
    if (!ok) return false;
    try {
      fs.writeFileSync(rollbackFile(), JSON.stringify({ failedBuild: fingerprint, previousBuild: previous.build, at: Date.now(), reason }));
    } catch (e) {
      log('could not write ' + rollbackFile() + ': ' + e.message);
    }
    warnings.push({ title: 'Went back to the previous engine', detail: `The engine of StarkLLM ${app.getVersion()} did not start (${reason}), so StarkLLM started the previous engine again. Your chats and documents are unchanged. It tries the new engine again tomorrow. The details are in ${paths.log}.` });
    return true;
  };
  if (up.code !== 0 && !up.lines.some((l) => /address already in use|port is already allocated|ports are not available/i.test(l)) && (await goBack('it could not be started'))) {
    return { ok: true, ollama, warnings };
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
  if (!(await waitFor(answers, ENGINE_ANSWER_MS))) {
    const logs = await run(docker, ['compose', '-p', PROJECT, '-f', compose, 'logs', '--tail', '20'], { env, timeoutMs: 30000 });
    logs.lines.forEach((l) => log('engine: ' + l));
    if (await goBack(`it did not answer within ${Math.round(ENGINE_ANSWER_MS / 60000)} minutes`)) return { ok: true, ollama, warnings };
    return { ok: false, stage: 'engine', detail: 'The engine started but the web UI does not answer.', log: logs.lines.slice(-20) };
  }
  if (updating) forgetFailedUpdate();
  status('Ready.');
  return { ok: true, ollama, warnings };
}

module.exports = { forgetFailedUpdate, skipFailedUpdate, keepRollbackImages, rollbackEngine, imageLayerSizes, engineImages, secretKey, startEngine, userPaths, pullWithRetry, buildWithoutBake, run, engineIsCurrent, engineFingerprint, TEXT_MODEL, EMBEDDING_MODEL };
