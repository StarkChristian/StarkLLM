// Web tasks (docs/web-tasks.md): StarkLLM's own browser window, in which the local AI model does a task on websites
// while the user watches. The loop and its rules are in webtask-core.js; this file is the Electron part:
//  * a separate window with its own storage ("persist:starkllm-web"): no access to the user's own browser, its
//    sign-ins or its cookies, and none to StarkLLM's own page or token;
//  * every request of the window goes through the network layer (netguard.js, feature "web_task"): recorded in the
//    network log and refused while StarkLLM is fully offline; requests of web pages to this PC or the home network are
//    refused (a page must not reach the engine, Ollama or a router);
//  * no permissions (camera, microphone, location, notifications ...), no pop-up windows; downloads only when the user
//    starts one, with the save dialog, never during a web task;
//  * tabs, favourites, history, find in page, zoom and a downloads list like other browsers (docs/browser-features.md;
//    the rules in browser-core.js); the lists are kept per StarkLLM account, encrypted with Windows;
//  * the AI model is the local Ollama on this PC; the chat page shows each step, asks the user's yes before risky
//    clicks and hands passwords, payments and CAPTCHAs to the user (IPC "webtask:*"); each task works in a tab of its own;
//  * with a project folder the user chose in a folder dialog, the terminal (terminal-core.js): files and commands in
//    that folder only, each change and command after the user's yes, the file changes can be undone afterwards.
//    Commands run as the user, with the user's rights, without the secrets of StarkLLM's own environment;
//  * scheduled web tasks (schedule-core.js) run in a hidden window and only look.
const { app, BrowserWindow, WebContentsView, ipcMain: barIpc, session, dialog, Notification, shell, Menu, clipboard, safeStorage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { runTask } = require('./webtask-core');
const { createTerminal } = require('./terminal-core');
const schedule = require('./schedule-core');
const browser = require('./browser-core');
const { PAGE_SCRIPT } = require('./webtask-page');
const { getShared } = require('./netguard');
const { t, language } = require('./i18n');

const OLLAMA_URL = process.env.STARKLLM_OLLAMA_URL || 'http://127.0.0.1:11434';
const PARTITION = 'persist:starkllm-web';
const START_PAGE = 'https://duckduckgo.com/';
const LANGUAGE_NAMES = { en: 'English', de: 'German', es: 'Spanish', fr: 'French', it: 'Italian', tr: 'Turkish' };

let win = null;
let current = null; // { id, signal, sender, scheduled?, tabId? }
let lastTaskTab = null; // the tab of the last task: a follow-up goes on there
let lastTerminal = null; // the terminal of the last task, for "Undo the file changes"
let lastTerminalTask = '';
const running = new Set(); // child processes of commands that run now
let backgroundRun = false; // a scheduled task runs in a hidden window
let userStarting = false; // the user's own task is starting: no scheduled run begins meanwhile
const pending = new Map(); // question id -> resolve
let sessionReady = false;

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

function isWeb(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

// ── The user's lists (favourites, history, downloads), per StarkLLM account ──
// The account comes from the app page (main.js, after sign-in); another account or signing out closes the window.
let account = '';
let profile = null;
let saveTimer = null;

function sealer() {
  try {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
    if (typeof safeStorage.getSelectedStorageBackend === 'function' && safeStorage.getSelectedStorageBackend() === 'basic_text') return null;
    return { seal: (s) => safeStorage.encryptString(s), unseal: (b) => safeStorage.decryptString(b) };
  } catch (e) {
    return null;
  }
}

function getProfile() {
  if (!profile) {
    const s = sealer();
    profile = browser.createProfile({ dir: path.join(app.getPath('userData'), 'browser'), account, seal: s && s.seal, unseal: s && s.unseal });
  }
  return profile;
}

function saveProfile() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { if (profile) profile.save(); } catch (e) { /* the next change tries again */ }
}

function touched() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProfile, 1500);
}

function setAccount(user) {
  const next = String(user || '');
  if (next === account && profile) return;
  saveProfile();
  if (next !== account && win && !win.isDestroyed()) win.close();
  account = next;
  profile = null;
}

// ── Downloads: only the user's, with the save dialog; never during a web task or a scheduled run ──
const downloadItems = new Map(); // list id -> DownloadItem of this run
const allowedOnce = new Set(); // addresses of risky files the user chose to save anyway

function refuseDownload(event, item, why) {
  event.preventDefault();
  getShared().record({ feature: 'web_task', host: hostOf(item.getURL()), purpose: 'Download in the StarkLLM browser window', outcome: 'blocked', error: why });
}

