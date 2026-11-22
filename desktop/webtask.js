// Web tasks (docs/web-tasks.md): StarkLLM's own browser window, in which the local AI model does a task on websites
// while the user watches. The loop and its rules are in webtask-core.js; this file is the Electron part:
//  * a separate window with its own storage ("persist:starkllm-web"): no access to the user's own browser, its
//    sign-ins or its cookies, and none to StarkLLM's own page or token;
//  * every request of the window goes through the network layer (netguard.js, feature "web_task"): recorded in the
//    network log and refused while StarkLLM is fully offline; requests of web pages to this PC or the home network are
//    refused (a page must not reach the engine, Ollama or a router);
//  * no permissions (camera, microphone, location, notifications ...), no downloads, no pop-up windows;
//  * the AI model is the local Ollama on this PC; the chat page shows each step, asks the user's yes before risky
//    clicks and hands passwords, payments and CAPTCHAs to the user (IPC "webtask:*");
//  * with a project folder the user chose in a folder dialog, the terminal (terminal-core.js): files and commands in
//    that folder only, each change and command after the user's yes, the file changes can be undone afterwards.
//    Commands run as the user, with the user's rights, without the secrets of StarkLLM's own environment;
//  * scheduled web tasks (schedule-core.js) run in a hidden window and only look.
const { app, BrowserWindow, session, dialog, Notification } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { runTask } = require('./webtask-core');
const { createTerminal } = require('./terminal-core');
const schedule = require('./schedule-core');
const { PAGE_SCRIPT } = require('./webtask-page');
const { getShared } = require('./netguard');
const { t } = require('./i18n');

const OLLAMA_URL = process.env.STARKLLM_OLLAMA_URL || 'http://127.0.0.1:11434';
const PARTITION = 'persist:starkllm-web';
const LANGUAGE_NAMES = { en: 'English', de: 'German', es: 'Spanish', fr: 'French', it: 'Italian', tr: 'Turkish' };

let win = null;
let current = null; // { id, signal, sender, scheduled? }
let lastTerminal = null; // the terminal of the last task, for "Undo the file changes"
let lastTerminalTask = '';
const running = new Set(); // child processes of commands that run now
let backgroundRun = false; // a scheduled task runs in a hidden window
let userStarting = false; // the user's own task is starting: no scheduled run begins meanwhile
const pending = new Map(); // question id -> resolve
let sessionReady = false;

function prepareSession() {
  const ses = session.fromPartition(PARTITION);
  if (sessionReady) return ses;
  sessionReady = true;
  getShared().attachSession(ses, { feature: 'web_task', blockLocal: true });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event, item) => {
    event.preventDefault();
    getShared().record({ feature: 'web_task', host: hostOf(item.getURL()), purpose: 'Download in the StarkLLM browser window', outcome: 'blocked', error: 'downloads are off' });
  });
  return ses;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

