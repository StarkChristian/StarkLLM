// Web tasks (docs/web-tasks.md): StarkLLM's own browser window, in which the local AI model does a task on websites
// while the user watches. The loop and its rules are in webtask-core.js; this file is the Electron part:
//  * a separate window with its own storage ("persist:starkllm-web"): no access to the user's own browser, its
//    sign-ins or its cookies, and none to StarkLLM's own page or token;
//  * every request of the window goes through the network layer (netguard.js, feature "web_task"): recorded in the
//    network log and refused while StarkLLM is fully offline; requests of web pages to this PC or the home network are
//    refused (a page must not reach the engine, Ollama or a router);
//  * no permissions (camera, microphone, location, notifications ...), no downloads, no pop-up windows;
//  * the AI model is the local Ollama on this PC; the chat page shows each step, asks the user's yes before risky
//    clicks and hands passwords, payments and CAPTCHAs to the user (IPC "webtask:*").
const { BrowserWindow, session } = require('electron');
const { runTask } = require('./webtask-core');
const { PAGE_SCRIPT } = require('./webtask-page');
const { getShared } = require('./netguard');
const i18n = require('./i18n');

const OLLAMA_URL = process.env.STARKLLM_OLLAMA_URL || 'http://127.0.0.1:11434';
const PARTITION = 'persist:starkllm-web';
const LANGUAGE_NAMES = { en: 'English', de: 'German', es: 'Spanish', fr: 'French', it: 'Italian', tr: 'Turkish' };

let win = null;
let current = null; // { id, signal, sender }
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
    title: i18n.t('StarkLLM web task'),
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
    if (!win.isDestroyed()) win.setTitle(`${title} · ${i18n.t('StarkLLM web task')}`);
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

async function inPage(wc, expression) {
  await wc.executeJavaScript(PAGE_SCRIPT, false);
  return wc.executeJavaScript(expression, false);
}

function electronBrowser() {
  const w = () => {
    const x = openWindow();
    return x.webContents;
  };
  let opened = false;
  return {
    hasPage: () => opened && win && !win.isDestroyed(),
    async open(url) {
      const wc = w();
      if (!win.isVisible()) win.show();
      await wc.loadURL(url).catch((e) => {
        // a page that redirects or stops early still counts; a blocked request (offline) does not
        if (getShared().isOffline()) {
          const err = new Error(i18n.t('StarkLLM is fully offline: web tasks are off.'));
          err.code = 'STARKLLM_OFFLINE';
          throw err;
        }
        if (!/ERR_ABORTED/.test(String(e && e.message))) throw e;
      });
      opened = true;
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
  };
}

// The local AI model (Ollama on this PC). Recorded by the network layer like every connection of the app.
function ollamaChat(model) {
  const post = getShared().wrapFetch(fetch, 'web_task', 'The local AI model (Ollama on this PC) chooses the next step of a web task');
  return async (messages, tools) => {
    const res = await post(OLLAMA_URL + '/api/chat', {
      method: 'POST',
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
    if (getShared().isOffline()) return { error: 'offline' };
    if (current) return { error: 'busy' };
    const id = `t${Date.now()}`;
    const signal = { stopped: false };
    const sender = event.sender;
    current = { id, signal, sender };
    const send = (e) => { if (!sender.isDestroyed()) sender.send('webtask:event', { id, ...e }); };
    let q = 0;
    const ask = (question) => new Promise((resolve) => {
      const qid = `${id}-q${++q}`;
      pending.set(qid, resolve);
      // a step for the user happens in the browser window: bring it to the front
      if (question.type === 'handoff' && win && !win.isDestroyed()) { win.show(); win.focus(); }
      send({ type: 'ask', qid, ask: question.type, text: question.text, url: question.url || '' });
    });
    const language = LANGUAGE_NAMES[String(opts.language || '').slice(0, 2)] || 'English';
    send({ type: 'started', task });
    runTask({ task, language, browser: electronBrowser(), llm: ollamaChat(model), ask, emit: send, signal })
      .catch((e) => send({ type: 'error', text: e.message }))
      .finally(() => {
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
    resolve({ ok: Boolean(answer.ok), text: String(answer.text || '').slice(0, 1000) });
    return { ok: true };
  }));

  ipcMain.handle('webtask:stop', allowed(async () => {
    if (current) current.signal.stopped = true;
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
  if (current) current.signal.stopped = true;
}

module.exports = { register, stopForOffline, PARTITION };
