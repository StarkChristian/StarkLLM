// The rules of StarkLLM's browser window (docs/browser-features.md), without Electron, so they are tested with plain
// Node: tabs, keyboard shortcuts, zoom steps, where a link opens, and the user's favourites, history and downloads
// list. webtask.js puts them on the screen.
//
// The favourites, the history and the downloads list belong to the StarkLLM account signed in in the app. They are
// kept in one file per account in the profile folder, encrypted with Windows (seal/unseal: Electron safeStorage, DPAPI),
// like the sessions of paired phones. Without encryption nothing is written: the lists last until StarkLLM closes.
// Nothing here connects to anything, and nothing is synced.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_TABS = 20;
const MAX_CLOSED = 10;
const MAX_FAVOURITES = 1000;
const MAX_HISTORY = 5000;
const MAX_DOWNLOADS = 100;
const MAX_TITLE = 200;
const MAX_URL = 2048;

function isWeb(url) {
  return /^https?:\/\//i.test(String(url || ''));
}

// a web address the lists may keep: http/https, not too long, and never with a user name or password in it
function cleanUrl(url) {
  const s = String(url || '').trim();
  if (!isWeb(s) || s.length > MAX_URL) return '';
  try {
    const u = new URL(s);
    if (u.username || u.password) return '';
    return u.href;
  } catch (e) {
    return '';
  }
}

function cleanTitle(title, url) {
  const s = String(title || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  if (s) return s;
  try { return new URL(url).hostname; } catch (e) { return ''; }
}

// ── Tabs ──
// A tab: { id, kind: 'user' | 'task' }. The Electron side keeps a page view per id; this keeps the order, the active
// tab and the recently closed ones (their addresses, for Ctrl+Shift+T; in memory only).
function createTabs({ max = MAX_TABS } = {}) {
  let list = [];
  let active = null;
  let next = 1;
  const closed = [];
  return {
    get list() { return list.slice(); },
    get active() { return active; },
    get count() { return list.length; },
    full: () => list.length >= max,
    has: (id) => list.some((x) => x.id === id),
    get: (id) => list.find((x) => x.id === id) || null,
    // a new tab after the active one (like Chrome for a link) or at the end; null when the window is full
    add(kind = 'user', { activate = true, afterActive = false } = {}) {
      if (list.length >= max) return null;
      const tab = { id: next++, kind: kind === 'task' ? 'task' : 'user' };
      const k = afterActive ? list.findIndex((x) => x.id === active) : -1;
      if (k >= 0) list.splice(k + 1, 0, tab); else list.push(tab);
      if (activate || active == null) active = tab.id;
      return tab;
    },
    // closes a tab; the next active one is the tab to its right, else to its left (like Chrome)
    remove(id, url = '') {
      const k = list.findIndex((x) => x.id === id);
      if (k < 0) return false;
      const u = cleanUrl(url);
      if (u) { closed.unshift(u); closed.length = Math.min(closed.length, MAX_CLOSED); }
      list.splice(k, 1);
      if (active === id) active = list.length ? list[Math.min(k, list.length - 1)].id : null;
      return true;
    },
    activate(id) {
      if (!list.some((x) => x.id === id)) return false;
      active = id;
      return true;
    },
    // Ctrl+Tab (+1) and Ctrl+Shift+Tab (-1), round
    step(dir) {
      if (!list.length) return null;
      const k = list.findIndex((x) => x.id === active);
      active = list[(k + (dir < 0 ? -1 : 1) + list.length) % list.length].id;
      return active;
    },
    // Ctrl+1 … Ctrl+8: that tab; Ctrl+9: the last one
    nth(n) {
      if (!list.length) return null;
      const tab = n >= 9 ? list[list.length - 1] : list[n - 1];
      if (tab) active = tab.id;
      return tab ? tab.id : null;
    },
    reopen: () => closed.shift() || '',
    setKind(id, kind) {
      const tab = list.find((x) => x.id === id);
      if (tab) tab.kind = kind === 'task' ? 'task' : 'user';
    },
  };
}

// Where a link that asks for a new window (target="_blank", window.open, Ctrl+click) opens. While a task works in
// the tab, in the same page: the task's checks look at that page after each step (2.5.0 acceptance test). For the
// user, a new tab, as in other browsers, unless the window has no room left.
function linkTarget({ taskWorksHere = false, full = false, disposition = '' } = {}) {
  if (taskWorksHere || full) return 'here';
  return disposition === 'background-tab' ? 'background-tab' : 'new-tab';
}

// ── Keyboard ──
// The shortcuts Chrome, Firefox and Opera share. input: Electron's before-input-event ({ type, key, code, control,
// shift, alt, meta }). Returns { action, n? } or null (the page gets the key).
function shortcutOf(input) {
  if (!input || input.type !== 'keyDown') return null;
  const key = String(input.key || '');
  const k = key.length === 1 ? key.toLowerCase() : key;
  const ctrl = Boolean(input.control || input.meta);
  const { shift, alt } = input;
  if (ctrl && !alt) {
    if (k === 't') return { action: shift ? 'reopen-tab' : 'new-tab' };
    if ((k === 'w' || k === 'F4') && !shift) return { action: 'close-tab' };
    if (k === 'Tab') return { action: shift ? 'prev-tab' : 'next-tab' };
    if (k === 'PageDown' && !shift) return { action: 'next-tab' };
    if (k === 'PageUp' && !shift) return { action: 'prev-tab' };
    if (/^[1-9]$/.test(k) && !shift) return { action: 'nth-tab', n: Number(k) };
    if (k === 'l' && !shift) return { action: 'address' };
    if (k === 'f' && !shift) return { action: 'find' };
    if (k === 'g') return { action: shift ? 'find-prev' : 'find-next' };
    if (k === 'd' && !shift) return { action: 'favourite' };
    if (k === 'b' && shift) return { action: 'favourites-bar' };
    if (k === 'o' && shift) return { action: 'favourites' };
    if (k === 'h' && !shift) return { action: 'history' };
    if (k === 'j' && !shift) return { action: 'downloads' };
    if (k === 'r') return { action: 'reload' };
    if (k === '+' || k === '=' || input.code === 'NumpadAdd') return { action: 'zoom-in' };
    if (k === '-' || k === '_' || input.code === 'NumpadSubtract') return { action: 'zoom-out' };
    if ((k === '0' || input.code === 'Numpad0') && !shift) return { action: 'zoom-reset' };
    return null;
  }
  if (alt && !ctrl && !shift) {
    if (k === 'ArrowLeft') return { action: 'back' };
    if (k === 'ArrowRight') return { action: 'forward' };
    if (k === 'Home') return { action: 'home' };
    if (k === 'd') return { action: 'address' };
    return null;
  }
  if (!ctrl && !alt) {
    if (k === 'F5') return { action: 'reload' };
    if (k === 'F6' && !shift) return { action: 'address' };
    if (k === 'F3') return { action: shift ? 'find-prev' : 'find-next' };
  }
  return null;
}

// ── Zoom ── the steps of Chrome, as factors
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

function zoomStep(factor, dir) {
  const f = Number(factor) || 1;
  if (dir === 0) return 1;
  if (dir > 0) return ZOOM_STEPS.find((z) => z > f + 0.001) || ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < f - 0.001) || ZOOM_STEPS[0];
}

