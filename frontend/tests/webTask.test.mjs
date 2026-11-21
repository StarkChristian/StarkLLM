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
  assert.deepEqual(s.ask, { qid: 'q1', kind: 'confirm', text: 'Book', url: 'https://a.example/' });
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
