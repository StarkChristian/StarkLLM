// The bar of StarkLLM's browser window (webtask.js): tabs, back, forward, reload/stop, home, the address with zoom and
// the favourite star, what the running task does, the favourites bar, find in page, and the panels for favourites,
// history and downloads. It only asks the desktop app (webtask-bar-preload.js); it has no network and no Node.
// Everything is built with textContent (page titles are not trusted).
const $ = (id) => document.getElementById(id);
const bar = window.starkllmBar;
let editing = false;
let words = {};
let state = null;
let editFav = '';
let favError = '';
let askClear = false;
let historyQuery = '';
let historyTimer = null;

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

const ICONS = {
  close: 'M18 6L6 18M6 6l12 12',
  edit: 'M4 20h4L19 9l-4-4L4 16z',
  folder: 'M3 6h6l2 2h10v11H3z',
};
// a copy of an icon of the page (one path) with another drawing
function icon(name) {
  const svg = $('findClose').firstElementChild.cloneNode(true);
  svg.firstElementChild.setAttribute('d', ICONS[name]);
  return svg;
}

const hostOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
const letterOf = (url, title) => (hostOf(url) || title || '·').slice(0, 1);
const fill = (text, values) => String(text || '').replace(/\{(\w+)\}/g, (m, k) => (k in values ? values[k] : m));

// a click with Ctrl or the middle button opens in a new tab
function openUrl(url, e) {
  bar.act('open-url', { url, newTab: Boolean(e && (e.ctrlKey || e.metaKey || e.button === 1)), background: Boolean(e && e.button === 1) });
}

function showTabs(s) {
  const strip = $('tabs');
  for (const old of [...strip.querySelectorAll('.tab')]) old.remove();
  for (const tab of s.tabs) {
    const letter = el('span', { class: `letter${tab.loading ? ' loading' : ''}${tab.task ? ` task${tab.task === 'paused' ? ' paused' : ''}` : ''}` }, letterOf(tab.url, tab.title));
    const close = el('button', { title: words.closeTab, onclick: (e) => { e.stopPropagation(); bar.act('close', { id: tab.id }); } }, icon('close'));
    const node = el('div', {
      class: `tab${tab.id === s.active ? ' on' : ''}`, tabindex: '0', role: 'tab', 'aria-selected': String(tab.id === s.active),
      title: tab.task ? `${tab.title} · ${words.taskTab}` : tab.title,
      onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); bar.act('close', { id: tab.id }); } else if (e.button === 0) bar.act('activate', { id: tab.id }); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') bar.act('activate', { id: tab.id }); },
    }, letter, el('span', { class: 'title' }, tab.title || words.newTab), close);
    strip.insertBefore(node, $('newTab'));
  }
  $('newTab').title = words.newTab;
}

function showFavouritesBar(s) {
  const favs = $('favs');
  favs.classList.toggle('hide', !s.favouritesBar);
  favs.replaceChildren();
  if (!s.favouritesBar) return;
  for (const f of s.favourites) {
    favs.append(el('button', {
      class: 'fav', title: `${f.title}\n${f.url}`,
      onclick: (e) => openUrl(f.url, e),
      onauxclick: (e) => { if (e.button === 1) openUrl(f.url, e); },
    }, el('span', { class: 'letter' }, letterOf(f.url, f.title)), el('span', {}, f.title)));
  }
  favs.append(el('button', { class: 'more', title: words.manageFavourites, onclick: () => bar.act('panel', { name: 'favourites' }) }, icon('folder')));
}

function showFind(s) {
  $('find').classList.toggle('hide', !s.find);
  $('findText').placeholder = words.find || '';
  $('findPrev').title = words.findPrev || '';
  $('findNext').title = words.findNext || '';
  $('findClose').title = words.close || '';
  const f = s.found;
  $('findCount').textContent = !f || !$('findText').value ? '' : f.total ? fill(words.findOf, { n: f.n, total: f.total }) : words.noMatches;
}

// ── panels ──
function panelHead(title, ...actions) {
  return el('div', { class: 'head' }, el('h2', {}, title), ...actions, el('button', { title: words.close, onclick: () => bar.act('panel', { name: '' }) }, icon('close')));
}