// A point the page reader gives in CSS pixels, as a point for the window's mouse events: a zoomed page is scaled, so
// a web task clicks the right element at any zoom.
function pointOf(hit, factor) {
  const f = Number(factor) > 0 ? Number(factor) : 1;
  return { x: Math.round(hit.x * f), y: Math.round(hit.y * f) };
}

// ── Downloads ── programs and scripts: a warning before the save dialog (like the browsers)
const RISKY = new Set(['exe', 'msi', 'msix', 'msixbundle', 'appx', 'appxbundle', 'bat', 'cmd', 'com', 'scr', 'pif', 'cpl', 'ps1', 'psm1', 'vbs', 'vbe',
  'js', 'jse', 'wsf', 'wsh', 'hta', 'jar', 'lnk', 'reg', 'dll', 'sys', 'iso', 'img', 'vhd', 'vhdx', 'application', 'appref-ms', 'url', 'scf', 'inf', 'msp', 'sh']);

function isRiskyFile(name) {
  const m = /\.([a-z0-9-]+)$/i.exec(String(name || '').trim().replace(/[.\s]+$/, ''));
  return Boolean(m && RISKY.has(m[1].toLowerCase()));
}

// What happens to a download a page starts. Only in a tab of the user's window, never while a task works there (a
// task cannot download), never while fully offline; a program or script gets a warning first; then the save dialog,
// in which the user chooses the place (or cancels).
function downloadRule({ userTab = false, taskWorks = false, offline = false, risky = false, allowedOnce = false } = {}) {
  if (!userTab) return { action: 'refuse', why: 'not a tab of the user' };
  if (taskWorks) return { action: 'refuse', why: 'no downloads during a web task' };
  if (offline) return { action: 'refuse', why: 'offline' };
  if (risky && !allowedOnce) return { action: 'warn' };
  return { action: 'save-dialog' };
}

