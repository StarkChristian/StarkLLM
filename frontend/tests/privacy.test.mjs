// Windows test of 2.1.0 (N1): the "Fully offline" switch in Settings. In the desktop app the app's bridge sets the app
// and the engine; in a browser the engine decides, and its refusal comes back as a code the panel translates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setOffline, readOffline, OfflineSwitchError } from '../src/utils/privacy.js';

const NOT_ALLOWED = 'Only the administrator of this StarkLLM, or the account that turned "Fully offline" on, can turn it off.';

function setup({ engine = false, refuse = false, bridge = null } = {}) {
  const calls = [];
  const events = [];
  const state = { engine };
  globalThis.window = {
    dispatchEvent: (e) => events.push(e.detail),
    addEventListener() {},
    removeEventListener() {},
    ...(bridge ? { starkllmDesktop: bridge } : {}),
  };
  globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } };
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body && JSON.parse(opts.body) });
    if (url === '/api/v1/privacy/offline') {
      if (refuse) return { ok: false, status: 403, json: async () => ({ detail: NOT_ALLOWED }) };
      state.engine = JSON.parse(opts.body).enabled;
      return { ok: true, status: 200, json: async () => ({ offline: state.engine }) };
    }
    if (url === '/api/v1/privacy/status') return { ok: true, status: 200, json: async () => ({ offline: state.engine }) };
    throw new Error(`unexpected ${url}`);
  };
  return { calls, events, state };
}

function desktopBridge({ app = false, engineError = null, old = false } = {}) {
  const seen = [];
  const s = { app };
  return {
    seen,
    s,
    getPrivacy: async () => ({ offline: s.app, localCounts: {} }),
    setOffline: async (on) => {
      seen.push(on);
      if (old) { s.app = on; return { offline: s.app, localCounts: {} }; }
      if (on || !engineError || engineError === 'unreachable') s.app = on;
      return { offline: s.app, localCounts: {}, engine: engineError ? null : on, engineError, engineDetail: engineError ? 'detail' : null };
    },
  };
}

test('in a browser, the engine is asked and its answer is the new state', async () => {
  const { calls, events } = setup();
  assert.equal(await setOffline('tok', true), true);
  assert.deepEqual(calls.map((c) => [c.url, c.method, c.body]), [['/api/v1/privacy/offline', 'PUT', { enabled: true }]]);
  assert.deepEqual(events, [true]);
});

test('in a browser, a refusal of the engine is a "not_allowed" error the panel can translate', async () => {
  const { events } = setup({ engine: true, refuse: true });
  await assert.rejects(setOffline('tok', false), (e) => e instanceof OfflineSwitchError && e.code === 'not_allowed' && e.message === NOT_ALLOWED);
  assert.deepEqual(events, [], 'nothing announces a change that did not happen');
  assert.equal((await readOffline('tok')).offline, true, 'the switch shows the real state afterwards');
});

test('in the desktop app, the bridge sets app and engine and the account is not asked', async () => {
  const bridge = desktopBridge({ app: true });
  const { calls, events } = setup({ engine: true, refuse: true, bridge });
  assert.equal(await setOffline('tok', false), false);
  assert.deepEqual(bridge.seen, [false]);
  assert.deepEqual(calls, [], 'the engine is not asked with the account, which could be refused');
  assert.deepEqual(events, [false]);
});

test('in the desktop app, an engine that cannot be reached is an error, and the state comes from the bridge', async () => {
  const bridge = desktopBridge({ app: false, engineError: 'unreachable' });
  const { events } = setup({ bridge });
  await assert.rejects(setOffline('tok', true), (e) => e.code === 'engine_unreachable');
  assert.deepEqual(events, [true], 'the app itself is offline');
});

test('in the desktop app, a refused engine keeps both offline', async () => {
  const bridge = desktopBridge({ app: true, engineError: 'refused' });
  setup({ engine: true, bridge });
  await assert.rejects(setOffline('tok', false), (e) => e.code === 'failed');
  assert.equal(bridge.s.app, true);
});

test('an older desktop app sets only itself: the engine is asked with the account, and a refusal turns the app back on', async () => {
  const bridge = desktopBridge({ app: true, old: true });
  const { calls } = setup({ engine: true, refuse: true, bridge });
  await assert.rejects(setOffline('tok', false), (e) => e.code === 'not_allowed');
  assert.deepEqual(bridge.seen, [false, true]);
  assert.equal(bridge.s.app, true, '"offline" wins');
  assert.equal(calls.length, 1);
});

test('reconciling: an offline app turns the engine offline through the bridge, not with the account', async () => {
  const bridge = desktopBridge({ app: true });
  const { calls } = setup({ engine: false, bridge });
  bridge.setOffline = async (on) => { bridge.seen.push(on); return { offline: true, localCounts: {}, engine: true, engineError: null, engineDetail: null }; };
  const s = await readOffline('tok');
  assert.deepEqual(s, { offline: true, desktop: true, engine: true });
  assert.deepEqual(bridge.seen, [true]);
  assert.deepEqual(calls.map((c) => c.url), ['/api/v1/privacy/status']);
});

test('the refusal text is translated in every UI language', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'i18n');
  for (const f of fs.readdirSync(dir).filter((n) => /^[a-z]{2}\.json$/.test(n))) {
    const dict = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.ok(dict[NOT_ALLOWED] && dict[NOT_ALLOWED] !== NOT_ALLOWED, `${f} translates the refusal`);
  }
});
