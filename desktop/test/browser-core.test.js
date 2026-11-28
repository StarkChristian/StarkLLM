// StarkLLM's browser window (docs/browser-features.md): tabs, shortcuts, zoom, links, downloads, and the user's
// favourites, history and downloads list, kept per account and encrypted.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const b = require('../browser-core');

// a stand-in for Windows encryption (DPAPI): AES-GCM under a key in memory
function fakeSeal() {
  const key = crypto.randomBytes(32);
  return {
    seal: (s) => {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, c.update(s, 'utf8'), c.final(), c.getAuthTag()]);
    },
    unseal: (buf) => {
      const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
      d.setAuthTag(buf.subarray(buf.length - 16));
      return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8');
    },
  };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'starkllm-browser-'));

test('tabs: open, switch, close; the next tab is the one to the right, else to the left', () => {
  const tabs = b.createTabs({ max: 4 });
  const a = tabs.add('task');
  const c = tabs.add('user');
  assert.equal(tabs.active, c.id);
  assert.equal(tabs.get(a.id).kind, 'task');
  const between = tabs.add('user', { activate: false, afterActive: false });
  assert.equal(tabs.active, c.id, 'a background tab does not take the focus');
  tabs.activate(a.id);
  const right = tabs.add('user', { afterActive: true });
  assert.deepEqual(tabs.list.map((x) => x.id), [a.id, right.id, c.id, between.id], 'a link opens next to its tab');
  assert.equal(tabs.full(), true);
  assert.equal(tabs.add('user'), null, 'no more than the maximum');
  tabs.activate(right.id);
  tabs.remove(right.id);
  assert.equal(tabs.active, c.id, 'the tab to the right');
  tabs.activate(between.id);
  tabs.remove(between.id);
  assert.equal(tabs.active, c.id, 'the last tab: the one to the left');
  tabs.remove(a.id);
  assert.equal(tabs.active, c.id, 'closing another tab keeps the active one');
  tabs.remove(c.id);
  assert.equal(tabs.active, null);
  assert.equal(tabs.count, 0);
  assert.equal(tabs.remove(999), false);
});

test('tabs: Ctrl+Tab goes round, Ctrl+1 … 8 pick a tab, Ctrl+9 the last one', () => {
  const tabs = b.createTabs();
  const ids = [1, 2, 3].map(() => tabs.add('user').id);
  assert.equal(tabs.step(1), ids[0], 'from the last to the first');
  assert.equal(tabs.step(-1), ids[2], 'from the first to the last');
  assert.equal(tabs.nth(2), ids[1]);
  assert.equal(tabs.nth(9), ids[2]);
  assert.equal(tabs.nth(7), null, 'no seventh tab: nothing changes');
  assert.equal(tabs.active, ids[2]);
});

test('reopen a closed tab: the last ten web addresses, never one with a password in it', () => {
  const tabs = b.createTabs();
  for (let i = 0; i < 12; i++) { const t = tabs.add('user'); tabs.remove(t.id, `https://example.org/${i}`); }
  const t = tabs.add('user');
  tabs.remove(t.id, 'about:blank');
  const u = tabs.add('user');
  tabs.remove(u.id, 'https://user:secret@example.org/');
  assert.equal(tabs.reopen(), 'https://example.org/11');
  let n = 1;
  while (tabs.reopen()) n++;
  assert.equal(n, 10);
});

test('a link that asks for a new window: the same page while a task works there, else a new tab', () => {
  assert.equal(b.linkTarget({ taskWorksHere: true }), 'here');
  assert.equal(b.linkTarget({ full: true }), 'here');
  assert.equal(b.linkTarget({}), 'new-tab');
  assert.equal(b.linkTarget({ disposition: 'foreground-tab' }), 'new-tab');
  assert.equal(b.linkTarget({ disposition: 'background-tab' }), 'background-tab');
  assert.equal(b.linkTarget({ taskWorksHere: true, disposition: 'background-tab' }), 'here');
});

