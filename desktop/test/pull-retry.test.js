// node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const { pullWithRetry } = require('../engine');

function run(failures, opts = {}) {
  let calls = 0;
  const status = [];
  const waits = [];
  const pull = async () => {
    calls++;
    const f = failures[calls - 1];
    if (f) throw new Error(f);
  };
  const p = pullWithRetry('qwen2.5:7b', (t) => status.push(t), { pull, wait: async (ms) => waits.push(ms), log: () => {}, ...opts });
  return { p, get calls() { return calls; }, status, waits };
}

test('a dropped connection is retried and then succeeds', async () => {
  const r = run(['read: connection reset by peer']);
  await r.p;
  assert.strictEqual(r.calls, 2);
  assert.deepStrictEqual(r.waits, [5000]);
  assert.match(r.status[0], /interrupted .*Trying again in 5 s \(attempt 2 of 3\)/);
});

test('gives up after three attempts with the last error', async () => {
  const r = run(['timeout', 'timeout', 'EOF']);
  await assert.rejects(r.p, /EOF/);
  assert.strictEqual(r.calls, 3);
  assert.deepStrictEqual(r.waits, [5000, 15000]);
});

test('a wrong model name is not retried', async () => {
  const r = run(['pull model manifest: file does not exist']);
  await assert.rejects(r.p, /does not exist/);
  assert.strictEqual(r.calls, 1);
  assert.deepStrictEqual(r.waits, []);
});

test('success on the first try waits for nothing', async () => {
  const r = run([]);
  await r.p;
  assert.strictEqual(r.calls, 1);
  assert.deepStrictEqual(r.status, []);
});