// a file name from a page, safe for the save dialog: no folders, no characters Windows refuses
function safeFileName(name) {
  const s = path.basename(String(name || '').replace(/\\/g, '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 180);
  if (!s || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s)) return 'download';
  return s;
}

// ── The user's lists: favourites, history, downloads ──
function emptyProfile() {
  return { favourites: [], history: [], downloads: [], showBar: true };
}

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

function asList(x) {
  return Array.isArray(x) ? x : [];
}

// what a file may hold, read back defensively (a damaged or changed file gives empty lists, never a crash)
function normalize(data) {
  const p = emptyProfile();
  if (!data || typeof data !== 'object') return p;
  p.favourites = asList(data.favourites).map((f) => f && { id: String(f.id || newId()), url: cleanUrl(f.url), title: cleanTitle(f.title, f.url), at: Number(f.at) || 0 })
    .filter((f) => f && f.url).slice(0, MAX_FAVOURITES);
  p.history = asList(data.history).map((h) => h && { id: String(h.id || newId()), url: cleanUrl(h.url), title: cleanTitle(h.title, h.url), at: Number(h.at) || 0 })
    .filter((h) => h && h.url).slice(0, MAX_HISTORY);
  p.downloads = asList(data.downloads).filter((d) => d && typeof d === 'object').map((d) => ({
    id: String(d.id || newId()), name: safeFileName(d.name), host: String(d.host || '').slice(0, 253), path: String(d.path || ''),
    state: ['progressing', 'completed', 'cancelled', 'interrupted'].includes(d.state) ? (d.state === 'progressing' ? 'interrupted' : d.state) : 'interrupted',
    received: Number(d.received) || 0, total: Number(d.total) || 0, at: Number(d.at) || 0,
  })).slice(0, MAX_DOWNLOADS);
  p.showBar = data.showBar !== false;
  return p;
}

// one file per account, the name a hash of the account (the folder does not list who uses StarkLLM)
function profileFile(dir, account) {
  const h = crypto.createHash('sha256').update(`starkllm-browser:${String(account)}`).digest('hex').slice(0, 32);
  return path.join(dir, `${h}.bin`);
}

// seal(string) -> Buffer and unseal(Buffer) -> string: Windows encryption; null: not available, nothing is written
function createProfile({ dir, account, seal = null, unseal = null, fsx = fs, now = () => Date.now() } = {}) {
  const file = account && dir ? profileFile(dir, account) : '';
  const persistent = Boolean(file && seal && unseal);
  let data = emptyProfile();
  if (persistent) {
    try { data = normalize(JSON.parse(unseal(fsx.readFileSync(file)))); } catch (e) { data = emptyProfile(); }
  }
  let dirty = false;

  function save() {
    if (!persistent || !dirty) return false;
    dirty = false;
    fsx.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fsx.writeFileSync(tmp, seal(JSON.stringify(data)));
    fsx.renameSync(tmp, file);
    return true;
  }
  const changed = () => { dirty = true; };

  return {
    persistent,
    file,
    save,
    get showBar() { return data.showBar; },
    setShowBar(on) { data.showBar = Boolean(on); changed(); },

    favourites: () => data.favourites.slice(),
    isFavourite: (url) => { const u = cleanUrl(url); return Boolean(u && data.favourites.some((f) => f.url === u)); },
    addFavourite(url, title) {
      const u = cleanUrl(url);
      if (!u) return { error: 'invalid' };
      const had = data.favourites.find((f) => f.url === u);
      if (had) return { ok: true, favourite: had };
      if (data.favourites.length >= MAX_FAVOURITES) return { error: 'too-many' };
      const f = { id: newId(), url: u, title: cleanTitle(title, u), at: now() };
      data.favourites.push(f);
      changed();
      return { ok: true, favourite: f };
    },
    // the star: on when the page is not a favourite yet, off when it is
    toggleFavourite(url, title) {
      const u = cleanUrl(url);
      if (!u) return { error: 'invalid' };
      if (data.favourites.some((f) => f.url === u)) {
        data.favourites = data.favourites.filter((f) => f.url !== u);
        changed();
        return { ok: true, on: false };
      }
      const r = this.addFavourite(u, title);
      return r.ok ? { ok: true, on: true } : r;
    },
    editFavourite(id, { title, url } = {}) {
      const f = data.favourites.find((x) => x.id === String(id));
      if (!f) return { error: 'unknown' };
      if (url !== undefined) {
        const u = cleanUrl(url);
        if (!u) return { error: 'invalid' };
        if (data.favourites.some((x) => x.url === u && x.id !== f.id)) return { error: 'exists' };
        f.url = u;
      }
      if (title !== undefined) f.title = cleanTitle(title, f.url);
      changed();
      return { ok: true, favourite: f };
    },
    removeFavourite(id) {
      const n = data.favourites.length;
      data.favourites = data.favourites.filter((f) => f.id !== String(id));
      if (data.favourites.length !== n) changed();
      return { ok: data.favourites.length !== n };
    },
    // dragging in the manager: the favourite to the place of another
    moveFavourite(id, beforeId) {
      const k = data.favourites.findIndex((f) => f.id === String(id));
      if (k < 0) return { error: 'unknown' };
      const [f] = data.favourites.splice(k, 1);
      const j = data.favourites.findIndex((x) => x.id === String(beforeId));
      if (j < 0) data.favourites.push(f); else data.favourites.splice(j, 0, f);
      changed();
      return { ok: true };
    },

    // a page the window showed; the same address twice in a row is one entry (a reload, a title that came later)
    visit(url, title) {
      const u = cleanUrl(url);
      if (!u) return null;
      const last = data.history[0];
      if (last && last.url === u) {
        if (title) last.title = cleanTitle(title, u);
        last.at = now();
        changed();
        return last;
      }
      const h = { id: newId(), url: u, title: cleanTitle(title, u), at: now() };
      data.history.unshift(h);
      if (data.history.length > MAX_HISTORY) data.history.length = MAX_HISTORY;
      changed();
      return h;
    },
    // the title of the newest entry of this address (it often comes after the address)
    titleOf(url, title) {
      const u = cleanUrl(url);
      const h = data.history.find((x) => x.url === u);
      if (h && title) { h.title = cleanTitle(title, u); changed(); }
    },
    history(query = '', limit = 300) {
      const q = String(query || '').toLowerCase().trim();
      const words = q ? q.split(/\s+/) : [];
      return data.history.filter((h) => words.every((w) => h.url.toLowerCase().includes(w) || h.title.toLowerCase().includes(w))).slice(0, limit);
    },
    removeHistory(id) {
      const n = data.history.length;
      data.history = data.history.filter((h) => h.id !== String(id));
      if (data.history.length !== n) changed();
      return { ok: data.history.length !== n };
    },
    clearHistory() {
      data.history = [];
      changed();
      return { ok: true };
    },

    downloads: () => data.downloads.slice(),
    addDownload({ name, host, path: where }) {
      const d = { id: newId(), name: safeFileName(name), host: String(host || '').slice(0, 253), path: String(where || ''), state: 'progressing', received: 0, total: 0, at: now() };
      data.downloads.unshift(d);
      if (data.downloads.length > MAX_DOWNLOADS) data.downloads.length = MAX_DOWNLOADS;
      changed();
      return d;
    },
    updateDownload(id, fields) {
      const d = data.downloads.find((x) => x.id === String(id));
      if (!d) return null;
      for (const k of ['path', 'received', 'total']) if (fields[k] !== undefined) d[k] = k === 'path' ? String(fields[k]) : Number(fields[k]) || 0;
      if (['progressing', 'completed', 'cancelled', 'interrupted'].includes(fields.state)) d.state = fields.state;
      if (fields.name) d.name = safeFileName(fields.name);
      changed();
      return d;
    },
    download: (id) => data.downloads.find((x) => x.id === String(id)) || null,
    removeDownload(id) {
      const n = data.downloads.length;
      data.downloads = data.downloads.filter((d) => d.id !== String(id) || d.state === 'progressing');
      if (data.downloads.length !== n) changed();
      return { ok: data.downloads.length !== n };
    },
    // "Clear the list": the files stay where they are; running downloads stay in the list
    clearDownloads() {
      data.downloads = data.downloads.filter((d) => d.state === 'progressing');
      changed();
      return { ok: true };
    },
  };
}

// The height of the bar above the page: tabs, address bar, the favourites bar when shown, the find row when open.
const HEIGHTS = { tabs: 36, toolbar: 44, favourites: 30, find: 40 };
function topHeight({ favouritesBar = false, find = false } = {}) {
  return HEIGHTS.tabs + HEIGHTS.toolbar + (favouritesBar ? HEIGHTS.favourites : 0) + (find ? HEIGHTS.find : 0);
}

module.exports = {
  MAX_TABS, MAX_FAVOURITES, MAX_HISTORY, MAX_DOWNLOADS, ZOOM_STEPS, HEIGHTS,
  isWeb, cleanUrl, createTabs, linkTarget, shortcutOf, zoomStep, pointOf, isRiskyFile, safeFileName, downloadRule, createProfile, profileFile, normalize, topHeight,
};