test('keyboard shortcuts of Chrome, Firefox and Opera', () => {
  const k = (key, mods = {}) => {
    const s = b.shortcutOf({ type: 'keyDown', key, ...mods });
    return s && (s.n ? `${s.action}:${s.n}` : s.action);
  };
  const ctrl = { control: true };
  const ctrlShift = { control: true, shift: true };
  assert.equal(k('t', ctrl), 'new-tab');
  assert.equal(k('T', ctrlShift), 'reopen-tab');
  assert.equal(k('w', ctrl), 'close-tab');
  assert.equal(k('F4', ctrl), 'close-tab');
  assert.equal(k('Tab', ctrl), 'next-tab');
  assert.equal(k('Tab', ctrlShift), 'prev-tab');
  assert.equal(k('PageDown', ctrl), 'next-tab');
  assert.equal(k('PageUp', ctrl), 'prev-tab');
  assert.equal(k('3', ctrl), 'nth-tab:3');
  assert.equal(k('9', ctrl), 'nth-tab:9');
  assert.equal(k('l', ctrl), 'address');
  assert.equal(k('d', { alt: true }), 'address');
  assert.equal(k('F6'), 'address');
  assert.equal(k('f', ctrl), 'find');
  assert.equal(k('F3'), 'find-next');
  assert.equal(k('F3', { shift: true }), 'find-prev');
  assert.equal(k('g', ctrl), 'find-next');
  assert.equal(k('d', ctrl), 'favourite');
  assert.equal(k('B', ctrlShift), 'favourites-bar');
  assert.equal(k('O', ctrlShift), 'favourites');
  assert.equal(k('h', ctrl), 'history');
  assert.equal(k('j', ctrl), 'downloads');
  assert.equal(k('r', ctrl), 'reload');
  assert.equal(k('F5'), 'reload');
  assert.equal(k('+', ctrlShift), 'zoom-in');
  assert.equal(k('=', ctrl), 'zoom-in');
  assert.equal(k('-', ctrl), 'zoom-out');
  assert.equal(k('0', ctrl), 'zoom-reset');
  assert.equal(b.shortcutOf({ type: 'keyDown', key: '+', code: 'NumpadAdd', control: true }).action, 'zoom-in');
  assert.equal(k('ArrowLeft', { alt: true }), 'back');
  assert.equal(k('ArrowRight', { alt: true }), 'forward');
  assert.equal(k('Home', { alt: true }), 'home');
  assert.equal(k('t', { meta: true }), 'new-tab');
  // the page keeps its own keys: typing, copy and paste, select all, undo
  for (const [key, mods] of [['a', {}], ['c', ctrl], ['v', ctrl], ['a', ctrl], ['z', ctrl], ['Enter', {}], ['F', { shift: true }], ['ArrowLeft', {}]]) {
    assert.equal(k(key, mods), null, `${key} ${JSON.stringify(mods)}`);
  }
  assert.equal(b.shortcutOf({ type: 'keyUp', key: 't', control: true }), null, 'only when the key goes down');
});

test('zoom: the steps of Chrome, 25 % to 500 %; a task clicks the right point at any zoom', () => {
  assert.equal(b.zoomStep(1, 1), 1.1);
  assert.equal(b.zoomStep(1, -1), 0.9);
  assert.equal(b.zoomStep(1.3, 1), 1.5, 'from a factor between two steps to the next one');
  assert.equal(b.zoomStep(1.3, -1), 1.25);
  assert.equal(b.zoomStep(5, 1), 5);
  assert.equal(b.zoomStep(0.25, -1), 0.25);
  assert.equal(b.zoomStep(2, 0), 1);
  assert.deepEqual(b.pointOf({ x: 100, y: 40 }, 1), { x: 100, y: 40 });
  assert.deepEqual(b.pointOf({ x: 100, y: 40 }, 1.5), { x: 150, y: 60 });
  assert.deepEqual(b.pointOf({ x: 101, y: 41 }, 0.67), { x: 68, y: 27 });
  assert.deepEqual(b.pointOf({ x: 10, y: 10 }, 0), { x: 10, y: 10 }, 'no zoom known: as it is');
});