function isWeb(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

function openWindow() {
  if (win && !win.isDestroyed()) return win;
  prepareSession();
  win = new BrowserWindow({
    width: 1180,
    height: 860,
    show: !backgroundRun,
    title: t('StarkLLM web task'),
    autoHideMenuBar: true,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  const wc = win.webContents;
  // links that would open a new window open here; nothing but web addresses
  wc.setWindowOpenHandler(({ url }) => {
    if (isWeb(url)) wc.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
  wc.on('will-navigate', (event, url) => { if (!isWeb(url)) event.preventDefault(); });
  win.on('page-title-updated', (event, title) => {
    event.preventDefault();
    if (!win.isDestroyed()) win.setTitle(`${title} · ${t('StarkLLM web task')}`);
  });
  win.on('closed', () => {
    win = null;
    if (current) current.signal.stopped = true; // closing the window ends the task
    for (const resolve of pending.values()) resolve({ ok: false });
    pending.clear();
  });
  return win;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// after a click or Enter: give the page time to start loading, then wait until it is done (at most 15 s)
async function settle(wc) {
  await sleep(600);
  const until = Date.now() + 15000;
  while (!wc.isDestroyed() && wc.isLoading() && Date.now() < until) await sleep(200);
  await sleep(300);
}

// A script in the page, with a time limit: a page that never answers must not stop the task for ever.
async function inPage(wc, expression, ms = 10000) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the page did not answer')), ms); });
  try {
    return await Promise.race([
      wc.executeJavaScript(PAGE_SCRIPT, false).then(() => wc.executeJavaScript(expression, false)),
      limit,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// A hidden window of its own for a scheduled run: the same storage as the web-task window, never shown, closed after
// the run. The user's own window (if open) is not touched.
let bgWin = null;
function openBackgroundWindow() {
  if (bgWin && !bgWin.isDestroyed()) return bgWin;
  prepareSession();
  bgWin = new BrowserWindow({
    width: 1180,
    height: 860,
    show: false,
    webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  const wc = bgWin.webContents;
  wc.setWindowOpenHandler(({ url }) => { if (isWeb(url)) wc.loadURL(url).catch(() => {}); return { action: 'deny' }; });
  wc.on('will-navigate', (event, url) => { if (!isWeb(url)) event.preventDefault(); });
  bgWin.on('closed', () => { bgWin = null; });
  return bgWin;
}

function closeBackgroundWindow() {
  if (bgWin && !bgWin.isDestroyed()) bgWin.destroy();
  bgWin = null;
}

function electronBrowser(getWindow = openWindow) {
  const hidden = getWindow !== openWindow;
  const current = () => (hidden ? bgWin : win);
  const w = () => getWindow().webContents;
  return {
    // a follow-up task continues on the page the window shows
    hasPage: () => { const x = current(); return Boolean(x && !x.isDestroyed() && isWeb(x.webContents.getURL())); },
    async open(url) {
      const wc = w();
      if (!hidden && !win.isVisible()) win.show();
      await wc.loadURL(url).catch((e) => {
        // a page that redirects or stops early still counts; a blocked request (offline) does not
        if (getShared().isOffline()) {
          const err = new Error(t('StarkLLM is fully offline: web tasks are off.'));
          err.code = 'STARKLLM_OFFLINE';
          throw err;
        }
        if (!/ERR_ABORTED/.test(String(e && e.message))) throw e;
      });
      await settle(wc);
    },
    async snapshot() { return inPage(w(), 'window.__starkllm.snapshot()'); },
    async click(i) {
      const wc = w();
      const r = await inPage(wc, `window.__starkllm.rect(${Number(i)})`);
      if (!r) throw new Error('the element is no longer on the page');
      await sleep(150); // scrolling into view
      wc.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await settle(wc);
      return r;
    },
    async focusInfo(i) { return inPage(w(), `window.__starkllm.focusField(${Number(i)})`); },
    async type(i, text, enter) {
      const wc = w();
      const info = await inPage(wc, `window.__starkllm.focusField(${Number(i)})`);
      if (!info) throw new Error('the field is no longer on the page');
      wc.insertText(String(text));
      if (enter) {
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        wc.sendInputEvent({ type: 'char', keyCode: '\r' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      }
      await settle(wc);
      return info;
    },
    async select(i, option) {
      const wc = w();
      const v = await inPage(wc, `window.__starkllm.choose(${Number(i)}, ${JSON.stringify(String(option))})`);
      await settle(wc);
      return v;
    },
    async scroll(dir) { const wc = w(); await inPage(wc, `window.__starkllm.scrollPage(${JSON.stringify(dir)})`); await sleep(400); },
    async back() {
      const wc = w();
      const h = wc.navigationHistory;
      if (h && h.canGoBack()) { h.goBack(); await settle(wc); }
    },
    async read() { return inPage(w(), 'window.__starkllm.read()'); },
    // a site the rules do not allow: back to the page before, or an empty page
    async leave() {
      const wc = w();
      const h = wc.navigationHistory;
      if (h && h.canGoBack()) h.goBack();
      else await wc.loadURL('about:blank').catch(() => {});
      await settle(wc);
    },
  };
}

// The user's site rules (Settings > Privacy & network): { "host": "allow" | "block" }, kept in the profile folder.
function rulesFile() {
  return path.join(app.getPath('userData'), 'webtask-sites.json');
}

function readRules() {
  try {
    const r = JSON.parse(fs.readFileSync(rulesFile(), 'utf8'));
    return r && typeof r === 'object' ? r : {};
  } catch (e) {
    return {};
  }
}

function writeRule(host, rule) {
  const h = String(host || '').toLowerCase().trim();
  if (!/^[a-z0-9.-]{1,253}$/.test(h)) return false;
  const rules = readRules();
  if (rule === 'allow' || rule === 'block') rules[h] = rule;
  else delete rules[h];
  fs.writeFileSync(rulesFile(), JSON.stringify(rules, null, 1));
  return true;
}

// ── Terminal ──
// The project folders the user chose in the folder dialog (only those can be used), kept in the profile folder.
function foldersFile() {
  return path.join(app.getPath('userData'), 'webtask-folders.json');
}

function readFolders() {
  try {
    const f = JSON.parse(fs.readFileSync(foldersFile(), 'utf8'));
    return Array.isArray(f) ? f.filter((x) => typeof x === 'string') : [];
  } catch (e) {
    return [];
  }
}

// a whole drive, the user's own folder, Windows or the programs: not a project folder
function unsuitableFolder(dir) {
  const d = path.resolve(dir);
  const norm = (x) => path.resolve(x).toLowerCase().replace(/[\\/]+$/, '');
  if (path.parse(d).root === d || norm(d) === norm(path.parse(d).root)) return 'drive';
  const home = os.homedir();
  const system = [home, path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads'), app.getPath('userData'),
    process.env.WINDIR, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData, process.env.APPDATA, process.env.LOCALAPPDATA,
    '/etc', '/usr', '/bin', '/var', '/System', '/Library', '/Applications'].filter(Boolean);
  if (system.some((s) => norm(s) === norm(d))) return 'system';
  if ([process.env.WINDIR, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], app.getPath('userData')].filter(Boolean)
    .some((s) => (norm(d) + path.sep).startsWith(norm(s) + path.sep))) return 'system';
  return '';
}

// commands get the user's environment without secrets (tokens, keys, passwords) and without StarkLLM's own settings
function commandEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/token|secret|passw|pwd$|api_?key|private|credential|^starkllm|^electron|^npm_config_.*auth|^aws_|^azure_|^gh_|^github_/i.test(k)) continue;
    env[k] = v;
  }
  env.GIT_PAGER = 'cat';
  env.PAGER = 'cat';
  env.GIT_TERMINAL_PROMPT = '0';
  env.CI = '1'; // programs do not wait for input and print plain output
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  return env;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (err) { /* gone */ } } }
}

// one command in the project folder: PowerShell on Windows, bash elsewhere; no input; ends after the time limit,
// when the task is stopped, or when StarkLLM quits (with every program it started)
function runCommand(command, { cwd, timeoutMs, signal }) {
  return new Promise((resolve) => {
    const win32 = process.platform === 'win32';
    const child = win32
      ? spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; ${command}`],
      { cwd, env: commandEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('bash', ['-c', command], { cwd, env: commandEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    running.add(child);
    let out = '';
    const add = (b) => { if (out.length < 400000) out += b.toString('utf8'); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const watch = setInterval(() => { if (signal && signal.stopped) killTree(child); }, 300);
    const done = (code) => {
      clearTimeout(timer);
      clearInterval(watch);
      running.delete(child);
      resolve({ code: code == null ? -1 : code, output: out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''), timedOut });
    };
    child.on('error', (e) => { add(Buffer.from(String(e.message))); done(-1); });
    child.on('close', done);
  });
}

function stopCommands() {
  for (const child of running) killTree(child);
}

// The local AI model (Ollama on this PC). Recorded by the network layer like every connection of the app.
function ollamaChat(model, abortSignal) {
  const post = getShared().wrapFetch(fetch, 'web_task', 'The local AI model (Ollama on this PC) chooses the next step of a web task');
  return async (messages, tools) => {
    const res = await post(OLLAMA_URL + '/api/chat', {
      method: 'POST',
      signal: abortSignal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, tools, stream: false, think: false, options: { num_ctx: 16384, temperature: 0.1 } }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Ollama ${res.status}: ${detail.slice(0, 200)}`);
    }
    const j = await res.json();
    return j.message || {};
  };
}

// ── Scheduled web tasks (docs/roadmap-2026-12.md, R5; rules in schedule-core.js) ──
function schedulesFile() {
  return path.join(app.getPath('userData'), 'webtask-schedules.json');
}

function readSchedules() {
  try {
    const list = JSON.parse(fs.readFileSync(schedulesFile(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function writeSchedules(list) {
  fs.writeFileSync(schedulesFile(), JSON.stringify(list.slice(0, schedule.MAX_SCHEDULES), null, 1));
}

const scheduleListeners = new Set(); // chat pages that show the list
function scheduleChanged() {
  for (const wc of scheduleListeners) if (!wc.isDestroyed()) wc.send('webtask:schedules-changed');
}

async function stopScheduledRun() {
  if (!current || !current.scheduled) return;
  current.signal.stopped = true;
  current.signal.preempted = true; // the user's own task: this run did not happen, it runs again later
  if (current.abort) current.abort.abort(); // the model call that runs now ends at once
  for (let k = 0; k < 300 && current; k++) await sleep(100);
}

// One scheduled task, in a hidden window, looking only: every question is answered "no" by itself.
async function runScheduled(id, { log = () => {}, notify = true } = {}) {
  const s = readSchedules().find((x) => x.id === id);
  if (!s) return { error: 'unknown' };
  if (current || userStarting) return { error: 'busy' };
  if (getShared().isOffline()) return { error: 'offline' };
  const signal = { stopped: false, paused: false, untilResumed: async () => {}, resume: () => {} };
  const abort = new AbortController();
  current = { id: `sch-${s.id}`, signal, sender: null, scheduled: true, abort };
  backgroundRun = true;
  let url = '';
  let result;
  try {
    const rules = readRules();
    const r = await runTask({
      task: s.task, language: LANGUAGE_NAMES[s.language] || 'English', browser: electronBrowser(openBackgroundWindow), llm: ollamaChat(s.model, abort.signal),
      ask: schedule.lookingOnlyAsk, emit: (e) => { if (e.type === 'answer' && e.url) url = e.url; }, signal,
      siteRule: (host) => rules[host] || rules[host.replace(/^www\./, '')] || '', saveSiteRule: () => {},
      maxSteps: 20, maxMinutes: 8,
    });
    result = { status: r.status, answer: r.answer || r.error || '', url };
  } catch (e) {
    result = { status: 'error', answer: String(e && e.message), url };
  } finally {
    current = null;
    backgroundRun = false;
    // the hidden window of the run is closed; a window the user has open stays
    closeBackgroundWindow();
  }
  // a run that gave way to the user's own task, or ended with StarkLLM, is not recorded: it runs again later
  if (signal.preempted) return { error: 'preempted' };
  const list = readSchedules();
  const k = list.findIndex((x) => x.id === id);
  if (k < 0) return { error: 'unknown' };
  const done = schedule.recordRun(list[k], result);
  const { isChange, ...kept } = done;
  list[k] = kept;
  writeSchedules(list);
  log(`scheduled web task ${id}: ${result.status}${isChange ? ' (changed)' : ''}`);
  if (isChange && notify && Notification.isSupported()) {
    const n = new Notification({ title: t('StarkLLM: the answer changed'), body: `${s.task.slice(0, 80)}\n${String(result.answer).slice(0, 160)}` });
    n.on('click', () => {
      const main = BrowserWindow.getAllWindows().find((x) => x !== win && !x.isDestroyed());
      if (main) { main.show(); main.focus(); }
    });
    n.show();
  }
  scheduleChanged();
  return { ok: true, schedule: kept, changed: isChange };
}

let scheduleTimer = null;
let scheduleStart = null;
// The main window closed: no more scheduled runs, the one that runs ends now and its hidden window is closed, so
// StarkLLM does not stay open unseen.
function shutdown() {
  if (scheduleStart) { clearTimeout(scheduleStart); scheduleStart = null; }
  if (scheduleTimer) { clearInterval(scheduleTimer); scheduleTimer = null; }
  if (current) {
    current.signal.stopped = true;
    current.signal.preempted = Boolean(current.scheduled);
    if (current.abort) current.abort.abort();
    current.signal.resume();
  }
  stopCommands();
  closeBackgroundWindow();
}

function startScheduler(log) {
  if (scheduleTimer) return;
  const tick = async () => {
    if (current || getShared().isOffline()) return;
    const due = schedule.dueSchedules(readSchedules(), new Date());
    if (due.length) await runScheduled(due[0].id, { log });
  };
  // the first check two minutes after the start (a run missed while the PC was off), then every minute
  scheduleStart = setTimeout(() => { tick().catch(() => {}); }, 120000);
  scheduleTimer = setInterval(() => { tick().catch(() => {}); }, 60000);
}

// IPC for the chat page. fromApp(event) is the same check as for the other bridges: only StarkLLM's own page.
function register(ipcMain, { fromApp, log = () => {} }) {
  const allowed = (fn) => async (event, ...args) => {
    if (!fromApp(event)) return { error: 'not-allowed' };
    try {
      return await fn(event, ...args);
    } catch (e) {
      return { error: 'failed', message: e.message };
    }
  };

  ipcMain.handle('webtask:start', allowed(async (event, opts = {}) => {
    const task = String(opts.task || '').trim().slice(0, 2000);
    const model = String(opts.model || '').trim();
    if (!task) return { error: 'empty' };
    if (!model) return { error: 'no-model' };
    if (current && current.scheduled) {
      userStarting = true; // the user's own task comes first
      try { await stopScheduledRun(); } finally { setTimeout(() => { userStarting = false; }, 2000); }
    }
    if (current) return { error: 'busy' };
    // the terminal: only a folder the user chose in the folder dialog
    let terminal = null;
    if (opts.folder) {
      const folder = String(opts.folder);
      if (!readFolders().includes(folder) || unsuitableFolder(folder) || !fs.existsSync(folder)) return { error: 'folder' };
      terminal = createTerminal({ root: folder, fs, run: runCommand, offline: () => getShared().isOffline() });
    }
    // fully offline: without a project folder there is nothing to do; with one, the folder only (no browser)
    const offline = getShared().isOffline();
    if (offline && !terminal) return { error: 'offline' };
    const id = `t${Date.now()}`;
    // pause: the loop waits before its next step until resume() (or stop) is called
    let wake = null;
    const signal = {
      stopped: false,
      paused: false,
      untilResumed: () => new Promise((resolve) => { if (!signal.paused || signal.stopped) resolve(); else wake = resolve; }),
      resume: () => { signal.paused = false; if (wake) { const w = wake; wake = null; w(); } },
    };
    const sender = event.sender;
    current = { id, signal, sender };
    const send = (e) => { if (!sender.isDestroyed()) sender.send('webtask:event', { id, ...e }); };
    let q = 0;
    const ask = (question) => new Promise((resolve) => {
      const qid = `${id}-q${++q}`;
      pending.set(qid, resolve);
      // a step for the user happens in the browser window: bring it to the front
      if (question.type === 'handoff' && win && !win.isDestroyed()) { win.show(); win.focus(); }
      send({ type: 'ask', qid, ask: question.type, text: question.text, url: question.url || '', kind: question.kind || '', extra: question.extra || null });
    });
    const language = LANGUAGE_NAMES[String(opts.language || '').slice(0, 2)] || 'English';
    // a follow-up: the task before it and its answer (from the chat, so plain text and short)
    const prev = opts.previous && typeof opts.previous === 'object'
      ? { task: String(opts.previous.task || '').slice(0, 2000), answer: String(opts.previous.answer || '').slice(0, 4000) }
      : null;
    send({ type: 'started', task, folder: terminal ? terminal.folderName : '', taskId: id });
    if (terminal) { lastTerminal = terminal; lastTerminalTask = id; }
    const rules = readRules();
    runTask({ task, language, browser: electronBrowser(), llm: ollamaChat(model), ask, emit: send, signal, previous: prev && prev.task ? prev : null,
      siteRule: (host) => rules[host] || rules[host.replace(/^www\./, '')] || '',
      saveSiteRule: (host, rule) => { writeRule(host, rule); rules[host] = rule; },
      terminal, browserOn: !offline })
      .catch((e) => send({ type: 'error', text: e.message }))
      .finally(() => {
        stopCommands();
        current = null;
        for (const resolve of pending.values()) resolve({ ok: false });
        pending.clear();
        send({ type: 'ended' });
        log(`web task ${id} ended`);
      });
    return { ok: true, id };
  }));

  ipcMain.handle('webtask:reply', allowed(async (_event, qid, answer = {}) => {
    const resolve = pending.get(String(qid));
    if (!resolve) return { error: 'unknown' };
    pending.delete(String(qid));
    resolve({ ok: Boolean(answer.ok), text: String(answer.text || '').slice(0, 1000), remember: Boolean(answer.remember) });
    return { ok: true };
  }));

  // The terminal: the user chooses the project folder in the system's folder dialog (StarkLLM never picks one itself)
  ipcMain.handle('webtask:choose-folder', allowed(async (event) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showOpenDialog(parent, { title: t('Choose the project folder for the terminal'), properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { canceled: true };
    const folder = r.filePaths[0];
    const why = unsuitableFolder(folder);
    if (why) return { error: 'unsuitable', why };
    const folders = [folder, ...readFolders().filter((f) => f !== folder)].slice(0, 10);
    fs.writeFileSync(foldersFile(), JSON.stringify(folders, null, 1));
    return { ok: true, folder, name: path.basename(folder) };
  }));

  // "Undo the file changes" of the last task (not while a task runs)
  ipcMain.handle('webtask:undo', allowed(async (_event, taskId) => {
    if (current && !current.scheduled) return { error: 'busy' };
    if (!lastTerminal) return { error: 'nothing' };
    if (taskId && String(taskId) !== lastTerminalTask) return { error: 'not-latest' };
    const files = lastTerminal.undo();
    return { ok: true, files };
  }));
  // Scheduled web tasks: list, add (from a finished web task), pause, run now, remove
  ipcMain.handle('webtask:schedules', allowed(async (event) => {
    scheduleListeners.add(event.sender);
    return { schedules: readSchedules() };
  }));
  ipcMain.handle('webtask:schedule-add', allowed(async (_event, opts = {}) => {
    const list = readSchedules();
    if (list.length >= schedule.MAX_SCHEDULES) return { error: 'too-many' };
    const s = schedule.makeSchedule(opts);
    if (!s) return { error: 'invalid' };
    writeSchedules([...list, s]);
    scheduleChanged();
    return { ok: true, schedule: s };
  }));
  ipcMain.handle('webtask:schedule-enabled', allowed(async (_event, id, enabled) => {
    const list = readSchedules().map((x) => (x.id === String(id) ? { ...x, enabled: Boolean(enabled) } : x));
    writeSchedules(list);
    scheduleChanged();
    return { ok: true };
  }));
  ipcMain.handle('webtask:schedule-remove', allowed(async (_event, id) => {
    writeSchedules(readSchedules().filter((x) => x.id !== String(id)));
    scheduleChanged();
    return { ok: true };
  }));
  ipcMain.handle('webtask:schedule-run', allowed(async (_event, id) => runScheduled(String(id), { log })));
  startScheduler(log);

  // Settings: the user's site rules, to see and remove them
  ipcMain.handle('webtask:sites', allowed(async () => ({ rules: readRules() })));
  ipcMain.handle('webtask:site-rule', allowed(async (_event, host, rule) => {
    const ok = writeRule(host, rule === 'allow' || rule === 'block' ? rule : null);
    return ok ? { ok: true, rules: readRules() } : { error: 'invalid' };
  }));

  // the user takes over: the task waits after its current step; the window comes to the front
  ipcMain.handle('webtask:pause', allowed(async () => {
    if (!current) return { error: 'not-running' };
    current.signal.paused = true;
    if (win && !win.isDestroyed()) { win.show(); win.focus(); }
    return { ok: true };
  }));

  ipcMain.handle('webtask:resume', allowed(async () => {
    if (!current) return { error: 'not-running' };
    current.signal.resume();
    return { ok: true };
  }));

  // "Save the page to the workspace": the text the window shows now (also after a sign-in or a search), for the
  // engine to keep as a document. Only the page of StarkLLM's own window, only when no task runs.
  ipcMain.handle('webtask:page', allowed(async () => {
    if (current) return { error: 'busy' };
    if (!win || win.isDestroyed()) return { error: 'no-window' };
    const wc = win.webContents;
    const url = wc.getURL();
    if (!isWeb(url)) return { error: 'no-page' };
    const text = await inPage(wc, 'window.__starkllm.read()');
    return { url, title: wc.getTitle(), text: String(text || '') };
  }));

  ipcMain.handle('webtask:stop', allowed(async () => {
    if (current) {
      current.signal.stopped = true;
      current.signal.resume(); // a paused task ends too
    }
    stopCommands();
    for (const resolve of pending.values()) resolve({ ok: false });
    pending.clear();
    return { ok: true };
  }));

  ipcMain.handle('webtask:show', allowed(async () => {
    if (win && !win.isDestroyed()) { win.show(); win.focus(); return { ok: true }; }
    return { ok: false };
  }));

  // Settings: forget everything the StarkLLM browser stored (cookies, sign-ins, cache)
  ipcMain.handle('webtask:clear-data', allowed(async () => {
    await session.fromPartition(PARTITION).clearStorageData();
    await session.fromPartition(PARTITION).clearCache();
    return { ok: true };
  }));
}

// the fully offline switch closes a task that runs
function stopForOffline() {
  if (current) {
    current.signal.stopped = true;
    current.signal.resume();
  }
  stopCommands();
}

module.exports = { register, stopForOffline, stopCommands, shutdown, PARTITION, readSchedules, unsuitableFolder: (d) => unsuitableFolder(d) };
