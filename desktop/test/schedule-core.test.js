// Scheduled web tasks (schedule-core.js): times, missed runs, changes, and "looking only".
const test = require('node:test');
const assert = require('node:assert');
const s = require('../schedule-core');
const { runTask } = require('../webtask-core');

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0);

test('rules are checked', () => {
  assert.deepEqual(s.cleanRule({ every: 'day', time: '8:05' }), { every: 'day', time: '08:05' });
  assert.deepEqual(s.cleanRule({ every: 'week', time: '18:30', weekday: 1 }), { every: 'week', time: '18:30', weekday: 1 });
  for (const bad of [null, { every: 'hour', time: '08:00' }, { every: 'day', time: '25:00' }, { every: 'week', time: '08:00' }, { every: 'week', time: '08:00', weekday: 7 }]) {
    assert.equal(s.cleanRule(bad), null, JSON.stringify(bad));
  }
});

test('the next run: later today, tomorrow, or the next weekday', () => {
  assert.deepEqual(s.nextRun({ every: 'day', time: '08:00' }, at(2026, 12, 1, 7, 0)), at(2026, 12, 1, 8, 0));
  assert.deepEqual(s.nextRun({ every: 'day', time: '08:00' }, at(2026, 12, 1, 8, 0)), at(2026, 12, 2, 8, 0));
  // 1 December 2026 is a Tuesday; the next Monday is the 7th
  assert.deepEqual(s.nextRun({ every: 'week', time: '09:00', weekday: 1 }, at(2026, 12, 1, 12, 0)), at(2026, 12, 7, 9, 0));
  // daylight saving time (Europe, 29 March 2026): the clock time stays
  const n = s.nextRun({ every: 'day', time: '08:00' }, at(2026, 3, 28, 9, 0));
  assert.equal(n.getHours(), 8);
  assert.equal(n.getDate(), 29);
});

test('due: on time, once after the PC was off, never twice, not when paused', () => {
  const sch = { id: 'a', rule: { every: 'day', time: '08:00' }, created: at(2026, 12, 1, 7, 0).getTime(), lastRun: null };
  assert.equal(s.dueSchedules([sch], at(2026, 12, 1, 7, 59)).length, 0);
  assert.equal(s.dueSchedules([sch], at(2026, 12, 1, 8, 0)).length, 1);
  const ran = { ...sch, lastRun: at(2026, 12, 1, 8, 1).getTime() };
  assert.equal(s.dueSchedules([ran], at(2026, 12, 1, 20, 0)).length, 0);
  // the PC was off for three days: one run, not three
  const late = s.dueSchedules([ran], at(2026, 12, 4, 19, 0));
  assert.equal(late.length, 1);
  const after = { ...ran, lastRun: at(2026, 12, 4, 19, 0).getTime() };
  assert.equal(s.dueSchedules([after], at(2026, 12, 4, 23, 0)).length, 0);
  assert.equal(s.dueSchedules([{ ...sch, enabled: false }], at(2026, 12, 1, 9, 0)).length, 0);
});

test('a change is a different answer, not a different spacing; the first run is no change', () => {
  assert.equal(s.changed('', 'easyJet 71 EUR'), false);
  assert.equal(s.changed('easyJet, 71 EUR.', 'easyjet 71 eur'), false);
  assert.equal(s.changed('easyJet, 71 EUR.', 'easyJet, 69 EUR.'), true);
  let x = s.makeSchedule({ task: 'Cheapest flight Berlin–Rome on 12 Dec?', rule: { every: 'day', time: '08:00' }, model: 'qwen3:14b' }, 1000, 's1');
  x = s.recordRun(x, { status: 'done', answer: 'easyJet 71 EUR' }, 2000);
  assert.equal(x.isChange, false);
  x = s.recordRun(x, { status: 'error', answer: 'The site did not answer.' }, 3000);
  assert.equal(x.lastAnswer, 'easyJet 71 EUR'); // a failed run keeps the last answer
  x = s.recordRun(x, { status: 'done', answer: 'easyJet 64 EUR' }, 4000);
  assert.equal(x.isChange, true);
  assert.equal(x.changedAt, 4000);
  assert.equal(x.runs.length, 3);
  assert.equal(s.makeSchedule({ task: '  ', rule: { every: 'day', time: '08:00' } }), null);
});

test('looking only: a scheduled run never clicks "Book" and never types a password', async () => {
  const pages = {
    'https://f.example/': { title: 'Flights', text: 'Berlin to Rome: 71 EUR', elements: [{ i: 1, role: 'button', label: 'Book now' }, { i: 2, role: 'textbox', label: 'Password', kind: 'password' }] },
  };
  let at_ = 'https://f.example/';
  const clicks = [];
  const typed = [];
  const browser = {
    hasPage: () => true,
    async open() {},
    async snapshot() { const p = pages[at_]; return { url: at_, title: p.title, elements: p.elements, text: p.text, more: false }; },
    async click(i) { clicks.push(i); return {}; },
    async focusInfo(i) { return pages[at_].elements.find((e) => e.i === i); },
    async type(i, text) { typed.push(text); return {}; },
  };
  const calls = [
    { name: 'click', arguments: { element: 1 } },
    { name: 'type_text', arguments: { element: 2, text: 'secret' } },
    { name: 'finish', arguments: { answer: 'The cheapest is 71 EUR.' } },
  ];
  let k = 0;
  const res = await runTask({ task: 'cheapest flight', browser, llm: async () => ({ tool_calls: [{ function: calls[k++] }] }), ask: s.lookingOnlyAsk });
  assert.equal(res.status, 'done');
  assert.deepEqual(clicks, []);
  assert.deepEqual(typed, []);
});
