// Starts everything StarkLLM needs before the window can show the app: Docker Desktop, Ollama with its models,
// and the engine containers (backend + web UI) from the docker-compose.yml shipped inside the app.
// Every step reports progress through onStatus(text) and is written to <userData>/engine.log.
const { app } = require('electron');
const { cloudSync } = require('./cloud-folder');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { probe } = require('./diagnostics');
const { t, format } = require('./i18n');
const { getShared, FEATURES: NET_FEATURES } = require('./netguard');
const { chooseModels } = require('./models');
const integratedGpu = require('./igpu');
const hardwareInfo = require('./hardware');
const modelTiers = require('./model-tiers');
const { createPullProgress, createModelProgress, createSpeedMeter, durationParts, throttle, formatBytes } = require('./progress');
const native = require('./native-engine');

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
// Without Docker the engine serves the API and the web UI on one port (the app's); set when it starts.
let nativeApiUrl = null;
function apiUrl() {
  return nativeApiUrl || API_URL;
}
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
  const r = await probe(apiUrl() + '/health');
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
      onLine: (line) => onStatus(t('Engine ({service}): ', { service }) + line.slice(0, 130))
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
async function imageLayerSizes(image, { fetchImpl = (u, o) => getShared().wrapFetch(fetch, 'engine_download', NET_FEATURES.engine_download)(u, o) } = {}) {
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

// The hardware of this PC (hardware.js): memory, graphics cards (NVIDIA through nvidia-smi, AMD and Intel from the
// registry, integrated graphics Ollama uses with their share of the memory), processor and free disk space. Written to
// <data>/hardware.json for the model picker of the engine, which cannot see the graphics card from Docker.
async function hardware(integrated = null) {
  const hw = await hardwareInfo.detectHardware({ run, integrated });
  try {
    hardwareInfo.writeHardwareFile(userPaths().data, hw);
  } catch (e) {
    log('could not save the hardware of this PC: ' + e.message);
  }
  const cards = hw.gpus.map((g) => `${g.name} (${g.kind}, ${g.vram_total ? size(g.vram_total) : 'shared memory'})`).join('; ');
  log(`hardware: ${hw.cpu.name || 'processor'} (${hw.cpu.cores} threads), RAM ${size(hw.ram_total)} (${size(hw.ram_free)} free), graphics: ${cards || 'none found'}, free disk for models: ${hw.disk_free == null ? 'unknown' : size(hw.disk_free)}`);
  return hw;
}

// "about 3 min" for the download time left
function duration(seconds) {
  const d = durationParts(seconds);
  if (d.key === '{n} s') return t('{n} s', d.values);
  if (d.key === '{n} min') return t('{n} min', d.values);
  return t('{h} h {m} min', d.values);
}

// The one sentence that explains the model chosen at the first start, by hardware tier (model_tiers.json).
function whyThisModel(tier, model, hw) {
  const card = modelTiers.graphicsCard(hw);
  const vram = card ? `${Math.round(card.vram_total / 1024 ** 3)} GB` : ''; // video memory as the card is sold: 12 GB
  if (tier.kind === 'gpu' && tier.gpu_gb >= 20) return t('StarkLLM chose {model} because your graphics card with {vram} holds a larger model, which gives more careful answers.', { model, vram });
  if (tier.kind === 'gpu') return t('StarkLLM chose {model} because it fits completely in the {vram} of your graphics card and answers quickly.', { model, vram });
  return t('StarkLLM chose {model}, a small model that answers quickly on the processor, because this PC has no graphics card of its own for AI.', { model });
}

// Ollama's own log (the per-user install writes it to %LOCALAPPDATA%\Ollama\server.log): the last 512 KB
function ollamaServerLog() {
  const file = path.join(LOCAL_APP_DATA, 'Ollama', 'server.log');
  try {
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (e) {
    return '';
  }
}

// How many models Ollama has loaded right now (unknown counts as one: then nothing is restarted)
async function ollamaLoadedCount() {
  const r = await probe(OLLAMA_URL + '/api/ps');
  if (!r.ok) return 1;
  try {
    return (JSON.parse(r.body).models || []).length;
  } catch (e) {
    return 1;
  }
}

// Stops the per-user Ollama app and its server and starts the app again (it inherits StarkLLM's environment).
// true when Ollama answers again and has written which graphics it uses.
async function restartOllama() {
  await run('taskkill', ['/IM', 'ollama app.exe', '/F'], { timeoutMs: 15000 });
  await run('taskkill', ['/IM', 'ollama.exe', '/F'], { timeoutMs: 15000 });
  await waitFor(async () => (await ollamaModels()) === null, 15000, 500);
  const before = ollamaServerLog().length;
  if (!launchDetached(OLLAMA_APP)) return false;
  if (!(await waitFor(async () => (await ollamaModels()) !== null, 45000))) return false;
  // the server answers before it has written the graphics it found; give the log a moment
  await waitFor(async () => {
    const text = ollamaServerLog();
    return text.length !== before && /msg="inference compute"/.test(integratedGpu.lastStart(text));
  }, 20000, 1000);
  return true;
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
  // The local Ollama downloads the model from its registry: announced to the network layer (recorded, refused offline)
  let announced;
  try {
    announced = getShared().begin('model_download', OLLAMA_URL + '/api/pull', `Download of the AI model ${name}`, { method: 'POST', via: 'https://registry.ollama.ai' });
  } catch (e) {
    return Promise.reject(e);
  }
  return pullModelNow(name, onStatus).then(
    (r) => { announced.finish({ status: 200 }); return r; },
    (e) => { announced.fail(e); throw e; }
  );
}

function pullModelNow(name, onStatus) {
  const progress = createModelProgress();
  const speed = createSpeedMeter();
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
            // and the time left, measured from this download's own first seconds (no extra speed test)
            const sum = progress.totals();
            speed.feed(sum.completed, sum.total);
            const left = speed.secondsLeft();
            const values = { model: name, percent: Math.floor((sum.completed / sum.total) * 100), done: size(sum.completed), total: size(sum.total) };
            show(left == null
              ? t('Downloading AI model {model}: {percent} % ({done} of {total})', values)
              : t('Downloading AI model {model}: {percent} % ({done} of {total}, about {time} left)', { ...values, time: duration(left) }), sum.completed / sum.total);
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
      const permanent = /does not exist|not found|manifest unknown|invalid model name|fully offline/i.test(e.message);
      write(`pull ${name} attempt ${i} of ${attempts} failed: ${e.message}`);
      if (permanent || i >= attempts) throw e;
      const secs = Math.round(delays[i - 1] / 1000);
      onStatus(t('Download of {name} was interrupted ({error}). Trying again in {secs} s (attempt {attempt} of {attempts})...', { name, error: e.message, secs, attempt: i + 1, attempts }));
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
  // integrated graphics (AMD Radeon, Intel Arc/Iris) that Ollama leaves out: turned on once (igpu.js)
  let gpu = { used: null };
  if (IS_WIN && fs.existsSync(OLLAMA_APP)) {
    try {
      gpu = await integratedGpu.applyIntegratedGpu({
        settingsFile: engineSettingsFile(),
        readLog: ollamaServerLog,
        loadedModels: ollamaLoadedCount,
        restartOllama: async () => { status('Restarting Ollama (the local AI runtime)...'); return restartOllama(); },
        log
      });
      if (gpu.turnedOn) {
        warnings.push({ title: t('Faster answers with the graphics of this PC'), detail: t('StarkLLM turned on the integrated graphics of this PC ({gpu}) for the AI models, so answers come faster. To turn it off, use "Use the integrated graphics for AI" in the tray menu.', { gpu: gpu.turnedOn }) });
      }
      models = (await ollamaModels()) || models;
    } catch (e) {
      log('integrated graphics: ' + e.message);
    }
  }
  status('Looking at the AI models on this PC...');
  const installed = (await ollamaDetails()) || [];
  const machine = await hardware(gpu.used);
  const hw = hardwareInfo.forModelChoice(machine);
  // one recommended chat and image model per hardware tier (model_tiers.json), for a PC without a suitable model
  const tier = modelTiers.chooseTier(machine, modelTiers.loadTiers(modelTiers.tiersFile(engineDir())));
  const choice = chooseModels({ installed, hw, saved: readSavedModels(), existingIndex: hasIndex(userPaths().data), recommended: tier });
  log(`models: ${installed.length} installed; RAM ${size(hw.ramBytes)}, video memory ${hw.vramBytes ? size(hw.vramBytes) : 'unknown'}${gpu.used ? ` (integrated graphics: ${gpu.used.name})` : ''}; hardware tier ${tier ? `${tier.id} (${tier.text}, images ${tier.vision})` : 'unknown (model_tiers.json not found)'}`);
  choice.notes.forEach((n) => log('models: ' + n));
  // the first start on this PC: the recommended model is preselected and explained in one sentence on the start
  // screen (the web UI explains it once more on the dashboard, from the engine's /models/hardware)
  const why = choice.recommendedText && tier && !hasModel(models, choice.text) ? whyThisModel(tier, choice.text, machine) : null;
  if (why) log('models: ' + why);
  log(`models: chat ${choice.text}, search ${choice.embedding}, images ${choice.vision}; downloading: ${choice.pull.join(', ') || 'nothing'}`);
  useModels(choice);
  try {
    fs.writeFileSync(modelsFile(), JSON.stringify({ text: choice.text, embedding: choice.embedding, vision: choice.vision }, null, 2));
  } catch (e) {
    log('could not save the model choice: ' + e.message);
  }
  if (!choice.pull.length) status('Using {model} (already installed)', { model: choice.text });
  for (const name of choice.pull) {
    if (hasModel(models, name)) continue;
    if (getShared().isOffline()) {
      log(`pull ${name} skipped: the app is fully offline`);
      warnings.push(t('The AI model {model} is not on this PC, and StarkLLM is fully offline, so it was not downloaded. Turn off "Fully offline" in Settings > Privacy to download it.', { model: name }));
      continue;
    }
    if (why && name === choice.text) status(why);
    else status('Downloading AI model {model}...', { model: name });
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

// StarkLLM without Docker Desktop (roadmap phase 2): the engine package with its own Python (native-engine.js).
// It gets what the Docker engine gets from docker-compose.yml: the same data folder (the working directory holds
// data\), the knowledge base folder, the key, the "fully offline" switch and the cloud-sync note. No TZ: Python on
// Windows already uses the PC's time zone (and a TZ variable in IANA form would confuse it).
// The first start after an install or update is slow: Python compiles the backend (pycache) and Windows checks every
// program file once. On a busy PC that took more than 3 minutes (2.2.0 test), so it gets 10.
const NATIVE_ANSWER_MS = Number(process.env.STARKLLM_ENGINE_ANSWER_MS) || 600000;
async function startNativeEngine(appUrl, { status, onStatus, warnings, paths, guard = getShared() }) {
  const port = Number(new URL(appUrl).port) || 5173;
  nativeApiUrl = `http://127.0.0.1:${port}`;
  log('no Docker: using the StarkLLM engine without Docker');
  const ollama = await ensureOllama(status, onStatus, warnings);
  const build = 'native-' + crypto.createHash('sha256').update(app.getVersion() + JSON.stringify(chosen)).digest('hex').slice(0, 12);

  if (await isStarkLLM(appUrl)) {
    const running = await engineHealth();
    if (engineIsCurrent(running, build)) {
      status('StarkLLM is already running.');
      return { ok: true, ollama, warnings, native: true };
    }
    // an existing install that used Docker: its containers still hold the port. They are stopped (not removed), so
    // "Use Docker Desktop for the engine" in the tray menu can start them again; the data folder is the same.
    if (await stopDockerEngine(status)) await waitFor(async () => !(await isStarkLLM(appUrl)), 30000, 1000);
    if (await isStarkLLM(appUrl)) {
      return { ok: false, native: true, stage: 'engine', detail: t('Another StarkLLM engine already uses port {port}. Quit it (or the StarkLLM containers of Docker Desktop) and press Retry.', { port }) };
    }
  }

  let dir;
  try {
    // the download goes through the network layer (feature engine_download): recorded, and refused while offline
    // the installer carries the package (resources\engine-native); only builds without it download it
    dir = await native.ensurePackage(app.getVersion(), path.join(LOCAL_APP_DATA, 'StarkLLM', 'engine'), {
      onStatus: (text, fraction) => onStatus(text, fraction), log, deps: { guard },
      bundled: app.isPackaged ? native.bundledPackage(process.resourcesPath) : null
    });
  } catch (e) {
    log('engine package: ' + e.message);
    if (e && e.code === 'STARKLLM_OFFLINE') {
      return { ok: false, native: true, stage: 'engine', detail: t('StarkLLM is fully offline, and the engine files are not on this PC yet (they are downloaded once). Turn off "Fully offline" in Settings > Privacy, start StarkLLM once online, then turn it on again.') };
    }
    return { ok: false, native: true, stage: 'engine', detail: t('The StarkLLM engine could not be downloaded: {error}. Check the internet connection and press Retry.', { error: e.message }) };
  }

  status('Starting the StarkLLM engine...');
  const env = native.nativeEnv(dir, {
    kbDir: paths.kb,
    secret: process.env.SECRET_KEY || secretKey(paths.secret),
    build,
    ollamaUrl: OLLAMA_URL,
    offline: guard.isOffline(),
    kbSync: cloudSync(paths.kb) || '',
    pycache: path.join(LOCAL_APP_DATA, 'StarkLLM', 'engine', 'pycache')
  });
  const logFile = path.join(app.getPath('userData'), 'engine-native.log');
  // the working directory is the folder that holds data\ (paths.data), the same folder the Docker engine mounts
  const child = native.startNative(dir, { port, userDir: path.dirname(paths.data), env, logFile });
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  const answers = async () => exited === null && (await isStarkLLM(appUrl)) && engineIsCurrent(await engineHealth(), build);
  const slow = setTimeout(() => status('Starting the StarkLLM engine. The first start after an install or update can take a few minutes...'), 30000);
  let timedOut = false;
  if (!(await waitFor(async () => exited !== null || (await answers()), NATIVE_ANSWER_MS))) {
    timedOut = exited === null;
    native.stopNative();
  }
  clearTimeout(slow);
  if (exited !== null || !(await answers())) {
    let lines = [];
    try { lines = native.lastRun(fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean)).slice(-60); } catch (e) { /* no log yet */ }
    const blocked = native.blockedFile(lines);
    let detail;
    if (blocked) {
      detail = t('Windows blocked a program file of the StarkLLM engine ({file}). Smart App Control or another application control rule on this PC does not allow it. Please report this on the StarkLLM page on GitHub; a newer version of StarkLLM fixes it. The details are in {log}.', { file: blocked, log: logFile });
    } else if (timedOut) {
      detail = t('The StarkLLM engine did not answer within {minutes} minutes. Its log is in {log}.', { minutes: Math.round(NATIVE_ANSWER_MS / 60000), log: logFile });
    } else {
      detail = t('The StarkLLM engine did not start. Its log is in {log}.', { log: logFile });
    }
    log(`the engine without Docker did not start: ${blocked ? `Windows blocked ${blocked}` : timedOut ? 'no answer in time' : `exit code ${exited}`}`);
    return { ok: false, native: true, stage: 'engine', detail, log: lines.slice(-12) };
  }
  status('Ready.');
  return { ok: true, ollama, warnings, native: true };
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

// Existing installs that used Docker: stop StarkLLM's containers so the engine without Docker gets the port. Docker
// Desktop is not started for this; if it is not running, nothing of StarkLLM runs in it either.
async function stopDockerEngine(status = () => {}) {
  const docker = await findDocker();
  if (!docker || !(await dockerRunning(docker))) return false;
  const ps = await run(docker, ['ps', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`], { timeoutMs: 30000 });
  const ids = ps.code === 0 ? ps.lines.map((l) => l.trim()).filter((l) => /^[0-9a-f]{12,64}$/i.test(l)) : [];
  if (!ids.length) return false;
  status('Stopping the StarkLLM engine in Docker Desktop (StarkLLM now runs without Docker)...');
  const r = await run(docker, ['stop', ...ids], { timeoutMs: 120000 });
  r.lines.slice(-5).forEach((l) => log('docker stop: ' + l));
  return r.code === 0;
}

function engineSettingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// Returns { ok, ollama, warnings } or { ok: false, stage, detail, log }.
async function startEngine(appUrl, onStatus) {
  // the log keeps the English text, the start screen shows the user's language
  const status = (text, values) => {
    log(format(text, values));
    onStatus(t(text, values));
  };
  const warnings = [];
  const guard = getShared();
  const paths = userPaths();
  log(`--- start, app ${app.getVersion()}, engine ${engineDir()}`);

  // the engine without Docker is the default on Windows (owner decision 2026-11-16); Docker is the advanced choice
  const choice = native.readEngineChoice(engineSettingsFile());
  if (native.engineMode({ choice }) === 'native') {
    log(`engine without Docker (${process.env.STARKLLM_ENGINE ? 'STARKLLM_ENGINE' : choice ? 'chosen in the tray menu' : 'default'})`);
    return startNativeEngine(appUrl, { status, onStatus, warnings, paths, guard });
  }
  status('Checking Docker...');
  const docker = await findDocker();
  // On Windows a Docker that cannot run StarkLLM (stopped, or set to Windows containers) is not a dead end: the
  // engine without Docker runs instead (found on GitHub's Windows machines, which have Docker with Windows containers).
  // STARKLLM_ENGINE=docker keeps the old behaviour: the page that explains how to fix Docker.
  const withoutDocker = (reason) => {
    log(`${reason}; using the StarkLLM engine without Docker`);
    return startNativeEngine(appUrl, { status, onStatus, warnings, paths, guard });
  };
  const fallBack = IS_WIN && process.env.STARKLLM_ENGINE !== 'docker';
  if (!docker) {
    log('Docker not found (not installed or not on PATH)');
    return { ok: false, stage: 'docker-missing' };
  }
  if (!(await dockerRunning(docker))) {
    if (IS_WIN && launchDetached(DOCKER_DESKTOP)) {
      status('Starting Docker Desktop (this can take a minute)...');
      if (!(await waitFor(() => dockerRunning(docker), 240000, 4000))) {
        log('Docker Desktop was started but its engine did not come up within 4 minutes');
        if (fallBack) return withoutDocker('Docker Desktop did not start');
        return { ok: false, stage: 'docker-stopped' };
      }
    } else {
      log('Docker is installed but its engine is not running');
      if (fallBack) return withoutDocker('Docker is not running');
      return { ok: false, stage: 'docker-stopped' };
    }
  }

  if ((await dockerOsType(docker)) === 'windows') {
    log('Docker runs Windows containers; StarkLLM needs Linux containers');
    if (fallBack) return withoutDocker('Docker runs Windows containers');
    return { ok: false, stage: 'docker-windows-containers' };
  }

  const ollama = await ensureOllama(status, onStatus, warnings);

  const compose = path.join(engineDir(), 'docker-compose.yml');
  if (!fs.existsSync(compose)) return { ok: false, stage: 'engine', detail: t('Engine files are missing: {file}', { file: compose }) };
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
      warnings.push({ title: t('Still using the previous engine'), detail: t('The engine of StarkLLM {version} did not start on this PC, so StarkLLM uses the previous engine. It tries the new engine again tomorrow. The details are in {log}.', { version: app.getVersion(), log: paths.log }) });
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
    STARKLLM_TZ: process.env.STARKLLM_TZ || localTimeZone(),
    // the knowledge base folder is in OneDrive (or another synced folder): the knowledge base page says so
    STARKLLM_KB_SYNC: cloudSync(paths.kb) || '',
    // the "fully offline" switch: the engine starts with it on and refuses every connection except to this PC
    STARKLLM_OFFLINE: guard.isOffline() ? '1' : ''
  };
  let up = null;
  let builds = [];
  if (usePrebuilt()) {
    const images = engineImages(app.getVersion());
    env.STARKLLM_BACKEND_IMAGE = images.backend;
    env.STARKLLM_FRONTEND_IMAGE = images.frontend;
  }
  const noBuildUp = () => run(docker, offlineUpArgs(PROJECT, compose), { env, cwd: engineDir(), timeoutMs: 10 * 60 * 1000 });
  if (guard.isOffline()) {
    // no download, no build: only the engine files that are already on this PC
    status('StarkLLM is fully offline: starting the engine from the files on this PC...');
    up = await noBuildUp();
    if (up.code !== 0) {
      up.lines.slice(-8).forEach((l) => log('compose (offline): ' + l));
      return { ok: false, stage: 'engine', detail: t('StarkLLM is fully offline, and the engine files are not on this PC yet (they are downloaded once). Turn off "Fully offline" in Settings > Privacy, start StarkLLM once online, then turn it on again.'), log: up.lines.slice(-8) };
    }
  } else if (usePrebuilt()) {
    const images = engineImages(app.getVersion());
    const label = updating ? t('Downloading the StarkLLM engine {version}', { version: app.getVersion() }) : t('Downloading the StarkLLM engine');
    status(updating ? 'Downloading the StarkLLM engine {version}...' : 'Downloading the StarkLLM engine...', { version: app.getVersion() });
    const sizes = new Map([...(await imageLayerSizes(images.backend)), ...(await imageLayerSizes(images.frontend))]);
    const progress = createPullProgress(sizes);
    if (sizes.size) log(`engine download: ${sizes.size} layers, ${formatBytes(progress.total())}`);
    const show = throttle(() => onStatus(progress.text(label), progress.fraction()), 250);
    // Docker downloads the images: announced to the network layer (recorded as a download from the registry)
    const dl = guard.begin('engine_download', 'https://ghcr.io', `Download of the StarkLLM engine ${app.getVersion()} (Docker images)`);
    const pulled = await run(docker, ['compose', '-p', PROJECT, '-f', compose, 'pull'], {
      env,
      cwd: engineDir(),
      timeoutMs: 45 * 60 * 1000,
      onLine: (line) => { if (progress.feed(line)) show(); }
    });
    if (pulled.code === 0) dl.finish({ status: 200, bytesIn: progress.total() || null });
    else dl.fail(new Error(`docker compose pull exited with ${pulled.code}`));
    if (pulled.code === 0) {
      log(`pulled ${images.backend} and ${images.frontend}`);
      up = await run(docker, ['compose', '-p', PROJECT, '-f', compose, 'up', '-d', '--no-build'], { env, cwd: engineDir(), timeoutMs: 10 * 60 * 1000 });
    } else {
      pulled.lines.slice(-8).forEach((l) => log('compose pull: ' + l));
      log('the published engine could not be downloaded; building it on this PC instead');
    }
  }
  if (!up) {
    // building on this PC: Docker downloads the base image and packages
    builds = ['registry-1.docker.io', 'pypi.org', 'deb.debian.org'].map((h) => guard.begin('engine_build', `https://${h}`, 'Build of the engine on this PC: Docker downloads the base image and packages'));
    status(updating
      ? 'Updating the StarkLLM engine to version {version} (a few minutes)...'
      : 'Starting the StarkLLM engine. The first start downloads and builds its components (10-20 minutes, needs internet)...', { version: app.getVersion() });
    up = await run(docker, ['compose', '-p', PROJECT, '-f', compose, 'up', '-d', '--build'], {
      env,
      cwd: engineDir(),
      timeoutMs: 60 * 60 * 1000,
      onLine: (line) => onStatus(t('Engine: ') + line.slice(0, 140))
    });
    builds.forEach((b) => (up.code === 0 ? b.finish({ status: 200 }) : b.fail(new Error(`docker compose up --build exited with ${up.code}`))));
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
    warnings.push({ title: t('Went back to the previous engine'), detail: t('The engine of StarkLLM {version} did not start ({reason}), so StarkLLM started the previous engine again. Your chats and documents are unchanged. It tries the new engine again tomorrow. The details are in {log}.', { version: app.getVersion(), reason, log: paths.log }) });
    return true;
  };
  if (up.code !== 0 && !up.lines.some((l) => /address already in use|port is already allocated|ports are not available/i.test(l)) && (await goBack('it could not be started'))) {
    return { ok: true, ollama, warnings };
  }
  if (up.code !== 0) {
    const portBusy = up.lines.some((l) => /address already in use|port is already allocated|ports are not available/i.test(l));
    const detail = portBusy
      ? t('Another program on this PC already uses port {ui} or {api}. Close it and press Retry.', { ui: process.env.STARKLLM_UI_PORT || 5173, api: process.env.STARKLLM_API_PORT || 8000 })
      : t('The engine could not be started.');
    return { ok: false, stage: 'engine', detail, log: up.lines.slice(-8) };
  }

  status('Waiting for StarkLLM to answer...');
  // After an update the old containers can answer for a moment while compose replaces them.
  const answers = async () => (await isStarkLLM(appUrl)) && (reusedOther || engineIsCurrent(await engineHealth(), fingerprint));
  if (!(await waitFor(answers, ENGINE_ANSWER_MS))) {
    const logs = await run(docker, ['compose', '-p', PROJECT, '-f', compose, 'logs', '--tail', '20'], { env, timeoutMs: 30000 });
    logs.lines.forEach((l) => log('engine: ' + l));
    if (await goBack(`it did not answer within ${Math.round(ENGINE_ANSWER_MS / 60000)} minutes`)) return { ok: true, ollama, warnings };
    return { ok: false, stage: 'engine', detail: t('The engine started but the web UI does not answer.'), log: logs.lines.slice(-20) };
  }
  if (updating) forgetFailedUpdate();
  status('Ready.');
  return { ok: true, ollama, warnings };
}

// Fully offline: start only from the engine images already on this PC. Without --pull never, `compose up` downloads
// missing images by itself (found on the MSI test PC, 16 Nov 2026: 2.1.1 pulled its new engine while "fully
// offline" was on, and the download did not appear in the network list).
function offlineUpArgs(project, composeFile) {
  return ['compose', '-p', project, '-f', composeFile, 'up', '-d', '--no-build', '--pull', 'never'];
}

module.exports = { apiUrl, stopNativeEngine: native.stopNative, startNativeEngine, stopDockerEngine, engineSettingsFile, offlineUpArgs, forgetFailedUpdate, skipFailedUpdate, keepRollbackImages, rollbackEngine, imageLayerSizes, engineImages, secretKey, startEngine, userPaths, pullWithRetry, buildWithoutBake, run, engineIsCurrent, engineFingerprint, TEXT_MODEL, EMBEDDING_MODEL };
