// Settings › Connections (docs/connections.md): the catalog of apps, the installation of a catalog entry or a .mcpb
// bundle through the runtimes StarkLLM brings, and the secrets in Windows Credential Manager. The servers themselves are
// run by mcp.js (the same list as Settings › Local Tools), so every rule there applies: tools start off, each call asks.
// Package downloads go through the network layer (netguard, feature "connection_install") and are refused while fully
// offline.
const { app, dialog, BrowserWindow, safeStorage } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./connections-core');
const runtimes = require('./runtimes');
const mcpb = require('./mcpb');
const mcp = require('./mcp');
const { createSecretStore } = require('./secret-store');
const { getShared } = require('./netguard');

const STEP_MINUTES = 15;
let catalog = null;
let paths = null;
let secrets = null;
let isOffline = () => false;
let log = () => {};
let pendingBundle = ''; // a .mcpb file opened with StarkLLM (file association), until the Settings page takes it
const previews = new Map(); // token -> { file, info, at }

const cat = () => {
  if (!catalog) catalog = core.loadCatalog();
  return catalog;
};
const findEntry = (id) => cat().entries.find((e) => e.id === id);

// one command of an installation; host: announced to netguard first (refused while fully offline)
function runStep(step, { spawnFn = spawn, guard = getShared() } = {}) {
  return new Promise((resolve, reject) => {
    let handle = null;
    try {
      if (step.host) handle = guard.begin('connection_install', step.host, step.purpose || 'Connection package', { method: 'GET' });
    } catch (e) {
      reject(e);
      return;
    }
    let child;
    try {
      child = spawnFn(step.command, step.args, { env: mcp.serverEnv(step.env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      if (handle) handle.fail(e);
      reject(e);
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } }, STEP_MINUTES * 60 * 1000);
    child.stdout.on('data', (b) => { out = (out + b.toString('utf8')).slice(-20000); });
    child.stderr.on('data', (b) => { err = (err + b.toString('utf8')).slice(-20000); });
    child.on('error', (e) => { clearTimeout(timer); if (handle) handle.fail(e); reject(new Error(`could not start ${path.basename(step.command)}: ${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        if (handle) handle.finish({ status: 0 });
        resolve({ stdout: out, stderr: err });
      } else {
        const e = new Error(`${path.basename(step.command)} ended with code ${code}: ${(err || out).trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
        if (handle) handle.fail(e);
        reject(e);
      }
    });
  });
}

async function runSteps(steps, { onProgress = () => {}, ...opts } = {}) {
  const captured = {};
  for (let i = 0; i < steps.length; i++) {
    onProgress({ step: i + 1, total: steps.length, label: steps[i].purpose || path.basename(steps[i].command) });
    const r = await runStep(steps[i], opts);
    if (steps[i].capture) captured[steps[i].capture] = r.stdout.trim().split(/\r?\n/).pop();
  }
  return captured;
}

// the program a catalog or bundle entry starts (mcp.js asks before each start)
function launchFor(server) {
  if (server.kind === 'bundle') return { command: server.command, args: [], env: {} };
  const entry = findEntry(server.catalogId);
  if (!entry || !paths) return null;
  const launch = runtimes.launchCommand(entry, paths, { electronPath: process.execPath });
  if (!launch) return null;
  // without the bundled Node (a run from source), Electron itself runs as Node
  if (launch.command === paths.node && !fs.existsSync(paths.node)) return { command: process.execPath, args: launch.args, env: { ELECTRON_RUN_AS_NODE: '1' } };
  return launch;
}

function runtimeReady(entry) {
  const rt = entry.package && entry.package.runtime;
  if (rt === 'uv') return fs.existsSync(paths.uv);
  if (rt === 'npm') return fs.existsSync(paths.node) && fs.existsSync(paths.npmCli) && (!entry.package.python || fs.existsSync(paths.uv));
  return true;
}

async function saveSecrets(serverId, values) {
  const refs = {};
  for (const [field, value] of Object.entries(values)) {
    const ref = `${serverId}/${field}`;
    await secrets.set(ref, value);
    refs[field] = ref;
  }
  return refs;
}

async function removeSecrets(server) {
  for (const ref of Object.values(server.secretRefs || {})) {
    try { await secrets.remove(ref); } catch (e) { log(`Connections: could not remove a secret: ${e.message}`); }
  }
}

const newId = () => `c${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

async function installCatalog(id, values, { acknowledged = false, lang = 'en', onProgress = () => {} } = {}) {
  const entry = findEntry(String(id));
  if (!entry || entry.status !== 'ready') return { error: 'unknown' };
  if (entry.advanced && acknowledged !== true) return { error: 'needs-acknowledgement' };
  if (mcp.readServers().length >= mcp.MAX_SERVERS) return { error: 'too-many' };
  const form = core.applyForm(entry, values || {});
  if (!form.ok) return { error: 'invalid', errors: form.errors };
  if (isOffline()) return { error: 'offline' };
  if (!runtimeReady(entry)) return { error: 'runtime-missing' };
  const steps = runtimes.installSteps(entry, paths);
  const captured = await runSteps(steps, { onProgress });
  const env = { ...form.env };
  if (entry.package.pythonEnv && captured.python) env[entry.package.pythonEnv] = captured.python;
  // a program that keeps its own files (DaVinci Resolve's helper): inside StarkLLM's folder, not in the user's profile
  if (entry.package.dataDirEnv) env[entry.package.dataDirEnv] = path.join(paths.base, 'data', entry.id);
  // the setup of the entry (the Blender add-on, the GIMP plug-in ...), with the program that was just installed
  const launch = launchFor({ kind: 'catalog', catalogId: entry.id });
  const setup = runtimes.setupSteps(entry, paths, env).map((s) => ({ ...s, command: launch.command, args: [...launch.args, ...s.setupArgs], env: { ...s.env, ...(launch.env || {}) } }));
  // DaVinci Resolve's setup ends with a check that needs Resolve itself: without it the helper is still in place, and the
  // server says what is missing when it is used
  let setupWarning = '';
  if (setup.length) {
    try {
      await runSteps(setup, { onProgress });
    } catch (e) {
      if (!entry.package.setupOptional) throw e;
      setupWarning = String(e.message || e).slice(0, 300);
      log(`Connection ${entry.id}: setup incomplete: ${setupWarning}`);
    }
  }
  const serverId = newId();
  const secretRefs = await saveSecrets(serverId, form.secrets);
  const server = {
    id: serverId,
    name: core.text(entry.name, lang, cat().texts),
    transport: entry.transport,
    kind: 'catalog',
    catalogId: entry.id,
    version: (entry.package && entry.package.version) || '',
    args: form.args,
    env,
    url: form.url || '',
    secretRefs,
    secretEnv: form.secretEnv,
    secretHeaders: form.secretHeaders,
    allowLan: Boolean(entry.allowLan),
    tls: entry.tls || '',
    rules: { tiers: entry.tiers, defaultTier: entry.defaultTier, blockedTools: entry.blockedTools, untrustedOutput: entry.untrustedOutput },
    readOnly: Boolean(entry.readOnlyByDefault) && !form.unlocked.includes('write'),
    enabledTools: [],
    pins: null,
  };
  mcp.writeServers([...mcp.readServers(), server]);
  log(`Connection installed: ${entry.id} ${server.version}`);
  let startError = '';
  try { await mcp.start(server); } catch (e) { startError = String(e.message || e).slice(0, 300); }
  return { ok: true, serverId, startError: startError || setupWarning, servers: mcp.view() };
}

async function uninstall(serverId) {
  const server = mcp.readServers().find((s) => s.id === String(serverId));
  if (!server) return { error: 'unknown' };
  mcp.stop(server.id);
  mcp.writeServers(mcp.readServers().filter((s) => s.id !== server.id));
  await removeSecrets(server);
  try {
    if (server.kind === 'bundle' && server.bundleDir && path.resolve(server.bundleDir).startsWith(path.resolve(paths.mcpb) + path.sep)) {
      fs.rmSync(server.bundleDir, { recursive: true, force: true });
    } else if (server.kind === 'catalog') {
      const entry = findEntry(server.catalogId);
      const others = mcp.readServers().filter((s) => s.kind === 'catalog' && s.catalogId && findEntry(s.catalogId) && entry && findEntry(s.catalogId).package.name === entry.package.name);
      if (entry && !others.length) {
        if (entry.package.runtime === 'npm') fs.rmSync(runtimes.npmDir(paths, entry.id), { recursive: true, force: true });
        fs.rmSync(path.join(paths.base, 'data', entry.id), { recursive: true, force: true });
        for (const step of runtimes.uninstallSteps(entry, paths)) if (fs.existsSync(step.command)) await runStep(step).catch(() => {});
      }
    }
  } catch (e) {
    log(`Connections: files of ${server.name} were not all removed: ${e.message}`);
  }
  return { ok: true, servers: mcp.view() };
}

// ── .mcpb bundles ──
function previewBundle(file) {
  const f = String(file || '');
  if (!/\.(mcpb|dxt)$/i.test(f) || !fs.existsSync(f)) return { error: 'not-a-bundle' };
  const info = mcpb.inspectBundle(f);
  const token = crypto.randomBytes(12).toString('hex');
  previews.set(token, { file: f, info, at: Date.now() });
  for (const [k, v] of previews) if (Date.now() - v.at > 30 * 60 * 1000) previews.delete(k);
  const m = info.manifest;
  return {
    ok: true, token,
    manifest: {
      name: m.displayName, id: m.name, version: m.version, description: m.description, author: m.author, license: m.license, homepage: m.homepage,
      serverType: m.serverType, command: m.command, args: m.args, envNames: Object.keys(m.env), tools: info.tiers, platforms: m.platforms,
      manifestVersion: m.manifestVersion, fileCount: info.fileCount, unpackedSize: info.unpackedSize,
    },
    fields: info.form,
  };
}

async function installBundle(token, values = {}, { onProgress = () => {} } = {}) {
  const p = previews.get(String(token));
  if (!p) return { error: 'expired' };
  previews.delete(String(token));
  if (mcp.readServers().length >= mcp.MAX_SERVERS) return { error: 'too-many' };
  const man = p.info.manifest;
  const secretValues = {};
  const plain = {};
  const errors = [];
  for (const f of p.info.form) {
    const v = values[f.id] === undefined || values[f.id] === '' ? f.default : values[f.id];
    if ((v === undefined || v === '') && f.required) { errors.push({ field: f.id, error: 'required' }); continue; }
    if (v === undefined) continue;
    if (/[\u0000-\u001f]/.test(String(v))) { errors.push({ field: f.id, error: 'invalid' }); continue; }
    if (f.kind === 'secret') secretValues[f.id] = String(v); else plain[f.id] = f.kind === 'checkbox' ? Boolean(v) : v;
  }
  if (errors.length) return { error: 'invalid', errors };
  if (man.serverType === 'python' || man.command === 'uv' || man.command === 'uvx') {
    if (isOffline()) return { error: 'offline' };
    if (!fs.existsSync(paths.uv)) return { error: 'runtime-missing' };
    await runSteps([{ command: paths.uv, args: ['python', 'install', '3.12'], env: runtimes.uvEnv(paths), host: runtimes.HOSTS.python, purpose: `Python for ${man.name}` }], { onProgress });
  }
  const serverId = newId();
  const dir = path.join(paths.mcpb, `${man.name.replace(/[^\w.-]/g, '_').slice(0, 40)}-${serverId}`);
  mcpb.unpackBundle(p.file, dir);
  const node = fs.existsSync(paths.node) ? paths.node : process.execPath;
  const srv = mcpb.bundleServer(man, { dir, values: plain, secretIds: Object.keys(secretValues), paths: { ...paths, node } });
  if (node === process.execPath) srv.env.ELECTRON_RUN_AS_NODE = '1';
  const bind = core.checkBinding({ args: srv.args, env: srv.env });
  if (bind) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { error: bind };
  }
  const secretRefs = await saveSecrets(serverId, secretValues);
  const server = {
    id: serverId, name: man.displayName, transport: 'stdio', kind: 'bundle', version: man.version, command: srv.command, args: srv.args, env: srv.env, cwd: srv.cwd,
    secretRefs, secretEnv: srv.secretEnv, rules: null, readOnly: false, enabledTools: [], pins: null, bundleDir: dir,
  };
  mcp.writeServers([...mcp.readServers(), server]);
  log(`Connection installed from a bundle: ${man.name} ${man.version}`);
  let startError = '';
  try { await mcp.start(server); } catch (e) { startError = String(e.message || e).slice(0, 300); }
  return { ok: true, serverId, startError, servers: mcp.view() };
}

// a .mcpb file opened with StarkLLM (double-click, "Open with"): remembered until Settings › Connections takes it
function openBundleFile(file, win) {
  if (!/\.(mcpb|dxt)$/i.test(String(file || ''))) return false;
  pendingBundle = String(file);
  if (win && !win.isDestroyed()) win.webContents.send('connections:open-mcpb');
  return true;
}

// resourcesPath: where runtime/ is (the installed app: process.resourcesPath; tools/connections-try.js passes its own)
function register(ipcMain, { fromApp, offline = () => false, log: logFn = () => {}, resourcesPath = process.resourcesPath }) {
  isOffline = offline;
  log = logFn;
  paths = runtimes.runtimePaths({ resourcesPath, userData: app.getPath('userData') });
  const sealOk = safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable();
  secrets = createSecretStore({
    file: path.join(app.getPath('userData'), 'connections-secrets.json'),
    seal: sealOk ? (t) => safeStorage.encryptString(t).toString('base64') : null,
    unseal: sealOk ? (d) => safeStorage.decryptString(Buffer.from(d, 'base64')) : null,
  });
  mcp.configure({ secrets, launch: launchFor });
  const allowed = (fn) => async (event, ...args) => {
    if (!fromApp(event)) return { error: 'not-allowed' };
    try {
      return await fn(event, ...args);
    } catch (e) {
      return { error: e && e.code === 'STARKLLM_OFFLINE' ? 'offline' : 'failed', message: String((e && e.message) || e).slice(0, 300) };
    }
  };
  const progressTo = (event, id) => (p) => { try { event.sender.send('connections:progress', { id, ...p }); } catch (e) { /* window closed */ } };
  ipcMain.handle('connections:catalog', allowed(async (_e, lang) => {
    const installed = mcp.readServers().filter((s) => s.kind === 'catalog');
    const entries = core.catalogView(cat(), core.LANGS.includes(lang) ? lang : 'en').map((e) => {
      const full = findEntry(e.id);
      return { ...e, installed: installed.filter((s) => s.catalogId === e.id).map((s) => s.id), runtimeReady: full.status === 'ready' ? runtimeReady(full) : false };
    });
    return { entries, secretStore: secrets.kind, offline: isOffline() };
  }));
  ipcMain.handle('connections:pick-folder', allowed(async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled || !r.filePaths[0] ? { canceled: true } : { path: r.filePaths[0] };
  }));
  ipcMain.handle('connections:install', allowed(async (event, id, values, opts) => installCatalog(id, values, { ...(opts || {}), onProgress: progressTo(event, id) })));
  ipcMain.handle('connections:uninstall', allowed(async (_e, serverId) => uninstall(serverId)));
  ipcMain.handle('connections:choose-bundle', allowed(async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'MCP Bundle', extensions: ['mcpb', 'dxt'] }] });
    return r.canceled || !r.filePaths[0] ? { canceled: true } : previewBundle(r.filePaths[0]);
  }));
  ipcMain.handle('connections:preview-bundle', allowed(async (_e, file) => previewBundle(file)));
  ipcMain.handle('connections:has-pending', allowed(async () => ({ pending: Boolean(pendingBundle) })));
  ipcMain.handle('connections:pending-bundle', allowed(async () => {
    const f = pendingBundle;
    pendingBundle = '';
    return f ? previewBundle(f) : { none: true };
  }));
  ipcMain.handle('connections:install-bundle', allowed(async (event, token, values) => installBundle(token, values, { onProgress: progressTo(event, 'bundle') })));
}

module.exports = { register, openBundleFile, runStep, runSteps, previewBundle };
