// Try a web task in the real Electron window of the app (webtask.js), without the rest of the app: a stand-in for
// the chat page answers the questions. For development on a PC or under Xvfb:
//   STARKLLM_OLLAMA_URL=http://127.0.0.1:11434 electron tools/webtask-electron-try.js "the task" [model] [allow]
// Writes every event as one line "EVENT {...}" and "RESULT {...}" at the end; also checks that a web page of the
// window cannot reach this PC.
const { app, ipcMain } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');

const [task, model = 'qwen3:14b', allow = ''] = process.argv.slice(process.argv.findIndex((a) => a.endsWith('webtask-electron-try.js')) + 1);

app.whenReady().then(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webtask-'));
  const guard = require('../netguard').initShared(dir);
  const webtask = require('../webtask');
  const handlers = {};
  const fakeIpc = { handle: (ch, fn) => { handlers[ch] = fn; } };
  webtask.register(fakeIpc, { fromApp: () => true, log: (l) => console.log('LOG', l) });

  const events = [];
  let done;
  const finished = new Promise((r) => { done = r; });
  const sender = {
    isDestroyed: () => false,
    send: (_ch, e) => {
      events.push(e);
      console.log('EVENT ' + JSON.stringify(e).slice(0, 300));
      if (e.type === 'ask') {
        const ok = e.ask === 'confirm' ? allow === 'allow' : false;
        setTimeout(() => handlers['webtask:reply']({ sender }, e.qid, { ok }), 50);
      }
      if (e.type === 'ended') done();
    },
  };
  const event = { sender };
  const r = await handlers['webtask:start'](event, { task, model, language: 'en' });
  console.log('START ' + JSON.stringify(r));
  if (r.ok) await finished;

  // a web page in the window must not reach this PC (the engine, Ollama)
  const { BrowserWindow } = require('electron');
  const w = BrowserWindow.getAllWindows()[0];
  let local = 'no window';
  if (w) {
    local = await w.webContents.executeJavaScript(
      "fetch('http://127.0.0.1:11434/api/tags').then(() => 'REACHED').catch(() => 'blocked')"
    );
  }
  const log = guard.list(200);
  const answer = events.find((e) => e.type === 'answer');
  console.log('RESULT ' + JSON.stringify({
    answer: answer ? answer.text : null,
    steps: events.filter((e) => e.type === 'step').length,
    local_from_page: local,
    network_log: log.filter((e) => e.feature === 'web_task').map((e) => `${e.outcome || 'ok'} ${e.host}`).slice(0, 12),
  }));
  app.quit();
});