test('downloads: only the user\'s, never during a web task or offline; programs get a warning; then the save dialog', () => {
  assert.deepEqual(b.downloadRule({ userTab: false }), { action: 'refuse', why: 'not a tab of the user' });
  assert.equal(b.downloadRule({ userTab: true, taskWorks: true }).action, 'refuse');
  assert.equal(b.downloadRule({ userTab: true, offline: true }).action, 'refuse');
  assert.equal(b.downloadRule({ userTab: true, risky: true }).action, 'warn');
  assert.equal(b.downloadRule({ userTab: true, risky: true, allowedOnce: true }).action, 'save-dialog');
  assert.equal(b.downloadRule({ userTab: true, taskWorks: true, risky: true, allowedOnce: true }).action, 'refuse', 'a task never, also after a yes');
  assert.equal(b.downloadRule({ userTab: true }).action, 'save-dialog');
  for (const f of ['setup.exe', 'Tool.MSI', 'run.bat', 'x.ps1', 'a.js', 'l.lnk', 'disk.iso', 'evil.exe.', 'x.scr ']) assert.equal(b.isRiskyFile(f), true, f);
  for (const f of ['letter.pdf', 'photo.jpg', 'data.csv', 'notes.txt', 'exe', 'archive.zip', '']) assert.equal(b.isRiskyFile(f), false, f);
  assert.equal(b.safeFileName('..\\..\\Windows\\system.ini'), 'system.ini');
  assert.equal(b.safeFileName('a/b/c:d?.pdf'), 'c_d_.pdf');
  assert.equal(b.safeFileName('CON.txt'), 'download');
  assert.equal(b.safeFileName('  .hidden  '), 'hidden');
  assert.equal(b.safeFileName(''), 'download');
});

test('favourites: the star adds and removes; only web addresses, never one with a password; rename, change, move, delete', () => {
  const p = b.createProfile({});
  assert.equal(p.persistent, false);
  assert.deepEqual(p.addFavourite('javascript:alert(1)', 'x'), { error: 'invalid' });
  assert.deepEqual(p.addFavourite('file:///C:/Windows', 'x'), { error: 'invalid' });
  assert.deepEqual(p.addFavourite('https://user:pw@example.org/', 'x'), { error: 'invalid' });
  assert.deepEqual(p.addFavourite(`https://example.org/${'a'.repeat(3000)}`, 'x'), { error: 'invalid' });
  assert.deepEqual(p.toggleFavourite('https://aachen.de', '  Stadt   Aachen '), { ok: true, on: true });
  assert.equal(p.isFavourite('https://aachen.de/'), true);
  assert.equal(p.favourites()[0].title, 'Stadt Aachen');
  assert.equal(p.addFavourite('https://aachen.de/', 'again').favourite.title, 'Stadt Aachen', 'the same address once');
  assert.deepEqual(p.toggleFavourite('https://aachen.de/'), { ok: true, on: false });
  assert.equal(p.favourites().length, 0);
  const a = p.addFavourite('https://a.example/', '').favourite;
  assert.equal(a.title, 'a.example', 'no title: the site');
  const c = p.addFavourite('https://c.example/', 'C').favourite;
  assert.deepEqual(p.editFavourite(a.id, { title: 'A', url: 'https://a.example/new' }).ok, true);
  assert.deepEqual(p.editFavourite(a.id, { url: 'ftp://a.example/' }), { error: 'invalid' });
  assert.deepEqual(p.editFavourite(a.id, { url: 'https://c.example/' }), { error: 'exists' });
  assert.deepEqual(p.editFavourite('nope', { title: 'x' }), { error: 'unknown' });
  p.moveFavourite(c.id, a.id);
  assert.deepEqual(p.favourites().map((f) => f.title), ['C', 'A']);
  p.moveFavourite(c.id, '');
  assert.deepEqual(p.favourites().map((f) => f.title), ['A', 'C']);
  assert.deepEqual(p.removeFavourite(a.id), { ok: true });
  assert.deepEqual(p.favourites().map((f) => f.title), ['C']);
  assert.equal(p.showBar, true, 'the favourites bar is on until the user hides it');
  p.setShowBar(false);
  assert.equal(p.showBar, false);
});

