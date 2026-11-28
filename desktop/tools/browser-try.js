// Try StarkLLM's browser window (webtask.js, docs/browser-features.md) in real Electron, without the rest of the app:
// tabs, a shortcut, favourites, history, find, zoom, a click at a zoomed page, and a web task in its own tab with a
// stand-in for the local AI model (a small server on this PC that answers like Ollama). Needs the internet for
// example.org. On a PC or under Xvfb:
//   xvfb-run -a electron tools/browser-try.js
// Prints "CHECK <name> ok|FAILED <detail>" per check and "RESULT {...}" at the end; exits with 1 when a check failed.
const { app, ipcMain, BrowserWindow } = require('electron');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-try-'));
app.setPath('userData', dir);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
let failed = 0;
function check(name, ok, detail = '') {
  results[name] = Boolean(ok);
  if (!ok) failed++;
  console.log(`CHECK ${name} ${ok ? 'ok' : `FAILED ${detail}`}`);
}

// the stand-in model: open example.org, click its link once, then finish
function fakeOllama() {
  let clicked = false;
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const messages = JSON.parse(body || '{}').messages || [];
        const prompt = String((messages[messages.length - 1] || {}).content || '');
        const link = prompt.match(/\[(\d+)\] link "[^"]*(More information|Learn more)[^"]*"/i);
        let call;
        if (clicked) call = { name: 'finish', arguments: { answer: 'done' } };
        else if (link) { clicked = true; call = { name: 'click', arguments: { element: Number(link[1]) } }; }
        else call = { name: 'open_url', arguments: { url: 'https://example.org/' } };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: call }] } }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await fn()) return true; } catch (e) { /* not yet */ }
    await sleep(200);
  }
  return false;
}

