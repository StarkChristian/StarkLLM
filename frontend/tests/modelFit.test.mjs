// The model picker (StarkLLM 2.7) in the web UI: download time from the download itself, sizes, the order of the
// Model Hub for this PC.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadTracker, durationParts, memoryText, sizeText, sortForThisPc, mainGraphics } from '../src/utils/modelFit.js';

const GIB = 1024 ** 3;

test('before the first seconds of a download only the size is known, then the time left', () => {
  const d = createDownloadTracker();
  d.feed({ status: 'pulling manifest' }, 0);
  d.feed({ digest: 'a', total: 5e9, completed: 0 }, 0);
  d.feed({ digest: 'b', total: 1e6, completed: 1e6 }, 500);
  assert.equal(d.state().total, 5e9 + 1e6);
  assert.equal(d.state().secondsLeft, null);
  d.feed({ digest: 'a', total: 5e9, completed: 100e6 }, 2000);
  assert.equal(d.state().secondsLeft, null); // still in the first seconds
  d.feed({ digest: 'a', total: 5e9, completed: 300e6 }, 3000);
  const s = d.state();
  assert.equal(s.percent, 6);
  assert.equal(s.secondsLeft, 47); // 4.7 GB left at 100 MB/s, measured from this download only
});

test('a resumed download does not count what was already on the PC as speed', () => {
  const d = createDownloadTracker();
  d.feed({ digest: 'a', total: 5e9, completed: 4e9 }, 0);
  d.feed({ digest: 'a', total: 5e9, completed: 4.1e9 }, 4000);
  assert.equal(d.state().secondsLeft, 36);
});

test('a stalled download shows no time rather than a wrong one', () => {
  const d = createDownloadTracker();
  d.feed({ digest: 'a', total: 5e9, completed: 1e9 }, 0);
  d.feed({ digest: 'a', total: 5e9, completed: 1e9 }, 10000);
  assert.equal(d.state().secondsLeft, null);
});

test('durations', () => {
  assert.deepEqual(durationParts(42), { unit: 's', n: 42 });
  assert.deepEqual(durationParts(150), { unit: 'min', n: 3 });
  assert.deepEqual(durationParts(2 * 3600 + 600), { unit: 'h', h: 2, m: 10 });
});

test('memory as the card is sold, downloads as Ollama shows them', () => {
  assert.equal(memoryText(12 * GIB), '12 GB');
  assert.equal(memoryText(18.4e9), '17 GB');
  assert.equal(memoryText(3.1 * GIB), '3.1 GB');
  assert.equal(memoryText(512 * 1024 * 1024), '512 MB');
  assert.equal(sizeText(5.2e9), '5.2 GB');
  assert.equal(sizeText(274e6), '274 MB');
});

test('the Model Hub shows the models recommended for this PC first, then those that fit', () => {
  const list = [
    { name: 'big', fit: { fit: 'no' } },
    { name: 'tight', fit: { fit: 'tight' } },
    { name: 'eyes', recommended: 'vision', fit: { fit: 'good' } },
    { name: 'ok', fit: { fit: 'good' } },
    { name: 'chat', recommended: 'text', fit: { fit: 'good' } },
    { name: 'unknown' },
  ];
  assert.deepEqual(sortForThisPc(list).map((m) => m.name), ['chat', 'eyes', 'ok', 'tight', 'unknown', 'big']);
});

test('the graphics the fit is judged by: the largest card of its own, else integrated graphics', () => {
  const igpu = { name: 'Radeon 780M', kind: 'integrated', vram_total: 9 * GIB };
  const card = { name: 'RTX 4070', kind: 'discrete', vram_total: 12 * GIB };
  assert.equal(mainGraphics({ gpus: [igpu, card] }).name, 'RTX 4070');
  assert.equal(mainGraphics({ gpus: [igpu] }).name, 'Radeon 780M');
  assert.equal(mainGraphics({ gpus: [{ ...igpu, vram_total: 0 }] }), null);
  assert.equal(mainGraphics(null), null);
});