test('history: newest first, one entry for a reload, search, remove one, clear all', () => {
  let now = 1000;
  const p = b.createProfile({ now: () => now });
  assert.equal(p.visit('about:blank', ''), null);
  assert.equal(p.visit('data:text/html,x', ''), null);
  assert.equal(p.visit('https://u:p@example.org/', ''), null);
  p.visit('https://www.aachen.de/', '');
  p.titleOf('https://www.aachen.de/', 'Stadt Aachen');
  now = 2000;
  p.visit('https://www.aachen.de/', 'Stadt Aachen');
  assert.equal(p.history().length, 1, 'a reload is not a new entry');
  assert.equal(p.history()[0].at, 2000);
  now = 3000;
  p.visit('https://duckduckgo.com/?q=Rathaus', 'Rathaus at DuckDuckGo');
  p.visit('https://www.aachen.de/', 'Stadt Aachen');
  assert.deepEqual(p.history().map((h) => h.title), ['Stadt Aachen', 'Rathaus at DuckDuckGo', 'Stadt Aachen']);
  assert.deepEqual(p.history('rathaus').map((h) => h.url), ['https://duckduckgo.com/?q=Rathaus']);
  assert.deepEqual(p.history('stadt aachen').length, 2, 'every word must match');
  p.removeHistory(p.history()[0].id);
  assert.equal(p.history().length, 2);
  p.clearHistory();
  assert.equal(p.history().length, 0);
  for (let i = 0; i < b.MAX_HISTORY + 10; i++) p.visit(`https://example.org/${i}`, '');
  assert.equal(p.history('', 1e9).length, b.MAX_HISTORY, 'old entries go');
});

test('downloads list: where the file went; running downloads stay in the list', () => {
  const p = b.createProfile({});
  const d = p.addDownload({ name: '../x/Bericht.pdf', host: 'aachen.de' });
  assert.equal(d.name, 'Bericht.pdf');
  assert.equal(d.state, 'progressing');
  p.updateDownload(d.id, { path: 'C:\\Users\\me\\Downloads\\Bericht.pdf', received: 10, total: 20 });
  assert.equal(p.removeDownload(d.id).ok, false, 'not while it runs');
  p.clearDownloads();
  assert.equal(p.downloads().length, 1, 'not while it runs');
  p.updateDownload(d.id, { state: 'completed', received: 20 });
  assert.equal(p.download(d.id).path, 'C:\\Users\\me\\Downloads\\Bericht.pdf');
  assert.equal(p.download(d.id).state, 'completed');
  p.updateDownload(d.id, { state: 'whatever' });
  assert.equal(p.download(d.id).state, 'completed');
  p.clearDownloads();
  assert.equal(p.downloads().length, 0);
  for (let i = 0; i < b.MAX_DOWNLOADS + 5; i++) p.addDownload({ name: `f${i}.pdf`, host: 'x' });
  assert.equal(p.downloads().length, b.MAX_DOWNLOADS);
});

test('kept per account, encrypted; the file name does not say whose it is', () => {
  const dir = tmp();
  const s = fakeSeal();
  const anna = b.createProfile({ dir, account: 'anna', ...s });
  assert.equal(anna.persistent, true);
  anna.addFavourite('https://www.aachen.de/', 'Stadt Aachen');
  anna.visit('https://duckduckgo.com/?q=Arzttermin', 'Arzttermin');
  anna.addDownload({ name: 'Befund.pdf', host: 'praxis.example' });
  assert.equal(anna.save(), true);
  assert.equal(anna.save(), false, 'nothing new: nothing written');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.ok(!files[0].includes('anna'));
  const raw = fs.readFileSync(path.join(dir, files[0]));
  for (const word of ['aachen', 'Arzttermin', 'Befund', 'duckduckgo']) assert.ok(!raw.toString('latin1').includes(word), `${word} is not readable in the file`);
  // read back by the same account
  const again = b.createProfile({ dir, account: 'anna', ...s });
  assert.equal(again.favourites()[0].title, 'Stadt Aachen');
  assert.equal(again.history()[0].title, 'Arzttermin');
  assert.equal(again.downloads()[0].state, 'interrupted', 'a download that ran when StarkLLM closed is not "running" any more');
  // another account sees nothing of it
  const ben = b.createProfile({ dir, account: 'ben', ...s });
  assert.deepEqual([ben.favourites().length, ben.history().length, ben.downloads().length], [0, 0, 0]);
  ben.addFavourite('https://example.org/', 'Ben');
  ben.save();
  assert.equal(fs.readdirSync(dir).length, 2);
  assert.notEqual(b.profileFile(dir, 'anna'), b.profileFile(dir, 'ben'));
  // without the key (another Windows user) or a damaged file: empty lists, no crash
  const other = fakeSeal();
  assert.equal(b.createProfile({ dir, account: 'anna', ...other }).favourites().length, 0);
  fs.writeFileSync(b.profileFile(dir, 'anna'), 'not encrypted');
  assert.equal(b.createProfile({ dir, account: 'anna', ...s }).favourites().length, 0);
});