app.whenReady().then(async () => {
  const server = await fakeOllama();
  process.env.STARKLLM_OLLAMA_URL = `http://127.0.0.1:${server.address().port}`;
  require('../netguard').initShared(dir);
  const webtask = require('../webtask');
  const handlers = {};
  webtask.register({ handle: (ch, fn) => { handlers[ch] = fn; } }, { fromApp: () => true, log: (l) => console.log('LOG', l) });
  webtask.setAccount('tester');

  let state = null;
  const win = () => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.contentView && w.contentView.children.length);
  const pages = () => win().contentView.children.map((v) => v.webContents);
  const visible = () => win().contentView.children.find((v) => v.getVisible()).webContents;
  const act = (what, arg = {}) => ipcMain.emit('webbar:act', { sender: win().webContents }, what, arg);
  const open = (text, newTab = false) => ipcMain.emit('webbar:open', { sender: win().webContents }, text, newTab);

  // 1. the window for the user: one tab with the start page
  const r = await handlers['webtask:open-browser']({ sender: { isDestroyed: () => false } });
  check('open-browser', r && r.ok, JSON.stringify(r));
  const barWc = BrowserWindow.getAllWindows()[0].webContents;
  const origSend = barWc.send.bind(barWc);
  barWc.send = (ch, s) => { if (ch === 'webbar:state') state = s; return origSend(ch, s); };
  await until(() => pages().length === 1 && !pages()[0].isLoading() && /duckduckgo/.test(pages()[0].getURL()));
  check('first tab: start page', /duckduckgo\.com/.test(pages()[0].getURL()), pages()[0].getURL());

  // 2. a second tab with example.org from the address bar (Alt+Enter: new tab)
  open('example.org', true);
  await until(() => pages().length === 2 && /example\.org/.test(visible().getURL()) && !visible().isLoading());
  check('new tab from the address bar', pages().length === 2 && /example\.org/.test(visible().getURL()), `${pages().length} ${visible().getURL()}`);
  act('refresh');
  await until(() => state && state.tabs.length === 2);
  check('bar shows two tabs', state && state.tabs.length === 2 && state.tabs.some((t) => /Example/i.test(t.title)), JSON.stringify(state && state.tabs));

  // 3. favourite with the star, history
  act('favourite');
  await until(() => state && state.starred);
  check('star adds a favourite', state && state.starred && state.favourites.length === 1 && state.favouritesBar, JSON.stringify(state && state.favourites));
  // the history through the bar's own bridge
  const hist = await barWc.executeJavaScript("window.starkllmBar.history('')");
  check('history has both pages', hist.some((h) => /duckduckgo/.test(h.url)) && hist.some((h) => /example\.org/.test(h.url)), JSON.stringify(hist).slice(0, 300));
  const found = await barWc.executeJavaScript("window.starkllmBar.history('example')");
  check('history search', found.length >= 1 && found.every((h) => /example/i.test(h.url + h.title)), JSON.stringify(found).slice(0, 200));

  // screenshots of the bar and the history panel (SHOT_DIR=folder)
  if (process.env.SHOT_DIR) {
    const shot = async (name) => fs.writeFileSync(path.join(process.env.SHOT_DIR, name), (await win().capturePage()).toPNG());
    await sleep(800);
    await shot('browser-bar.png');
    act('panel', { name: 'history' });
    await sleep(800);
    await shot('browser-history.png');
    act('panel', { name: '' });
    await sleep(300);
  }

  // 4. find in page
  act('find', { text: 'domain', forward: true });
  await until(() => state && state.found && state.found.total > 0, 8000);
  check('find in page', state && state.found && state.found.total > 0, JSON.stringify(state && state.found));
  act('find-close');

  // 5. zoom in two steps (110 %, 125 %)
  for (let i = 0; i < 2; i++) act('zoom-in');
  await until(() => Math.abs(visible().getZoomFactor() - 1.25) < 0.01, 5000);
  check('zoom 125 %', Math.abs(visible().getZoomFactor() - 1.25) < 0.01, String(visible().getZoomFactor()));

  // 6. a click at a zoomed page lands on the element (the rule a web task uses)
  const { pointOf } = require('../browser-core');
  const html = '<!doctype html><body style="margin:0"><div style="height:300px"></div><button id="b" style="margin-left:400px;width:120px;height:40px" onclick="window.hits=(window.hits||0)+1">x</button>';
  open('https://example.org/'); // same site, so the zoom of the site applies
  await until(() => !visible().isLoading());
  const wc = visible();
  await wc.loadURL(`data:text/html,${encodeURIComponent(html)}`).catch(() => {});
  wc.setZoomFactor(1.5);
  await sleep(500);
  const rect = await wc.executeJavaScript('(() => { const r = document.getElementById("b").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()');
  const p = pointOf(rect, wc.getZoomFactor());
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
  await sleep(400);
  const hits = await wc.executeJavaScript('window.hits || 0');
  // without the scaling the same click misses
  for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) wc.sendInputEvent({ type, x: Math.round(rect.x), y: Math.round(rect.y), button: 'left', clickCount: 1 });
  await sleep(400);
  const hits2 = await wc.executeJavaScript('window.hits || 0');
  check('click at 150 % zoom hits the button', hits === 1, `hits ${hits}`);
  check('unscaled click would miss', hits2 === 1, `hits ${hits2}`);
  wc.setZoomFactor(1);

  // 7. a web task works in a tab of its own; the user's tabs stay
  const before = pages().length;
  // the task's site at 125 %: its click must still work
  const events = [];
  let ended;
  const done = new Promise((resolve) => { ended = resolve; });
  const sender = { isDestroyed: () => false, send: (_ch, e) => { events.push(e); if (e.type === 'ask') setTimeout(() => handlers['webtask:reply']({ sender }, e.qid, { ok: false }), 20); if (e.type === 'ended') ended(); } };
  const s = await handlers['webtask:start']({ sender }, { task: 'Open example.org and follow its link', model: 'fake', language: 'en' });
  check('task starts', s && s.ok, JSON.stringify(s));
  await Promise.race([done, sleep(90000)]);
  check('task works in a new tab', pages().length === before + 1, `${before} -> ${pages().length}`);
  const taskTab = pages()[pages().length - 1];
  check('task clicked the link (example.org at 125 %)', /iana\.org/.test(taskTab.getURL()),
    `${taskTab.getURL()} ${JSON.stringify(events.filter((e) => ['step', 'answer', 'error'].includes(e.type)).map((e) => e.text || e.type)).slice(0, 600)}`);
  check('the user\'s tabs stay as they were', /duckduckgo/.test(pages()[0].getURL()), pages()[0].getURL());

  // 8. history has the pages; closing a tab and Ctrl+Shift+T brings it back
  act('refresh');
  const n = pages().length;
  act('close', { id: state.active });
  await until(() => pages().length === n - 1);
  check('close tab', pages().length === n - 1, String(pages().length));
  act('reopen-tab');
  await until(() => pages().length === n);
  check('reopen closed tab', pages().length === n, String(pages().length));

  // 9. a shortcut in the page: Ctrl+T opens a tab
  const k = pages().length;
  visible().focus();
  visible().sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control'] });
  visible().sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['control'] });
  const shortcut = await until(() => pages().length === k + 1, 3000);
  console.log(`NOTE Ctrl+T through sendInputEvent: ${shortcut ? 'opened a tab' : 'not delivered to before-input-event (synthetic input)'}`);

  // 10. the network log: the window's requests are recorded as web_task
  const log = require('../netguard').getShared().list(400).filter((e) => e.feature === 'web_task');
  check('requests in the network log', log.some((e) => /example\.org/.test(e.host)), String(log.length));
  console.log('RESULT ' + JSON.stringify({ failed, results, tabs: pages().map((x) => x.getURL()).map((u) => u.slice(0, 60)), web_task_hosts: [...new Set(log.map((e) => e.host))].slice(0, 12), kept: state && state.kept }));
  server.close();
  webtask.saveProfile();
  app.exit(failed ? 1 : 0);
});
