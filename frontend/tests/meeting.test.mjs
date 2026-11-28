// Meeting assistant (2.8, option 13): the clock, the level meter, the recording format, and the parts that reach the
// engine in order and are sent again after a failure (a crash loses at most one part).
import test from 'node:test';
import assert from 'node:assert/strict';
import { PART_MS, PartQueue, formatClock, levelOf, meetingTitle, pickMime, sourceLabel, systemAudioAvailable } from '../src/utils/meeting.js';

test('a part at most every minute', () => {
  assert.ok(PART_MS > 0 && PART_MS <= 60000);
});

test('clock and source times', () => {
  assert.equal(formatClock(0), '00:00:00');
  assert.equal(formatClock(750), '00:12:30');
  assert.equal(formatClock(4000.9), '01:06:40');
  assert.equal(formatClock(-3), '00:00:00');
  assert.equal(sourceLabel('00:12:30'), '[00:12:30]');
  assert.equal(sourceLabel(null), '');
});

test('the level meter: silence is empty, speech moves it, loud is full', () => {
  assert.equal(levelOf(new Uint8Array(512).fill(128)), 0);
  const speech = Uint8Array.from({ length: 512 }, (_, i) => 128 + Math.round(20 * Math.sin(i / 5)));
  const level = levelOf(speech);
  assert.ok(level > 0.3 && level < 1, String(level));
  assert.equal(levelOf(Uint8Array.from({ length: 512 }, (_, i) => (i % 2 ? 255 : 0))), 1);
  assert.equal(levelOf(null), 0);
});

test('the recording format: Opus where the browser has it', () => {
  assert.equal(pickMime(() => true), 'audio/webm;codecs=opus');
  assert.equal(pickMime((m) => m === 'audio/mp4'), 'audio/mp4');
  assert.equal(pickMime(() => { throw new Error('no'); }), '');
});

test('the sound of this PC only where the desktop app offers it', () => {
  assert.equal(systemAudioAvailable(undefined), false);
  assert.equal(systemAudioAvailable({ meeting: { systemAudio: false } }), false);
  assert.equal(systemAudioAvailable({ meeting: { systemAudio: true } }), true);
});

test('the document name', () => {
  assert.equal(meetingTitle('Besprechung', new Date(2026, 10, 28, 9, 5)), 'Besprechung 2026-11-28 09.05');
});

const blob = (text) => ({ size: text.length, text });

test('parts are sent in order, each once', async () => {
  const sent = [];
  const q = new PartQueue(async (i, b) => { await new Promise((r) => setTimeout(r, 2)); sent.push([i, b.text]); });
  q.push(blob('a'));
  q.push(blob('b'));
  assert.equal(q.push(blob('')), -1, 'an empty part is no part');
  q.push(blob('c'));
  await q.flush();
  assert.deepEqual(sent, [[0, 'a'], [1, 'b'], [2, 'c']]);
  assert.equal(q.pending, 0);
  assert.equal(q.sent, 3);
});

test('a part that fails is sent again, nothing is lost or reordered', async () => {
  const sent = [];
  let fails = 2;
  const q = new PartQueue(async (i, b) => {
    if (i === 1 && fails > 0) { fails -= 1; throw new Error('engine busy'); }
    sent.push(b.text);
  }, { wait: () => Promise.resolve() });
  ['a', 'b', 'c'].forEach((x) => q.push(blob(x)));
  await q.flush();
  assert.deepEqual(sent, ['a', 'b', 'c']);
  assert.equal(q.failed, false);
});

test('when the engine is gone for good the queue says so and keeps the parts', async () => {
  const q = new PartQueue(async () => { throw new Error('gone'); }, { maxTries: 3, wait: () => Promise.resolve() });
  q.push(blob('a'));
  await assert.rejects(q.flush());
  assert.equal(q.failed, true);
  assert.equal(q.pending, 1);
});