test('without Windows encryption or without an account nothing is written', () => {
  const dir = tmp();
  const s = fakeSeal();
  const noSeal = b.createProfile({ dir, account: 'anna' });
  noSeal.addFavourite('https://example.org/', 'x');
  assert.equal(noSeal.persistent, false);
  assert.equal(noSeal.save(), false);
  const noAccount = b.createProfile({ dir, account: '', ...s });
  noAccount.addFavourite('https://example.org/', 'x');
  assert.equal(noAccount.save(), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a changed file cannot put other things into the lists', () => {
  const p = b.normalize({
    favourites: [{ url: 'javascript:alert(1)', title: 'x' }, { url: 'https://ok.example/', title: '<b>' + 'x'.repeat(500) }, null, 'text'],
    history: [{ url: 'file:///C:/', title: 'x' }, { url: 'https://ok.example/', title: 't', at: 'soon' }],
    downloads: [{ name: '..\\..\\a.exe', state: 'progressing', path: 'C:\\a.exe' }, 7],
    showBar: 'no',
  });
  assert.equal(p.favourites.length, 1);
  assert.equal(p.favourites[0].title.length, 200);
  assert.equal(p.history.length, 1);
  assert.equal(p.history[0].at, 0);
  assert.equal(p.downloads[0].name, 'a.exe');
  assert.equal(p.downloads[0].state, 'interrupted');
  assert.equal(p.showBar, true);
  assert.deepEqual(b.normalize(null), { favourites: [], history: [], downloads: [], showBar: true });
});

test('the page sits below tabs, address bar, the favourites bar when shown and the find row when open', () => {
  assert.equal(b.topHeight({}), 80);
  assert.equal(b.topHeight({ favouritesBar: true }), 110);
  assert.equal(b.topHeight({ favouritesBar: true, find: true }), 150);
});

// The bar is a local page: no network, no Node, a few calls; the window code keeps the rules
test('the bar has no network and only its own calls; the window uses the rules above', () => {
  const dir = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(dir, 'webtask-bar.html'), 'utf8');
  assert.match(html, /default-src 'none'; script-src 'self';/);
  assert.doesNotMatch(html, /https?:\/\//);
  const preload = fs.readFileSync(path.join(dir, 'webtask-bar-preload.js'), 'utf8');
  const calls = [...preload.matchAll(/ipcRenderer\.(?:send|invoke|on)\('([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(calls, ['webbar:act', 'webbar:focus', 'webbar:go', 'webbar:history', 'webbar:open', 'webbar:state']);
  const barJs = fs.readFileSync(path.join(dir, 'webtask-bar.js'), 'utf8');
  assert.doesNotMatch(barJs, /innerHTML|fetch\(|XMLHttpRequest|WebSocket/, 'titles of pages are shown as text, the bar connects nowhere');
  const src = fs.readFileSync(path.join(dir, 'webtask.js'), 'utf8');
  assert.match(src, /browser\.downloadRule\(/);
  assert.match(src, /browser\.pointOf\(h, wc\.getZoomFactor\(\)\)/);
  assert.match(src, /browser\.linkTarget\(\{ taskWorksHere: taskWorksIn\(tabId\)/);
  assert.match(src, /setPermissionRequestHandler\(\(_wc, _permission, callback\) => callback\(false\)\)/, 'permissions stay refused');
  // every bar message is checked to come from the bar
  for (const ch of ['webbar:go', 'webbar:open', 'webbar:act', 'webbar:history']) {
    const at = src.indexOf(`'${ch}'`);
    assert.ok(at > 0, ch);
    assert.match(src.slice(at, at + 200), /fromBar\(event\)/, ch);
  }
});
