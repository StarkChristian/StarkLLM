// Found on a real Windows PC (8 Nov 2026): the engine download showed changing per-layer lines and no total.
const test = require('node:test');
const assert = require('node:assert');
const { parseSize, createPullProgress, createModelProgress, throttle } = require('../progress');

test('Docker sizes are read in decimal units', () => {
  assert.strictEqual(parseSize('44.04MB'), 44.04e6);
  assert.strictEqual(parseSize('512kB'), 512e3);
  assert.strictEqual(parseSize('1.2 GB'), 1.2e9);
  assert.strictEqual(parseSize('nonsense'), null);
});

test('compose pull lines add up to one overall share of the known total', () => {
  const sizes = new Map([['80db5eaed612', 1e9], ['aaaaaaaaaaaa', 5e8], ['bbbbbbbbbbbb', 5e8]]);
  const p = createPullProgress(sizes);
  assert.ok(p.feed(' 80db5eaed612 Downloading 44.04MB'));
  assert.ok(p.feed('aaaaaaaaaaaa Downloading  250MB'));
  assert.ok(p.feed('bbbbbbbbbbbb Already exists'));
  assert.ok(!p.feed('Image ghcr.io/starkchristian/starkllm-backend:2.0.7 Pulling'));
  assert.strictEqual(p.downloaded(), 44.04e6 + 250e6 + 5e8);
  assert.ok(Math.abs(p.fraction() - (794.04e6 / 2e9)) < 1e-9);
  assert.match(p.text('Downloading the StarkLLM engine'), /^Downloading the StarkLLM engine: 39 % \(794 MB of 2\.0 GB\)$/);
  p.feed('80db5eaed612 Download complete');
  p.feed('aaaaaaaaaaaa Pull complete');
  assert.strictEqual(p.fraction(), 1);
});

test('progress bars printed by a terminal are understood too', () => {
  const p = createPullProgress(new Map([['80db5eaed612', 100e6]]));
  assert.ok(p.feed('80db5eaed612 Downloading [=====>     ]  50MB/100MB'));
  assert.strictEqual(p.fraction(), 0.5);
});

test('without layer sizes only the downloaded amount is shown', () => {
  const p = createPullProgress();
  p.feed('80db5eaed612 Downloading 44.04MB');
  assert.strictEqual(p.fraction(), null);
  assert.match(p.text('Downloading the StarkLLM engine'), /\(44 MB so far\)$/);
});

test('a model download is one figure over all its files', () => {
  const m = createModelProgress();
  m.feed({ status: 'pulling manifest' });
  m.feed({ digest: 'sha256:small', total: 1e6, completed: 1e6 });
  m.feed({ digest: 'sha256:big', total: 4e9, completed: 1e9 });
  assert.ok(Math.abs(m.fraction() - 1.001e9 / 4.001e9) < 1e-9, 'the small finished file does not make it jump to 100 %');
});

test('throttle keeps the last call', async () => {
  const seen = [];
  const t = throttle((x) => seen.push(x), 50);
  t(1); t(2); t(3);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepStrictEqual(seen, [1, 3]);
});
