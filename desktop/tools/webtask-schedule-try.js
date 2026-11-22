// A scheduled web task in the real Electron window code (webtask.js): add, run now (hidden window, looking only),
// run again after the fake site changed its price, and check that the change is noticed.
// xvfb-run -a electron --no-sandbox sched-try.js <desktop dir> <model>
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const desktop = process.argv[process.argv.length - 2];
const model = process.argv[process.argv.length - 1];
app.setPath('userData', fs.mkdtempSync('/tmp/starkllm-sched-'));

app.on("window-all-closed", () => {}); // the real app has its main window
app.whenReady().then(async () => {
  require(path.join(desktop, 'netguard')).initShared(fs.mkdtempSync('/tmp/sched-net-'));
  const webtask = require(path.join(desktop, 'webtask'));
  const handlers = {};
  webtask.register({ handle: (name, fn) => { handlers[name] = fn; } }, { fromApp: () => true, log: (l) => console.log('log:', l) });
  const ev = { sender: { isDestroyed: () => false, send: () => {} } };
  const task = 'Open https://example.com and tell me the main heading of the page.';
  const added = await handlers['webtask:schedule-add'](ev, { task, rule: { every: 'day', time: '08:00' }, model, language: 'en' });
  console.log('added', added.ok, added.schedule && added.schedule.rule);
  const first = await handlers['webtask:schedule-run'](ev, added.schedule.id);
  console.log('run 1:', first.schedule && first.schedule.lastStatus, '|', first.schedule && first.schedule.lastAnswer, '| changed', first.changed);
  // the site changes its prices (easyJet: 71 EUR becomes 59 EUR in the copy of the fake site)
  const f = '/tmp/sched-site/index.html'; fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('71 + (day % 4) * 11', '59 + (day % 4) * 11'));
  const second = await handlers['webtask:schedule-run'](ev, added.schedule.id);
  console.log('run 2:', second.schedule && second.schedule.lastStatus, '|', second.schedule && second.schedule.lastAnswer, '| changed', second.changed);
  const list = await handlers['webtask:schedules'](ev);
  console.log('runs kept:', list.schedules[0].runs.length);
  app.quit();
});