function keptNote(s) {
  return el('div', { class: 'note' }, s.kept ? words.privateNote : words.notKept);
}

function favouritesPanel(s) {
  const list = el('div', {});
  let dragged = '';
  for (const f of s.favourites) {
    if (editFav === f.id) {
      const name = el('input', { value: f.title, 'aria-label': words.name, placeholder: words.name });
      const url = el('input', { value: f.url, 'aria-label': words.address, placeholder: words.address, spellcheck: 'false' });
      const save = () => {
        if (!/^https?:\/\//i.test(url.value.trim())) { favError = words.invalidAddress; render(); return; }
        bar.act('fav-edit', { fav: f.id, title: name.value, url: url.value.trim() });
        editFav = ''; favError = '';
      };
      const keys = (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { editFav = ''; favError = ''; render(); } };
      name.addEventListener('keydown', keys);
      url.addEventListener('keydown', keys);
      list.append(el('div', { class: 'row' },
        el('div', { class: 'edit' }, name, url, favError ? el('div', { class: 'error' }, favError) : null),
        el('button', { class: 'text', onclick: save }, words.save),
        el('button', { class: 'text', onclick: () => { editFav = ''; favError = ''; render(); } }, words.cancel)));
      setTimeout(() => { if (document.activeElement === document.body) name.focus(); }, 0);
      continue;
    }
    const row = el('div', {
      class: 'row', draggable: 'true',
      ondragstart: (e) => { dragged = f.id; e.dataTransfer.effectAllowed = 'move'; row.classList.add('dragging'); },
      ondragend: () => row.classList.remove('dragging'),
      ondragover: (e) => { if (dragged && dragged !== f.id) e.preventDefault(); },
      ondrop: (e) => { e.preventDefault(); if (dragged && dragged !== f.id) bar.act('fav-move', { fav: dragged, before: f.id }); dragged = ''; },
    },
    el('div', { class: 'main', onclick: (e) => openUrl(f.url, e), onauxclick: (e) => { if (e.button === 1) openUrl(f.url, e); } },
      el('div', { class: 't' }, f.title), el('div', { class: 'u' }, f.url)),
    el('button', { title: words.edit, onclick: () => { editFav = f.id; favError = ''; render(); } }, icon('edit')),
    el('button', { title: words.remove, onclick: () => bar.act('fav-remove', { fav: f.id }) }, icon('close')));
    list.append(row);
  }
  const toggle = el('input', { type: 'checkbox', checked: s.showBar, onchange: () => bar.act('favourites-bar') });
  return [
    panelHead(words.favourites),
    el('label', { class: 'check' }, toggle, words.showBar),
    s.favourites.length ? list : el('div', { class: 'empty' }, words.noFavourites),
    keptNote(s),
  ];
}

function dayOf(ts) {
  const d = new Date(ts);
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return words.today;
  if (diff === 1) return words.yesterday;
  return d.toLocaleDateString(state.lang || undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

let historyList = [];
async function loadHistory() {
  historyList = await bar.history(historyQuery);
  if (state && state.panel === 'history') render();
}

function historyPanel(s) {
  const search = el('input', { class: 'search', value: historyQuery, placeholder: words.searchHistory, 'aria-label': words.searchHistory, spellcheck: 'false',
    oninput: (e) => { historyQuery = e.target.value; clearTimeout(historyTimer); historyTimer = setTimeout(loadHistory, 200); } });
  const clear = askClear
    ? [el('span', {}, words.clearHistoryAsk), el('button', { class: 'text danger', onclick: () => { askClear = false; bar.act('history-clear'); setTimeout(loadHistory, 100); } }, words.clearHistory),
      el('button', { class: 'text', onclick: () => { askClear = false; render(); } }, words.cancel)]
    : [el('button', { class: 'text danger', disabled: !historyList.length && !historyQuery, onclick: () => { askClear = true; render(); } }, words.clearHistory)];
  const list = el('div', {});
  let day = '';
  for (const h of historyList) {
    const d = dayOf(h.at);
    if (d !== day) { day = d; list.append(el('div', { class: 'day' }, d)); }
    list.append(el('div', { class: 'row' },
      el('span', { class: 'time' }, new Date(h.at).toLocaleTimeString(s.lang || undefined, { hour: '2-digit', minute: '2-digit' })),
      el('div', { class: 'main', onclick: (e) => openUrl(h.url, e), onauxclick: (e) => { if (e.button === 1) openUrl(h.url, e); } },
        el('div', { class: 't' }, h.title), el('div', { class: 'u' }, hostOf(h.url))),
      el('button', { title: words.remove, onclick: () => { bar.act('history-remove', { entry: h.id }); historyList = historyList.filter((x) => x.id !== h.id); render(); } }, icon('close'))));
  }
  setTimeout(() => { if (document.activeElement === document.body) search.focus(); }, 0);
  return [panelHead(words.history, ...clear), search, historyList.length ? list : el('div', { class: 'empty' }, words.noHistory), keptNote(s)];
}

function size(n) {
  if (!n) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let k = 0;
  let v = n;
  while (v >= 1024 && k < units.length - 1) { v /= 1024; k++; }
  return `${v >= 10 || k === 0 ? Math.round(v) : v.toFixed(1)} ${units[k]}`;
}

function downloadsPanel(s) {
  const list = el('div', {});
  for (const d of s.downloads) {
    const status = d.state === 'progressing'
      ? `${words.downloading} · ${size(d.received)}${d.total ? ` / ${size(d.total)}` : ''}`
      : d.state === 'completed' ? `${words.done} · ${size(d.total || d.received)}` : d.state === 'cancelled' ? words.cancelled : words.failed;
    list.append(el('div', { class: 'row' },
      el('div', { class: 'main' }, el('div', { class: 't' }, d.name), el('div', { class: 'u' }, `${d.host} · ${status}`), d.path ? el('div', { class: 'u' }, d.path) : null),
      d.state === 'completed' ? el('button', { class: 'text', onclick: () => bar.act('download-show', { download: d.id }) }, words.showInFolder) : null,
      d.state === 'progressing' ? el('button', { class: 'text danger', onclick: () => bar.act('download-cancel', { download: d.id }) }, words.cancel) : null,
      d.state !== 'progressing' ? el('button', { title: words.remove, onclick: () => bar.act('download-remove', { download: d.id }) }, icon('close')) : null));
  }
  return [
    panelHead(words.downloads, el('button', { class: 'text', disabled: !s.downloads.length, onclick: () => bar.act('downloads-clear') }, words.clearList)),
    s.downloads.length ? list : el('div', { class: 'empty' }, words.noDownloads),
    keptNote(s),
  ];
}

function showPanel(s) {
  const panel = $('panel');
  panel.classList.toggle('hide', !s.panel);
  if (!s.panel) return;
  const h = s.heights;
  panel.style.top = `${h.tabs + h.toolbar + (s.favouritesBar ? h.favourites : 0) + (s.find ? h.find : 0)}px`;
  // a field the user types in keeps its text while the state changes
  if (panel.contains(document.activeElement) && document.activeElement.tagName === 'INPUT' && s.panel === panel.dataset.name && s.panel !== 'history') return;
  panel.dataset.name = s.panel;
  const parts = s.panel === 'favourites' ? favouritesPanel(s) : s.panel === 'history' ? historyPanel(s) : downloadsPanel(s);
  $('panelInner').replaceChildren(...parts.filter(Boolean));
}

let lastPanel = '';
function render() {
  const s = state;
  if (!s) return;
  words = s.words || words;
  showTabs(s);
  $('back').disabled = !s.canBack;
  $('forward').disabled = !s.canForward;
  $('back').title = words.back || '';
  $('forward').title = words.forward || '';
  $('home').title = words.home || '';
  $('reload').title = s.loading ? (words.stop || '') : (words.reload || '');
  $('reloadIcon').style.display = s.loading ? 'none' : '';
  $('stopIcon').style.display = s.loading ? '' : 'none';
  $('progress').style.top = `${s.heights.tabs + s.heights.toolbar - 2}px`;
  $('progress').classList.toggle('on', Boolean(s.loading));
  $('address').placeholder = words.placeholder || '';
  if (!editing) $('address').value = s.url && s.url !== 'about:blank' ? s.url : '';
  $('lock').classList.toggle('secure', /^https:/i.test(s.url || ''));
  const web = /^https?:\/\//i.test(s.url || '');
  $('star').classList.toggle('on', Boolean(s.starred));
  $('star').classList.toggle('hide', !web);
  $('star').title = s.starred ? words.removeFavourite : words.addFavourite;
  $('zoom').classList.toggle('hide', s.zoom === 100);
  $('zoom').textContent = `${s.zoom} %`;
  $('zoom').title = words.zoomReset || '';
  $('external').disabled = !web;
  $('external').title = words.external || '';
  $('favourites').title = words.favourites || '';
  $('history').title = words.history || '';
  $('downloads').title = words.downloads || '';
  $('menu').title = words.menu || '';
  $('dlBadge').classList.toggle('hide', !s.downloads.some((d) => d.state === 'progressing'));
  const task = $('task');
  task.classList.toggle('on', Boolean(s.task));
  task.classList.toggle('paused', s.task === 'paused');
  $('taskText').textContent = s.task === 'paused' ? (words.paused || '') : s.task ? (words.working || '') : '';
  showFavouritesBar(s);
  showFind(s);
  if (s.panel === 'history' && lastPanel !== 'history') { askClear = false; loadHistory(); }
  if (s.panel !== 'favourites') editFav = '';
  lastPanel = s.panel;
  showPanel(s);
  document.documentElement.lang = s.lang || 'en';
}

$('newTab').onclick = () => bar.act('new-tab');
$('back').onclick = () => bar.go('back');
$('forward').onclick = () => bar.go('forward');
$('reload').onclick = () => bar.go($('stopIcon').style.display === '' ? 'stop' : 'reload');
$('home').onclick = () => bar.go('home');
$('star').onclick = () => bar.act('favourite');
$('zoom').onclick = () => bar.act('zoom-reset');
$('external').onclick = () => bar.act('external');
$('favourites').onclick = () => bar.act('panel', { name: state && state.panel === 'favourites' ? '' : 'favourites' });
$('history').onclick = () => bar.act('panel', { name: state && state.panel === 'history' ? '' : 'history' });
$('downloads').onclick = () => bar.act('panel', { name: state && state.panel === 'downloads' ? '' : 'downloads' });
$('menu').onclick = () => bar.act('menu');
$('address').addEventListener('focus', () => { editing = true; $('address').select(); });
$('address').addEventListener('blur', () => { editing = false; });
$('address').addEventListener('keydown', (e) => { if (e.key === 'Escape') { editing = false; $('address').blur(); bar.go('refresh'); } });
$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('address').value.trim();
  if (!text) return;
  editing = false;
  $('address').blur();
  bar.open(text, false);
});
// Alt+Enter in the address: a new tab (like Chrome and Firefox)
$('address').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.altKey) {
    e.preventDefault();
    const text = $('address').value.trim();
    if (text) { editing = false; $('address').blur(); bar.open(text, true); }
  }
});
$('findText').addEventListener('input', () => bar.act('find', { text: $('findText').value, forward: true }));
$('findText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') bar.act('find', { text: $('findText').value, forward: !e.shiftKey });
  if (e.key === 'Escape') bar.act('find-close');
});
$('findNext').onclick = () => bar.act('find', { text: $('findText').value, forward: true });
$('findPrev').onclick = () => bar.act('find', { text: $('findText').value, forward: false });
$('findClose').onclick = () => bar.act('find-close');
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state && state.panel && !editFav && !askClear) bar.act('panel', { name: '' });
});

bar.onState((s) => { state = s; render(); });
bar.onFocus((what) => {
  if (what === 'address') { $('address').focus(); $('address').select(); }
  if (what === 'find') setTimeout(() => { $('findText').focus(); $('findText').select(); }, 30);
});
bar.go('refresh');