function onDownload(event, item, wc) {
  const url = item.getURL();
  const tabId = tabOfContents(wc);
  const name = browser.safeFileName(item.getFilename());
  const rule = browser.downloadRule({ userTab: Boolean(win && !win.isDestroyed() && tabId != null), taskWorks: taskWorksIn(tabId),
    offline: getShared().isOffline(), risky: browser.isRiskyFile(name), allowedOnce: allowedOnce.has(url) });
  if (rule.action === 'refuse') return refuseDownload(event, item, rule.why);
  if (rule.action === 'warn') {
    event.preventDefault();
    dialog.showMessageBox(win, {
      type: 'warning',
      title: t('Save the download'),
      message: t('{name} can run programs or change your PC.', { name }),
      detail: t('Only save it if you trust {site}.', { site: hostOf(url) }),
      buttons: [t('Cancel'), t('Save anyway')],
      defaultId: 0,
      cancelId: 0,
    }).then((r) => {
      if (r.response !== 1 || wc.isDestroyed()) return;
      allowedOnce.add(url);
      wc.downloadURL(url);
    }).catch(() => {});
    return undefined;
  }
  allowedOnce.delete(url);
  item.setSaveDialogOptions({ title: t('Save the download'), defaultPath: path.join(app.getPath('downloads'), name) });
  const p = getProfile();
  const d = p.addDownload({ name, host: hostOf(url) });
  downloadItems.set(d.id, item);
  touched();
  let lastSent = 0;
  item.on('updated', (_e, state) => {
    p.updateDownload(d.id, { path: item.getSavePath(), received: item.getReceivedBytes(), total: item.getTotalBytes(), name: path.basename(item.getSavePath() || name),
      state: 'progressing' });
    if (Date.now() - lastSent > 500) { lastSent = Date.now(); sendBar(); }
  });
  item.once('done', (_e, state) => {
    downloadItems.delete(d.id);
    const where = item.getSavePath();
    p.updateDownload(d.id, { path: where, received: item.getReceivedBytes(), total: item.getTotalBytes(), name: where ? path.basename(where) : name,
      state: state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted' });
    // the save dialog was cancelled: nothing was saved, nothing to list
    if (state === 'cancelled' && !where) p.removeDownload(d.id);
    touched();
    sendBar();
  });
  sendBar();
  return undefined;
}

function prepareSession() {
  const ses = session.fromPartition(PARTITION);
  if (sessionReady) return ses;
  sessionReady = true;
  getShared().attachSession(ses, { feature: 'web_task', blockLocal: true });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', onDownload);
  return ses;
}

// A link with target="_blank" or a window.open() of the page while a task works there (2.5.0 acceptance test:
// "Öffnungszeiten" on serviceportal.aachen.de did nothing): never a new window; a web address opens in the same page,
// like a normal click, so it goes through the same checks (will-navigate, the network layer, and the site rules of a
// task, which look at the page after each step). The page is loaded after the handler has returned, not from inside
// it, so the refused new window cannot take the navigation with it. Anything but http/https is dropped.
function openHereHandler(wc, later = setImmediate) {
  return ({ url }) => {
    if (isWeb(url)) {
      later(() => {
        if (!wc.isDestroyed()) wc.loadURL(url).catch(() => {});
      });
    }
    return { action: 'deny' };
  };
}

// The same for a tab of the user's window: a new tab, as in other browsers (browser.linkTarget decides)
function openLinkHandler(wc, tabId, later = setImmediate) {
  const here = openHereHandler(wc, later);
  return (details) => {
    const where = browser.linkTarget({ taskWorksHere: taskWorksIn(tabId), full: tabs.full(), disposition: details.disposition });
    if (where === 'here') return here(details);
    if (isWeb(details.url)) later(() => { if (win && !win.isDestroyed()) newTab('user', details.url, { activate: where === 'new-tab', afterActive: true }); });
    return { action: 'deny' };
  };
}

// "aachen.de" -> https://aachen.de, a web address as it is, anything else -> a DuckDuckGo search
function addressOf(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (!/\s/.test(s) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return `https://${s}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
}

// ── Tabs: one page view per tab under the bar (webtask-bar.html); only the active one is shown ──
const tabs = browser.createTabs();
const views = new Map(); // tab id -> { view, failedUrl }
const ui = { panel: '', find: false, findText: '', findTab: null, found: null };

function viewOf(id) {
  const v = views.get(id);
  return v && !v.view.webContents.isDestroyed() ? v.view.webContents : null;
}

function tabOfContents(wc) {
  for (const [id, v] of views) if (v.view.webContents === wc) return id;
  return null;
}

// the page the user sees now (the hidden window of scheduled runs has no tabs)
function activePage() {
  return tabs.active == null ? null : viewOf(tabs.active);
}

// a task works in this tab now (not paused by the user)
function taskWorksIn(tabId) {
  return Boolean(current && !current.scheduled && current.tabId === tabId && !current.signal.paused);
}

function showsFavouritesBar() {
  const p = getProfile();
  return p.showBar && p.favourites().length > 0;
}

function layout() {
  if (!win || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  const top = browser.topHeight({ favouritesBar: showsFavouritesBar(), find: ui.find });
  for (const [id, v] of views) {
    const shown = id === tabs.active && !ui.panel;
    v.view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) });
    v.view.setVisible(shown);
  }
}

function titleOfTab(id) {
  const wc = viewOf(id);
  if (!wc) return '';
  const url = wc.getURL();
  const v = views.get(id);
  return wc.getTitle() && !/^data:/.test(url) ? wc.getTitle() : hostOf(v && v.failedUrl ? v.failedUrl : url) || t('New tab');
}

function urlOfTab(id) {
  const wc = viewOf(id);
  if (!wc) return '';
  const now = wc.getURL();
  const v = views.get(id);
  if (isWeb(now) && v) v.failedUrl = '';
  return now.startsWith('data:') && v && v.failedUrl ? v.failedUrl : now;
}

function words() {
  return {
    back: t('Back'), forward: t('Forward'), reload: t('Reload'), stop: t('Stop loading'), home: t('Start page'),
    placeholder: t('Search or enter a web address'), working: t('StarkLLM is working here'), paused: t('You have taken over'),
    newTab: t('New tab'), closeTab: t('Close tab'), taskTab: t('Web task'),
    addFavourite: t('Add to favourites'), removeFavourite: t('Remove from favourites'),
    favourites: t('Favourites'), history: t('History'), downloads: t('Downloads'), menu: t('Menu'),
    external: t('Open in your browser'), zoomReset: t('Reset zoom'), zoomIn: t('Zoom in'), zoomOut: t('Zoom out'),
    find: t('Find in page'), findNext: t('Next'), findPrev: t('Previous'), findOf: t('{n} of {total}'), noMatches: t('No matches'),
    close: t('Close'), showBar: t('Show the favourites bar'), hideBar: t('Hide the favourites bar'),
    manageFavourites: t('Manage favourites'), noFavourites: t('No favourites yet. The star in the address bar adds the page you see.'),
    name: t('Name'), address: t('Address'), save: t('Save'), cancel: t('Cancel'), remove: t('Remove'), edit: t('Edit'),
    searchHistory: t('Search the history'), clearHistory: t('Clear history'), clearHistoryAsk: t('Clear the whole history of this browser window? Favourites stay.'),
    noHistory: t('No pages in the history.'), today: t('Today'), yesterday: t('Yesterday'),
    noDownloads: t('No downloads. Files are only downloaded when you start a download and choose the place.'),
    showInFolder: t('Show in folder'), clearList: t('Clear the list'), downloading: t('Downloading'), done: t('Done'),
    cancelled: t('Cancelled'), failed: t('Failed'), privateNote: t('Kept on this PC only, for your StarkLLM account, encrypted.'),
    notKept: t('Windows encryption is not available: these lists are kept until StarkLLM closes.'),
    invalidAddress: t('Only web addresses (http or https) can be saved.'),
  };
}

function barState() {
  if (!win || win.isDestroyed()) return null;
  const wc = activePage();
  const h = wc && wc.navigationHistory;
  const p = getProfile();
  const url = tabs.active == null ? '' : urlOfTab(tabs.active);
  const taskTabState = (id) => (current && !current.scheduled && current.tabId === id ? (current.signal.paused ? 'paused' : 'running') : '');
  return {
    tabs: tabs.list.map((x) => {
      const pc = viewOf(x.id);
      return { id: x.id, title: titleOfTab(x.id), url: urlOfTab(x.id), loading: Boolean(pc && pc.isLoading()), task: taskTabState(x.id) };
    }),
    active: tabs.active,
    url,
    title: wc ? wc.getTitle() : '',
    loading: Boolean(wc && wc.isLoading()),
    canBack: Boolean(h && h.canGoBack()),
    canForward: Boolean(h && h.canGoForward()),
    task: tabs.active != null ? taskTabState(tabs.active) : '',
    starred: p.isFavourite(url),
    zoom: wc ? Math.round(wc.getZoomFactor() * 100) : 100,
    favourites: p.favourites(),
    favouritesBar: showsFavouritesBar(),
    showBar: p.showBar,
    downloads: p.downloads(),
    kept: p.persistent,
    panel: ui.panel,
    find: ui.find,
    found: ui.found,
    heights: browser.HEIGHTS,
    lang: language(),
    words: words(),
  };
}

function sendBar() {
  const s = barState();
  if (s && !win.webContents.isDestroyed()) win.webContents.send('webbar:state', s);
  if (s && tabs.active != null) win.setTitle(`${titleOfTab(tabs.active)} · ${t('StarkLLM web task')}`);
}

// the user uses the window while a task runs: the task waits (like "Take over"); a step it is doing now finishes first
// (at most 15 s), so it cannot type into the page the user opens
async function userTakesOver() {
  if (!current || current.scheduled) return;
  if (!current.signal.paused) {
    current.signal.paused = true;
    sendBar();
  }
  const until = Date.now() + 15000;
  while (current && !current.atPause && !current.signal.stopped && Date.now() < until) await sleep(100);
}

// the user acts on this tab (navigates it): a task working there waits
async function userUses(tabId) {
  if (taskWorksIn(tabId)) await userTakesOver();
}

// the task's tab goes out of sight (another tab, a panel): the task waits, it never works in a hidden tab
async function userLeavesTask() {
  if (current && !current.scheduled && tabs.active === current.tabId && taskWorksIn(current.tabId)) await userTakesOver();
}

function setupPage(view, id) {
  const wc = view.webContents;
  for (const e of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated']) wc.on(e, () => sendBar());
  wc.on('did-fail-load', (_event, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !isWeb(url)) return;   // -3: the user or a new address stopped it
    const offline = getShared().isOffline();
    const local = !offline && /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(hostOf(url));
    const text = offline ? t('StarkLLM is fully offline: web pages are not opened.')
      : local ? t('StarkLLM\'s browser does not open pages of this PC or your home network (for example your router).')
        : t('This page could not be opened.');
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const html = `<!doctype html><meta charset="utf-8"><title>${esc(t('Not opened'))}</title>`
      + '<body style="font:15px Segoe UI,system-ui,sans-serif;margin:48px;color:#1c2230;background:#f3f4f8">'
      + `<h2 style="margin:0 0 12px">${esc(t('Not opened'))}</h2><p>${esc(text)}</p><p style="color:#5b6478;word-break:break-all">${esc(url)}</p>`;
    const v = views.get(id);
    if (v) v.failedUrl = url;
    wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
  });
  // the history of this window: the pages the user and the tasks opened in it (not the hidden scheduled runs)
  wc.on('did-navigate', (_event, url) => { if (getProfile().visit(url, '')) touched(); });
  wc.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame && getProfile().visit(url, wc.getTitle())) touched(); });
  wc.on('page-title-updated', (_event, title) => { getProfile().titleOf(wc.getURL(), title); touched(); });
  // links that would open a new window: a new tab, or the same page while a task works there
  wc.setWindowOpenHandler(openLinkHandler(wc, id));
  wc.on('will-navigate', (event, url) => { if (!isWeb(url)) event.preventDefault(); });
  wc.on('before-input-event', (event, input) => {
    const s = browser.shortcutOf(input);
    if (s) { event.preventDefault(); command(s.action, s.n).catch(() => {}); }
  });
  // Ctrl + mouse wheel
  wc.on('zoom-changed', (_event, dir) => { command(dir === 'in' ? 'zoom-in' : 'zoom-out').catch(() => {}); });
  wc.on('found-in-page', (_event, r) => {
    if (r.finalUpdate) { ui.found = { n: r.activeMatchOrdinal, total: r.matches }; sendBar(); }
  });
  wc.on('context-menu', (_event, params) => contextMenu(wc, id, params));
}

function newTab(kind = 'user', url = '', { activate = true, afterActive = false } = {}) {
  if (!win || win.isDestroyed()) return null;
  const tab = tabs.add(kind, { activate, afterActive });
  if (!tab) return null;
  const view = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
  views.set(tab.id, { view, failedUrl: '' });
  win.contentView.addChildView(view);
  setupPage(view, tab.id);
  if (activate) { ui.found = null; if (ui.find) view.webContents.stopFindInPage('clearSelection'); }
  layout();
  if (isWeb(url)) view.webContents.loadURL(url).catch(() => {});
  sendBar();
  return tab.id;
}

function closeTab(id) {
  const v = views.get(id);
  if (!v) return;
  // closing the tab of a task ends the task, like closing the window
  if (current && !current.scheduled && current.tabId === id) { current.signal.stopped = true; current.signal.resume(); }
  if (lastTaskTab === id) lastTaskTab = null;
  const wc = v.view.webContents;
  tabs.remove(id, wc.isDestroyed() ? '' : urlOfTab(id));
  views.delete(id);
  if (win && !win.isDestroyed()) win.contentView.removeChildView(v.view);
  if (!wc.isDestroyed()) wc.close();
  if (!tabs.count) { if (win && !win.isDestroyed()) win.close(); return; }
  ui.found = null;
  layout();
  sendBar();
}

function activateTab(id) {
  if (!tabs.activate(id)) return;
  const old = activePage();
  if (old && ui.find) old.stopFindInPage('clearSelection');
  ui.found = null;
  layout();
  sendBar();
}

function focusBar(what) {
  if (!win || win.isDestroyed()) return;
  win.webContents.focus();
  win.webContents.send('webbar:focus', what);
}

function zoomPage(wc, dir) {
  if (!wc) return;
  wc.setZoomFactor(browser.zoomStep(wc.getZoomFactor(), dir));
  sendBar();
}

// a new text starts a new search (findNext: true in Electron's words); the same text again goes to the next match
function find(text, forward = true) {
  const wc = activePage();
  const next = String(text || '').slice(0, 500);
  const fresh = next !== ui.findText || ui.findTab !== tabs.active;
  ui.findText = next;
  ui.findTab = tabs.active;
  if (!wc) return;
  if (!next) { wc.stopFindInPage('clearSelection'); ui.found = null; sendBar(); return; }
  wc.findInPage(next, { forward, findNext: fresh });
}

// the ⋮ menu of the bar: a menu of Windows, so it is never hidden behind the page
function barMenu() {
  if (!win || win.isDestroyed()) return;
  const p = getProfile();
  const url = tabs.active != null ? urlOfTab(tabs.active) : '';
  const run = (action) => () => { command(action).catch(() => {}); };
  Menu.buildFromTemplate([
    { label: t('New tab'), accelerator: 'CmdOrCtrl+T', click: run('new-tab') },
    { label: t('Reopen closed tab'), accelerator: 'CmdOrCtrl+Shift+T', click: run('reopen-tab') },
    { type: 'separator' },
    { label: p.isFavourite(url) ? t('Remove from favourites') : t('Add to favourites'), accelerator: 'CmdOrCtrl+D', enabled: isWeb(url), click: run('favourite') },
    { label: t('Manage favourites'), accelerator: 'CmdOrCtrl+Shift+O', click: run('favourites') },
    { label: p.showBar ? t('Hide the favourites bar') : t('Show the favourites bar'), accelerator: 'CmdOrCtrl+Shift+B', click: run('favourites-bar') },
    { type: 'separator' },
    { label: t('History'), accelerator: 'CmdOrCtrl+H', click: run('history') },
    { label: t('Downloads'), accelerator: 'CmdOrCtrl+J', click: run('downloads') },
    { type: 'separator' },
    { label: t('Find in page'), accelerator: 'CmdOrCtrl+F', enabled: isWeb(url), click: run('find') },
    { label: t('Zoom in'), accelerator: 'CmdOrCtrl+=', click: run('zoom-in') },
    { label: t('Zoom out'), accelerator: 'CmdOrCtrl+-', click: run('zoom-out') },
    { label: t('Reset zoom'), accelerator: 'CmdOrCtrl+0', click: run('zoom-reset') },
    { type: 'separator' },
    { label: t('Open in your browser'), enabled: isWeb(url), click: () => openExternal(url) },
  ]).popup({ window: win });
}

function setPanel(name) {
  ui.panel = ['favourites', 'history', 'downloads'].includes(name) ? name : '';
  layout();
  sendBar();
}

function openExternal(url) {
  if (isWeb(url)) shell.openExternal(url).catch(() => {});
}

// What a shortcut, a button of the bar or the menu does. Navigation in the task's tab, or hiding it, makes the task wait.
async function command(action, arg) {
  if (!win || win.isDestroyed()) return;
  const id = tabs.active;
  const wc = activePage();
  switch (action) {
    case 'new-tab': await userLeavesTask(); setPanel(''); newTab('user'); focusBar('address'); break;
    case 'reopen-tab': { const u = tabs.reopen(); if (u) { await userLeavesTask(); newTab('user', u); } break; }
    case 'close-tab': if (id != null) closeTab(id); break;
    case 'next-tab': case 'prev-tab': await userLeavesTask(); tabs.step(action === 'next-tab' ? 1 : -1); activateTab(tabs.active); break;
    case 'nth-tab': await userLeavesTask(); tabs.nth(Number(arg) || 1); activateTab(tabs.active); break;
    case 'address': focusBar('address'); break;
    case 'find': ui.find = true; layout(); sendBar(); focusBar('find'); break;
    case 'find-next': case 'find-prev':
      if (!ui.find || !ui.findText) { ui.find = true; layout(); sendBar(); focusBar('find'); } else find(ui.findText, action === 'find-next');
      break;
    case 'favourite': if (wc) { const r = getProfile().toggleFavourite(urlOfTab(id), wc.getTitle()); if (r.ok) { touched(); layout(); sendBar(); } } break;
    case 'favourites-bar': getProfile().setShowBar(!getProfile().showBar); touched(); layout(); sendBar(); break;
    case 'favourites': case 'history': case 'downloads': if (ui.panel === action) setPanel(''); else { await userLeavesTask(); setPanel(action); } break;
    case 'reload': if (wc) { await userUses(id); wc.reload(); } break;
    case 'back': if (wc && wc.navigationHistory.canGoBack()) { await userUses(id); wc.navigationHistory.goBack(); } break;
    case 'forward': if (wc && wc.navigationHistory.canGoForward()) { await userUses(id); wc.navigationHistory.goForward(); } break;
    case 'home': if (wc) { await userUses(id); wc.loadURL(START_PAGE).catch(() => {}); } break;
    case 'zoom-in': zoomPage(wc, 1); break;
    case 'zoom-out': zoomPage(wc, -1); break;
    case 'zoom-reset': zoomPage(wc, 0); break;
    case 'menu': barMenu(); break;
    default: break;
  }
}

function contextMenu(wc, id, params) {
  if (!win || win.isDestroyed()) return;
  const items = [];
  const link = isWeb(params.linkURL) ? params.linkURL : '';
  if (link) {
    items.push({ label: t('Open link in new tab'), click: () => newTab('user', link, { activate: false, afterActive: true }) });
    items.push({ label: t('Copy link address'), click: () => clipboard.writeText(link) });
    items.push({ type: 'separator' });
  }
  if (params.mediaType === 'image' && isWeb(params.srcURL)) {
    items.push({ label: t('Save image as…'), click: () => wc.downloadURL(params.srcURL) });
    items.push({ type: 'separator' });
  }
  if (params.isEditable) {
    items.push({ label: t('Cut'), role: 'cut', enabled: params.editFlags.canCut });
    items.push({ label: t('Copy'), role: 'copy', enabled: params.editFlags.canCopy });
    items.push({ label: t('Paste'), role: 'paste', enabled: params.editFlags.canPaste });
    items.push({ label: t('Select all'), role: 'selectAll' });
    items.push({ type: 'separator' });
  } else if (params.selectionText) {
    items.push({ label: t('Copy'), role: 'copy' });
    items.push({ type: 'separator' });
  }
  const h = wc.navigationHistory;
  items.push({ label: t('Back'), enabled: h.canGoBack(), click: () => command('back') });
  items.push({ label: t('Forward'), enabled: h.canGoForward(), click: () => command('forward') });
  items.push({ label: t('Reload'), click: () => command('reload') });
  if (isWeb(urlOfTab(id))) items.push({ label: t('Open in your browser'), click: () => openExternal(urlOfTab(id)) });
  Menu.buildFromTemplate(items).popup({ window: win });
}

let barReady = false;
function registerBar() {
  if (barReady) return;
  barReady = true;
  const fromBar = (event) => win && !win.isDestroyed() && event.sender === win.webContents;
  barIpc.on('webbar:go', async (event, what) => {
    if (!fromBar(event)) return;
    if (what === 'refresh') return sendBar();
    const wc = activePage();
    if (what === 'stop') { if (wc) wc.stop(); return sendBar(); }
    if (['back', 'forward', 'reload', 'home'].includes(what)) await command(what);
    return sendBar();
  });
  barIpc.on('webbar:open', async (event, text, newTabToo) => {
    if (!fromBar(event)) return;
    const url = addressOf(text);
    if (!isWeb(url) || !win || win.isDestroyed()) return;
    if (newTabToo || tabs.active == null) { await userLeavesTask(); setPanel(''); newTab('user', url); return; }
    await userUses(tabs.active);
    setPanel('');
    const wc = activePage();
    if (wc) wc.loadURL(url).catch(() => {});
    sendBar();
  });
  // the other buttons of the bar: tabs, favourites, history, downloads, find, zoom, panels, the system browser
  barIpc.on('webbar:act', async (event, what, arg = {}) => {
    if (!fromBar(event)) return;
    const a = arg && typeof arg === 'object' ? arg : {};
    const p = getProfile();
    const id = Number(a.id);
    switch (String(what)) {
      case 'activate':
        if (tabs.has(id) && id !== tabs.active) {
          if (!(current && current.tabId === id)) await userLeavesTask();
          setPanel('');
          activateTab(id);
        }
        break;
      case 'close': if (tabs.has(id)) closeTab(id); break;
      case 'find': find(a.text, a.forward !== false); break;
      case 'find-close': { ui.find = false; ui.found = null; ui.findText = ''; const wc = activePage(); if (wc) wc.stopFindInPage('clearSelection'); layout(); sendBar(); break; }
      case 'panel': if (a.name) await userLeavesTask(); setPanel(String(a.name || '')); break;
      case 'external': if (tabs.active != null) openExternal(urlOfTab(tabs.active)); break;
      case 'fav-edit': p.editFavourite(String(a.fav || ''), { title: a.title === undefined ? undefined : String(a.title), url: a.url === undefined ? undefined : String(a.url) }); touched(); break;
      case 'fav-remove': p.removeFavourite(String(a.fav || '')); touched(); layout(); break;
      case 'fav-move': p.moveFavourite(String(a.fav || ''), String(a.before || '')); touched(); break;
      case 'history-remove': p.removeHistory(String(a.entry || '')); touched(); break;
      case 'history-clear': p.clearHistory(); touched(); break;
      case 'download-show': {
        const d = p.download(String(a.download || ''));
        if (d && d.path && fs.existsSync(d.path)) shell.showItemInFolder(d.path);
        break;
      }
      case 'download-cancel': { const item = downloadItems.get(String(a.download || '')); if (item) item.cancel(); break; }
      case 'download-remove': p.removeDownload(String(a.download || '')); touched(); break;
      case 'downloads-clear': p.clearDownloads(); touched(); break;
      // a favourite or a history entry: in this tab, or in a new one (Ctrl+click, middle click)
      case 'open-url': {
        const url = browser.cleanUrl(a.url);
        if (!url) break;
        setPanel('');
        if (a.newTab || tabs.active == null) { await userLeavesTask(); newTab('user', url, { activate: !a.background, afterActive: true }); break; }
        await userUses(tabs.active);
        const wc = activePage();
        if (wc) wc.loadURL(url).catch(() => {});
        break;
      }
      default: await command(String(what), a.n); return;
    }
    sendBar();
  });
  // the history panel asks for the entries that match its search field
  barIpc.handle('webbar:history', (event, query) => (fromBar(event) ? getProfile().history(String(query || '').slice(0, 200)) : []));
}

// open StarkLLM's browser for the user's own use (no task): the start page in a tab
function openBrowserForUser() {
  const w = openWindow();
  if (!tabs.count) newTab('user', START_PAGE);
  w.show();
  w.focus();
  return { ok: true };
}

function openWindow() {
  if (win && !win.isDestroyed()) return win;
  prepareSession();
  registerBar();
  getProfile();
  win = new BrowserWindow({
    width: 1180,
    height: 860 + browser.topHeight({}),
    show: !backgroundRun,
    title: t('StarkLLM web task'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'webtask-bar-preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  win.webContents.loadFile(path.join(__dirname, 'webtask-bar.html')).catch(() => {});
  // the bar never navigates anywhere
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // the shortcuts work in the bar too (Ctrl+T in the address field)
  win.webContents.on('before-input-event', (event, input) => {
    const s = browser.shortcutOf(input);
    if (s) { event.preventDefault(); command(s.action, s.n).catch(() => {}); }
  });
  win.on('resize', layout);
  win.on('page-title-updated', (event) => event.preventDefault());
  const own = win;
  win.on('closed', () => {
    for (const v of views.values()) if (!v.view.webContents.isDestroyed()) v.view.webContents.close();
    views.clear();
    for (const x of tabs.list) tabs.remove(x.id);
    lastTaskTab = null;
    Object.assign(ui, { panel: '', find: false, findText: '', found: null });
    if (win === own) win = null;
    if (current && !current.scheduled) current.signal.stopped = true; // closing the window ends the task
    for (const resolve of pending.values()) resolve({ ok: false });
    pending.clear();
    saveProfile();
  });
  return win;
}

// the tab a task works in: its own, made when the task first opens a page; a follow-up goes on in the tab before
function taskPage() {
  const w = openWindow();
  if (!current || current.scheduled) return activePage() || viewOf(newTab('user'));
  if (current.tabId == null || !tabs.has(current.tabId)) {
    current.tabId = newTab('task');
    if (!w.isVisible()) w.show();
  }
  return viewOf(current.tabId);
}

// the task's tab to the front (the task starts, goes on after "Hand back", or needs the user there)
function showTaskTab() {
  if (!current || current.tabId == null || !tabs.has(current.tabId)) return;
  setPanel('');
  activateTab(current.tabId);
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
  wc.setWindowOpenHandler(openHereHandler(wc));
  wc.on('will-navigate', (event, url) => { if (!isWeb(url)) event.preventDefault(); });
  bgWin.on('closed', () => { bgWin = null; });
  return bgWin;
}

function closeBackgroundWindow() {
  if (bgWin && !bgWin.isDestroyed()) bgWin.destroy();
  bgWin = null;
}

// the page a task works on: the hidden window of a scheduled run, or the task's own tab in the user's window
function electronBrowser(getWindow = null) {
  const hidden = Boolean(getWindow);
  const w = () => (hidden ? getWindow().webContents : taskPage());
  return {
    // a follow-up task continues on the page of the task before (its tab, if the user did not close it)
    hasPage: () => {
      if (hidden) return Boolean(bgWin && !bgWin.isDestroyed() && isWeb(bgWin.webContents.getURL()));
      const wc = current && current.tabId != null ? viewOf(current.tabId) : null;
      return Boolean(wc && isWeb(wc.getURL()));
    },
    async open(url) {
      const wc = w();
      if (!hidden && win && !win.isVisible()) win.show();
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
      const h = await inPage(wc, `window.__starkllm.hit(${Number(i)})`);
      const before = wc.getURL();
      const link = await inPage(wc, `window.__starkllm.linkOf(${Number(i)})`).catch(() => null);
      if (h && h.ok) {
        // the page reader measures in CSS pixels; a zoomed tab needs window pixels
        const { x, y } = browser.pointOf(h, wc.getZoomFactor());
        wc.sendInputEvent({ type: 'mouseMove', x, y });
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      } else {
        // something else is at that point (a banner, a page still scrolling): click the element itself
        if (!(await inPage(wc, `window.__starkllm.clickHere(${Number(i)})`))) throw new Error('the element is no longer on the page');
      }
      await settle(wc);
      // a link that the click did not follow (MSI §43: the page stayed where it was): click it inside the page
      if (link && h && h.ok && !wc.isDestroyed() && wc.getURL() === before
          && (await inPage(wc, `window.__starkllm.clickHere(${Number(i)})`).catch(() => false))) {
        await settle(wc);
      }
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
    const send = (e) => {
      if (!sender.isDestroyed()) sender.send('webtask:event', { id, ...e });
      // the loop is waiting at its pause point (nothing of the task acts on the page now)
      if (current && current.id === id && (e.type === 'paused' || e.type === 'resumed')) current.atPause = e.type === 'paused';
      if (['started', 'paused', 'resumed', 'ended'].includes(e.type)) sendBar();
    };
    let q = 0;
    const ask = (question) => new Promise((resolve) => {
      const qid = `${id}-q${++q}`;
      pending.set(qid, resolve);
      // a step for the user happens in the browser window: bring it to the front
      if (question.type === 'handoff' && win && !win.isDestroyed()) { showTaskTab(); win.show(); win.focus(); }
      send({ type: 'ask', qid, ask: question.type, text: question.text, url: question.url || '', kind: question.kind || '', extra: question.extra || null });
    });
    const language = LANGUAGE_NAMES[String(opts.language || '').slice(0, 2)] || 'English';
    // a follow-up: the task before it and its answer (from the chat, so plain text and short)
    const prev = opts.previous && typeof opts.previous === 'object'
      ? { task: String(opts.previous.task || '').slice(0, 2000), answer: String(opts.previous.answer || '').slice(0, 4000) }
      : null;
    // each task works in a tab of its own (made when it opens its first page); a follow-up goes on in the tab of the
    // task before, if it is still open. A new task does not see the page of an earlier one.
    if (prev && prev.task && lastTaskTab != null && tabs.has(lastTaskTab)) {
      current.tabId = lastTaskTab;
      tabs.setKind(lastTaskTab, 'task');
      showTaskTab();
    }
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
        if (current && current.id === id && current.tabId != null && tabs.has(current.tabId)) lastTaskTab = current.tabId;
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
    // the task goes on in its own tab, in sight (not behind another tab or a panel)
    showTaskTab();
    current.signal.resume();
    sendBar();
    return { ok: true };
  }));

  // the user's own use of StarkLLM's browser (the web task chip in the chat)
  ipcMain.handle('webtask:open-browser', allowed(async () => (getShared().isOffline() ? { error: 'offline' } : openBrowserForUser())));

  // "Save the page to the workspace": the text the window shows now (also after a sign-in or a search), for the
  // engine to keep as a document. Only the page of StarkLLM's own window, only when no task runs.
  ipcMain.handle('webtask:page', allowed(async () => {
    if (current) return { error: 'busy' };
    if (!win || win.isDestroyed()) return { error: 'no-window' };
    const wc = activePage();
    const url = wc ? wc.getURL() : '';
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

module.exports = { register, stopForOffline, stopCommands, shutdown, PARTITION, readSchedules, unsuitableFolder: (d) => unsuitableFolder(d), addressOf, openHereHandler,
  refreshBar: () => sendBar(), setAccount, saveProfile };
