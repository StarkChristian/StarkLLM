import test from 'node:test';
import assert from 'node:assert/strict';
import { initialWebTask, reduceWebTask, answered } from '../src/utils/webTask.js';

const run = (events) => events.reduce(reduceWebTask, initialWebTask());

test('steps, a question and the answer', () => {
  const s = run([
    { type: 'started' },
    { type: 'step', action: 'open', detail: 'https://a.example/', url: 'https://a.example/' },
    { type: 'ask', qid: 'q1', ask: 'confirm', text: 'Book', url: 'https://a.example/' },
  ]);
  assert.equal(s.status, 'running');
  assert.equal(s.steps.length, 1);
  assert.deepEqual(s.ask, { qid: 'q1', kind: 'confirm', text: 'Book', url: 'https://a.example/', siteKind: '' });
  const s2 = reduceWebTask(answered(s, 'q1'), { type: 'answer', text: '71 EUR', url: 'https://a.example/r', title: 'Results' });
  assert.equal(s2.ask, null);
  assert.equal(s2.status, 'done');
  assert.equal(s2.answer, '71 EUR');
  assert.equal(s2.url, 'https://a.example/r');
});

test('an answer to another question leaves the open one', () => {
  const s = run([{ type: 'ask', qid: 'q2', ask: 'handoff', text: 'captcha' }]);
  assert.equal(answered(s, 'q1').ask.qid, 'q2');
});

test('a run that ends without an answer is not finished; stop and error are kept', () => {
  assert.equal(run([{ type: 'started' }, { type: 'ended' }]).status, 'error');
  assert.equal(run([{ type: 'started' }, { type: 'stopped' }, { type: 'ended' }]).status, 'stopped');
  const e = run([{ type: 'started' }, { type: 'error', text: 'offline' }, { type: 'ended' }]);
  assert.equal(e.status, 'error');
  assert.equal(e.error, 'offline');
});

test('pause and resume', async () => {
  const s = run([{ type: 'started' }, { type: 'paused' }]);
  assert.equal(s.paused, true);
  assert.equal(reduceWebTask(s, { type: 'resumed' }).paused, false);
  assert.equal(reduceWebTask(s, { type: 'stopped' }).paused, false);
});

test('a follow-up uses the newest answer only when it is a finished web task', async () => {
  const { previousWebTask } = await import('../src/utils/webTask.js');
  const done = { role: 'assistant', content: 'easyJet 82 EUR', webTask: { status: 'done', answer: 'easyJet 82 EUR' } };
  assert.deepEqual(previousWebTask([{ role: 'user', content: 'flight 13th?' }, done]), { task: 'flight 13th?', answer: 'easyJet 82 EUR' });
  assert.equal(previousWebTask([{ role: 'user', content: 'flight 13th?' }, done, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]), null);
  assert.equal(previousWebTask([{ role: 'user', content: 'x' }, { ...done, webTask: { status: 'error' } }]), null);
  assert.equal(previousWebTask([]), null);
});

test('saved web tasks are templates with the tag web-task', async () => {
  const { isWebTaskTemplate, initialWebTask } = await import('../src/utils/webTask.js');
  assert.equal(isWebTaskTemplate({ tags: 'web-task' }), true);
  assert.equal(isWebTaskTemplate({ tags: 'travel, web-task' }), true);
  assert.equal(isWebTaskTemplate({ tags: 'web' }), false);
  assert.equal(isWebTaskTemplate(null), false);
  assert.equal(initialWebTask('find a flight').task, 'find a flight');
});

test('terminal: the folder, a command question with its details, the output of a step and the changed files', async () => {
  const { initialWebTask, reduceWebTask } = await import('../src/utils/webTask.js');
  let s = reduceWebTask(initialWebTask('fix the tests'), { type: 'started', folder: 'demo' });
  assert.equal(s.folder, 'demo');
  s = reduceWebTask(s, { type: 'ask', qid: 'q1', ask: 'command', text: 'npm test', extra: { network: false, deletes: false, folder: 'demo' } });
  assert.equal(s.ask.kind, 'command');
  assert.equal(s.ask.extra.folder, 'demo');
  s = reduceWebTask(s, { type: 'step', action: 'command', detail: 'npm test', extra: { code: 1, output: '1 failing' } });
  assert.equal(s.steps[0].extra.code, 1);
  s = reduceWebTask(s, { type: 'answer', text: 'fixed', files: ['src/add.js'] });
  assert.deepEqual(s.files, ['src/add.js']);
});
