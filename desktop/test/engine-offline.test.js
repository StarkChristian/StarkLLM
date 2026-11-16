// Windows test of 2.1.0 (N1): the switch of the desktop app sets the engine too, through /privacy/offline/desktop with
// the desktop key, and the two stay equal ("offline" wins). node --test test/  (no Electron needed)
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createGuard } = require('../netguard');
const { desktopKey, setEngineOffline, switchOffline, OFFLINE_PATH } = require('../engine-offline');

const response = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('the key is the one the engine expects (HMAC-SHA256 of "starkllm-desktop-session" with SECRET_KEY)', () => {
  const secret = 'a'.repeat(64);
  assert.strictEqual(desktopKey(secret), crypto.createHmac('sha256', secret).update('starkllm-desktop-session').digest('hex'));
  assert.notStrictEqual(desktopKey(secret), desktopKey('b'.repeat(64)));
});

test('the engine is asked with PUT, the key in X-Desktop-Key and the wanted state', async () => {
  const seen = [];
  const fetchFn = async (url, opts) => { seen.push({ url, opts }); return response(200, { offline: true }); };
  const r = await setEngineOffline({ fetchFn, apiUrl: 'http://127.0.0.1:8000', key: 'k', on: true });
  assert.deepStrictEqual(r, { ok: true, offline: true });
  assert.strictEqual(seen[0].url, `http://127.0.0.1:8000${OFFLINE_PATH}`);
  assert.strictEqual(OFFLINE_PATH, '/api/v1/privacy/offline/desktop');
  assert.strictEqual(seen[0].opts.method, 'PUT');
  assert.strictEqual(seen[0].opts.headers['X-Desktop-Key'], 'k');
  assert.deepStrictEqual(JSON.parse(seen[0].opts.body), { enabled: true });
});

test('a refusal and an engine that cannot be reached are told apart', async () => {
  const refused = await setEngineOffline({ fetchFn: async () => response(403, { detail: 'Not allowed' }), apiUrl: '', key: 'x', on: false });
  assert.deepStrictEqual(refused, { ok: false, reason: 'refused', status: 403, error: 'Not allowed' });
  const down = await setEngineOffline({ fetchFn: async () => { throw new Error('ECONNREFUSED'); }, apiUrl: '', key: 'x', on: false });
  assert.strictEqual(down.reason, 'unreachable');
  assert.match(down.error, /ECONNREFUSED/);
});

test('turning it on sets the app at once and the engine after it', async () => {
  const g = createGuard({ dir: null });
  const order = [];
  const r = await switchOffline({ guard: g, on: true, setEngine: async (on) => { order.push(['engine', on, g.isOffline()]); return { ok: true, offline: on }; } });
  assert.deepStrictEqual(order, [['engine', true, true]], 'the app was already offline when the engine was asked');
  assert.deepStrictEqual(r, { offline: true, engine: true, engineError: null, engineDetail: null });
});

test('turning it on while the engine cannot be reached keeps the app offline and says so', async () => {
  const g = createGuard({ dir: null });
  const r = await switchOffline({ guard: g, on: true, setEngine: async () => ({ ok: false, reason: 'unreachable', error: 'timeout' }) });
  assert.deepStrictEqual(r, { offline: true, engine: null, engineError: 'unreachable', engineDetail: 'timeout' });
});

test('turning it off asks the engine first, then turns the app off', async () => {
  const g = createGuard({ dir: null });
  g.setOffline(true);
  const order = [];
  const r = await switchOffline({ guard: g, on: false, setEngine: async (on) => { order.push(['engine', on, g.isOffline()]); return { ok: true, offline: false }; } });
  assert.deepStrictEqual(order, [['engine', false, true]]);
  assert.deepStrictEqual(r, { offline: false, engine: false, engineError: null, engineDetail: null });
  assert.strictEqual(g.isOffline(), false);
});

test('when the engine refuses to turn it off, the app stays offline too ("offline" wins)', async () => {
  const g = createGuard({ dir: null });
  g.setOffline(true);
  const r = await switchOffline({ guard: g, on: false, setEngine: async () => ({ ok: false, reason: 'refused', status: 403, error: 'Not allowed' }) });
  assert.deepStrictEqual(r, { offline: true, engine: null, engineError: 'refused', engineDetail: 'Not allowed' });
  assert.strictEqual(g.isOffline(), true);
});

test('when the engine cannot be reached, the app can still go online (first start: the engine is not there yet)', async () => {
  const g = createGuard({ dir: null });
  g.setOffline(true);
  const r = await switchOffline({ guard: g, on: false, setEngine: async () => { throw new Error('no secret yet'); } });
  assert.strictEqual(r.offline, false);
  assert.strictEqual(r.engine, null);
  assert.strictEqual(r.engineError, 'unreachable', 'and the answer says the engine was not changed');
});
