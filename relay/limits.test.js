// The relay's limits (review of 23 Nov 2026): nothing is made for unknown PCs, waiting phones are counted per PC,
// registrations have a cap, a damaged key file stops the relay instead of freeing every id.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createRelay, LIMITS } = require('./server');

async function relay(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  const r = createRelay({ dataDir: dir, ...opts });
  await new Promise((ok) => r.server.listen(0, '127.0.0.1', ok));
  t.after(() => { r.server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ...r, port: r.server.address().port, dir };
}

const status = (port, p) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${p}`);
  ws.on('unexpected-response', (_q, res) => resolve(res.statusCode));
  ws.on('open', () => resolve(101));
  ws.on('error', () => {});
});

const pc = (port, id, key) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/pc?id=${id}`);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', key })));
  ws.on('message', (d) => { if (JSON.parse(String(d)).type === 'hello') resolve(ws); });
  ws.on('close', (code) => resolve(code));
});

test('a phone of an unknown PC is refused and leaves nothing behind', async (t) => {
  const r = await relay(t);
  for (let i = 0; i < 20; i++) assert.strictEqual(await status(r.port, `/v1/phone?id=${'X'.repeat(21)}${String.fromCharCode(65 + i)}`), 404);
  assert.strictEqual(r.stats().records, 0);
});

test('waiting phones are counted per PC: one PC that never answers does not block another', async (t) => {
  const r = await relay(t);
  const silent = await pc(r.port, 'S'.repeat(22), 'k'.repeat(40));   // never opens the streams of its phones
  const other = await pc(r.port, 'O'.repeat(22), 'q'.repeat(40));
  other.on('message', () => {});
  const codes = [];
  for (let i = 0; i < LIMITS.waitingPerPc + 2; i++) codes.push(await status(r.port, `/v1/phone?id=${'S'.repeat(22)}`));
  assert.ok(codes.includes(429), 'the silent PC hits its own cap');
  assert.strictEqual(await status(r.port, `/v1/phone?id=${'O'.repeat(22)}`), 101, 'the other PC is not affected');
  silent.close(); other.close();
});

test('registrations of new ids have a cap per minute', async (t) => {
  let clock = 1000000;
  const r = await relay(t, { now: () => clock });
  const results = [];
  for (let i = 0; i < LIMITS.registrationsPerMinute + 3; i++) {
    const id = `R${String(i).padStart(21, '0')}`;
    const ws = await pc(r.port, id, 'k'.repeat(40));
    results.push(typeof ws === 'number' ? ws : 'ok');
    if (typeof ws !== 'number') ws.close();
  }
  assert.strictEqual(results.filter((x) => x === 'ok').length, LIMITS.registrationsPerMinute);
  assert.ok(results.includes(4403));
  clock += 61000;
  const later = await pc(r.port, `Z${'0'.repeat(21)}`, 'k'.repeat(40));
  assert.notStrictEqual(typeof later, 'number', 'a minute later new ids are taken again');
  later.close();
});

test('a damaged key file stops the relay instead of freeing every id', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  fs.writeFileSync(path.join(dir, 'pcs.json'), '{"broken"');
  assert.throws(() => createRelay({ dataDir: dir }));
  fs.rmSync(dir, { recursive: true, force: true });
});
