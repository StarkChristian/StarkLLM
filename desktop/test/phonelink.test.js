const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { createSelfSigned, fingerprintOf } = require('../selfcert');
const { createPhoneLink, isAllowed, neededLevel, homeAddresses, isCloudModel, bodyLimit, DEVICE_HEADER, LEVELS } = require('../phonelink');
const { createGuard } = require('../netguard');
const { qrMatrix } = require('../qr');

// ---- helpers: a fake engine on 127.0.0.1 and a phone that pins the certificate like the Android app

function fakeEngine(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const r = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      seen.push(r);
      if (handler) return handler(r, res);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })));
}

function request(port, { method = 'GET', path: p = '/', headers = {}, body = null, pin = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, method, path: p, headers, rejectUnauthorized: false, agent: false }, (res) => {
      const peer = res.socket.getPeerCertificate(true);
      if (pin && fingerprintOf(peer.raw) !== pin) {
        reject(new Error('certificate does not match the pin'));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (e) {
          // a stream
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== null) req.end(typeof body === 'string' ? body : JSON.stringify(body));
    else req.end();
  });
}

async function setup(t, opts = {}) {
  const engine = await fakeEngine(opts.engine);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phonelink-'));
  const guard = createGuard({ dir: null });
  const api = { url: engine.url, token: 'LOCAL-SESSION' };
  const calls = { refresh: 0 };
  const make = () => createPhoneLink({
    dir, guard, getApi: () => api, refreshToken: async () => { calls.refresh += 1; }, version: '2.4.0', pcName: 'GEEKOM',
    interfaces: () => ({ wlan: [{ family: 'IPv4', address: '192.168.0.47', internal: false }] }),
    firstPort: 0, listenHost: '127.0.0.1', ...opts.link
  });
  const link = make();
  t.after(() => {
    link.stop();
    engine.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { engine, dir, guard, api, calls, link, make };
}

async function paired(t, opts) {
  const s = await setup(t, opts);
  await s.link.setEnabled(true);
  const { uri } = s.link.startPairing();
  const q = new URL(uri).searchParams;
  const port = s.link.status().port;
  const r = await request(port, { method: 'POST', path: '/phone/v1/pair', body: { code: q.get('c'), name: 'Galaxy Z Flip5' }, pin: q.get('f') });
  assert.strictEqual(r.status, 200);
  return { ...s, port, pin: q.get('f'), token: r.json.token, deviceId: r.json.device_id };
}

// ---- the certificate

test('the self-signed certificate is valid X.509 and its fingerprint is what the TLS peer shows', async (t) => {
  const c = createSelfSigned({ name: 'StarkLLM phone link (test)' });
  const x = new crypto.X509Certificate(c.certPem);
  assert.ok(x.verify(x.publicKey));
  assert.ok(x.checkIssued(x));
  assert.match(x.subject, /StarkLLM phone link \(test\)/);
  assert.strictEqual(x.publicKey.asymmetricKeyType, 'ec');
  assert.ok(new Date(x.validTo) > new Date(Date.now() + 19 * 365 * 24 * 3600 * 1000));
  assert.strictEqual(c.fingerprint, fingerprintOf(x.raw));
  assert.strictEqual(c.fingerprint, Buffer.from(x.fingerprint256.replace(/:/g, ''), 'hex').toString('base64url'));
  const server = https.createServer({ key: c.keyPem, cert: c.certPem }, (req, res) => res.end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const res = await request(server.address().port, { pin: c.fingerprint });
  assert.strictEqual(res.text, 'ok');
});

// ---- off by default

test('the phone link is off until the user turns it on', async (t) => {
  const { link } = await setup(t);
  const s = link.status();
  assert.strictEqual(s.enabled, false);
  assert.strictEqual(s.listening, false);
  assert.deepStrictEqual(link.startPairing(), { error: 'not-on' });
});

// ---- pairing

test('a phone pairs with the one-time code of the QR code, and the code works once', async (t) => {
  const s = await setup(t);
  const st = await s.link.setEnabled(true);
  assert.strictEqual(st.listening, true);
  const p = s.link.startPairing();
  const q = new URL(p.uri).searchParams;
  assert.strictEqual(new URL(p.uri).protocol, 'starkllm:');
  assert.strictEqual(q.get('a'), '192.168.0.47');
  assert.strictEqual(q.get('n'), 'GEEKOM');
  assert.strictEqual(q.get('p'), String(st.port));
  assert.strictEqual(q.get('f'), s.link.status().fingerprint);
  const wrong = await request(st.port, { method: 'POST', path: '/phone/v1/pair', body: { code: 'guess', name: 'x' } });
  assert.strictEqual(wrong.status, 401);
  const ok = await request(st.port, { method: 'POST', path: '/phone/v1/pair', body: { code: q.get('c'), name: 'Galaxy\u0007 Z Flip5' }, pin: q.get('f') });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.pc_name, 'GEEKOM');
  assert.ok(ok.json.token.length >= 40);
  const again = await request(st.port, { method: 'POST', path: '/phone/v1/pair', body: { code: q.get('c'), name: 'other' } });
  assert.strictEqual(again.status, 410);
  const devices = s.link.status().devices;
  assert.strictEqual(devices.length, 1);
  assert.strictEqual(devices[0].name, 'Galaxy Z Flip5');
  // only a hash of the token is written down
  const saved = fs.readFileSync(path.join(s.dir, 'phone-link.json'), 'utf8');
  assert.ok(!saved.includes(ok.json.token));
  assert.ok(saved.includes(crypto.createHash('sha256').update(ok.json.token).digest('hex')));
});

test('wrong codes block the address that sent them, not the pairing; the pairing closes after five minutes', async (t) => {
  let clock = Date.now();
  const s = await setup(t, { link: { now: () => clock } });
  await s.link.setEnabled(true);
  const port = s.link.status().port;
  let q = new URL(s.link.startPairing().uri).searchParams;
  for (let i = 0; i < 10; i++) await request(port, { method: 'POST', path: '/phone/v1/pair', body: { code: `wrong${i}` } });
  assert.notStrictEqual(s.link.status().pairing, null);
  assert.strictEqual((await request(port, { method: 'POST', path: '/phone/v1/pair', body: { code: q.get('c'), name: 'Phone' } })).status, 200);
  // 20 failures block the address for 10 minutes, also with the right code
  q = new URL(s.link.startPairing().uri).searchParams;
  for (let i = 0; i < 20; i++) await request(port, { method: 'POST', path: '/phone/v1/pair', body: { code: `wrong${i}` } });
  assert.strictEqual((await request(port, { method: 'POST', path: '/phone/v1/pair', body: { code: q.get('c') } })).status, 429);
  clock += 5 * 60 * 1000 + 1;
  q = new URL(s.link.startPairing().uri).searchParams;
  clock += 5 * 60 * 1000 + 1;
  assert.strictEqual((await request(port, { method: 'POST', path: '/phone/v1/pair', body: { code: q.get('c') } })).status, 410);
});

// ---- requests of a paired phone

test('a paired phone reaches the allowed engine calls with the local session; the device token stays here', async (t) => {
  const s = await paired(t);
  const hello = await request(s.port, { path: '/phone/v1/hello', headers: { [DEVICE_HEADER]: s.token }, pin: s.pin });
  assert.deepStrictEqual(hello.json, { pc_name: 'GEEKOM', version: '2.4.0', device_id: s.deviceId, signed_in: true, level: 'work', away: false, via_relay: false });
  const r = await request(s.port, { path: '/api/v1/workspaces/?x=1', headers: { [DEVICE_HEADER]: s.token, accept: 'application/json', cookie: 'a=b' } });
  assert.strictEqual(r.status, 200);
  const seen = s.engine.seen.at(-1);
  assert.strictEqual(seen.url, '/api/v1/workspaces/?x=1');
  assert.strictEqual(seen.headers.authorization, 'Bearer LOCAL-SESSION');
  assert.strictEqual(seen.headers[DEVICE_HEADER], undefined);
  assert.strictEqual(seen.headers.cookie, undefined);
});

test('without a device token nothing is forwarded', async (t) => {
  const s = await paired(t);
  for (const token of [undefined, 'not-a-token']) {
    const r = await request(s.port, { path: '/api/v1/workspaces/', headers: token ? { [DEVICE_HEADER]: token } : {} });
    assert.strictEqual(r.status, 401);
  }
  assert.strictEqual(s.engine.seen.length, 0);
});

test('calls outside the allow-list are refused, also with tricks in the path', async (t) => {
  const s = await paired(t);
  const refused = [
    ['GET', '/api/v1/system/backup/export'],
    ['POST', '/api/v1/auth/desktop-session'],
    ['POST', '/api/v1/system/protection/unlock'],
    ['DELETE', '/api/v1/workspaces/1'],
    ['GET', '/api/v1/documents/1/../../system/backup/export'],
    ['GET', '/api/v1/documents/1%2F..%2F..%2Fsystem'],
    ['GET', '/v1/models'],
    ['POST', '/mcp'],
    ['POST', '/api/v1/chat/models/pull'],
    ['DELETE', '/api/v1/chat/models/qwen2.5:3b'],
    ['POST', '/api/v1/voice/synthesize'],
  ];
  for (const [method, p] of refused) {
    const r = await request(s.port, { method, path: p, headers: { [DEVICE_HEADER]: s.token } });
    assert.strictEqual(r.status, 404, `${method} ${p}`);
  }
  assert.strictEqual(s.engine.seen.length, 0);
});

test('a chat request cannot choose an online provider, and the answer streams through', async (t) => {
  const s = await paired(t, {
    engine: (r, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-sources-mode': 'documents' });
      res.write('Hello ');
      setTimeout(() => res.end('world'), 20);
    }
  });
  const body = { workspace_id: 3, message: 'Who is Effi?', provider: 'openai', api_key: 'sk-x', base_url: 'https://example.invalid/v1', use_knowledge_base: true };
  const r = await request(s.port, { method: 'POST', path: '/api/v1/chat/', headers: { [DEVICE_HEADER]: s.token, 'content-type': 'application/json' }, body });
  assert.strictEqual(r.text, 'Hello world');
  assert.strictEqual(r.headers['x-sources-mode'], 'documents');
  const sent = JSON.parse(s.engine.seen.at(-1).body);
  assert.deepStrictEqual(sent, { workspace_id: 3, message: 'Who is Effi?', use_knowledge_base: true });
});

test('a phone signed in as another account keeps its own sign-in; a 401 renews the local session', async (t) => {
  const s = await paired(t, { engine: (r, res) => { res.writeHead(r.headers.authorization === 'Bearer LOCAL-SESSION' ? 401 : 200); res.end('{}'); } });
  await request(s.port, { path: '/api/v1/auth/me', headers: { [DEVICE_HEADER]: s.token, authorization: 'Bearer USER-B' } });
  assert.strictEqual(s.engine.seen.at(-1).headers.authorization, 'Bearer USER-B');
  assert.strictEqual(s.calls.refresh, 0);
  const r = await request(s.port, { path: '/api/v1/auth/me', headers: { [DEVICE_HEADER]: s.token } });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(s.calls.refresh, 1);
});

test('a removed phone is refused at once', async (t) => {
  const s = await paired(t);
  s.link.removeDevice(s.deviceId);
  const r = await request(s.port, { path: '/api/v1/workspaces/', headers: { [DEVICE_HEADER]: s.token } });
  assert.strictEqual(r.status, 401);
  assert.deepStrictEqual(s.link.status().devices, []);
});

test('paired phones and the switch survive a restart of the app', async (t) => {
  const s = await paired(t);
  s.link.stop();
  const again = s.make();
  t.after(() => again.stop());
  await again.start();
  const st = again.status();
  assert.strictEqual(st.enabled, true);
  assert.strictEqual(st.listening, true);
  assert.strictEqual(st.fingerprint, s.pin);       // the same certificate: the phone's pin still fits
  const r = await request(st.port, { path: '/phone/v1/hello', headers: { [DEVICE_HEADER]: s.token }, pin: s.pin });
  assert.strictEqual(r.status, 200);
});

// ---- the network layer

test('fully offline closes the phone link; connections are recorded as phone_link', async (t) => {
  const s = await paired(t);
  await request(s.port, { path: '/phone/v1/hello', headers: { [DEVICE_HEADER]: s.token } });
  assert.ok(s.guard.localCounts().phone_link >= 2);   // the pairing and the paired phone (127.0.0.1 here: counted)
  s.guard.setOffline(true);
  await s.link.start();
  const st = s.link.status();
  assert.strictEqual(st.listening, false);
  assert.strictEqual(st.error, 'offline');
  assert.deepStrictEqual(s.link.startPairing(), { error: 'offline' });
  await assert.rejects(request(s.port, { path: '/phone/v1/hello', headers: { [DEVICE_HEADER]: s.token } }));
  s.guard.setOffline(false);
  await s.link.start();
  assert.strictEqual(s.link.status().listening, true);
});

test('connections from outside the home network are closed before TLS', async (t) => {
  const s = await setup(t, { link: { remoteAllowed: () => false } });
  await s.link.setEnabled(true);
  await assert.rejects(request(s.link.status().port, { path: '/phone/v1/hello' }));
});

test('a recorded inbound connection from the home network names the phone link', () => {
  const guard = createGuard({ dir: null });
  const e = guard.inbound('phone_link', '::ffff:192.168.0.97', 'A paired phone on the home network (Settings > Phone)');
  assert.strictEqual(e.host, '192.168.0.97');
  assert.strictEqual(e.zone, 'lan');
  assert.strictEqual(e.method, 'IN');
  assert.strictEqual(e.feature, 'phone_link');
  guard.setOffline(true);
  assert.throws(() => guard.inbound('phone_link', '192.168.0.97'), { code: 'STARKLLM_OFFLINE' });
});

// ---- small parts

test('the allow-list', () => {
  assert.ok(isAllowed('POST', '/api/v1/chat/'));
  assert.ok(isAllowed('POST', '/api/v1/chat'));
  assert.ok(isAllowed('POST', '/api/v1/documents/12/upload'));
  assert.ok(isAllowed('GET', '/api/v1/dashboard/deadlines'));
  assert.ok(!isAllowed('GET', '/api/v1/chat/'));
  assert.ok(!isAllowed('POST', '/api/v1/documents/12/ingest-url'));     // makes the engine go online
  assert.ok(!isAllowed('GET', '/api/v1/dashboard/market-prices'));
  assert.ok(!isAllowed('PUT', '/api/v1/auth/instructions'));
});

test('home addresses: private IPv4 only, home ranges first', () => {
  const list = homeAddresses({
    a: [{ family: 'IPv4', address: '172.20.0.1', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    b: [{ family: 'IPv4', address: '192.168.0.47', internal: false }, { family: 'IPv4', address: '127.0.0.1', internal: true }],
    c: [{ family: 'IPv4', address: '169.254.3.4', internal: false }, { family: 'IPv4', address: '85.1.2.3', internal: false }]
  });
  assert.deepStrictEqual(list, ['192.168.0.47', '172.20.0.1']);
});

test('home addresses leave out containers, virtual machines and VPNs, and are at most four', () => {
  const v4 = (address) => [{ family: 'IPv4', address, internal: false }];
  const list = homeAddresses({
    'docker0': v4('172.17.0.1'), 'br-1a2b3c': v4('192.168.112.1'), 'vEthernet (WSL)': v4('172.29.0.1'),
    'VirtualBox Host-Only Network': v4('192.168.56.1'), 'tailscale0': v4('100.64.0.1'),
    'WLAN': v4('192.168.0.47'), 'Ethernet': v4('10.0.0.5'), 'eth1': v4('10.0.1.5'), 'eth2': v4('10.0.2.5'), 'eth3': v4('10.0.3.5')
  });
  assert.deepStrictEqual(list, ['192.168.0.47', '10.0.0.5', '10.0.1.5', '10.0.2.5']);
});

test('the QR code of a pairing address is a square of a valid size', () => {
  const uri = 'starkllm://pair?v=1&n=GEEKOM&a=192.168.0.47%2C10.0.0.5&p=47615&f=' + 'A'.repeat(43) + '&c=' + 'B'.repeat(22);
  const m = qrMatrix(uri);
  assert.ok(m.length >= 21 && (m.length - 17) % 4 === 0);
  assert.ok(m.every((row) => row.length === m.length));
  // the three finder patterns
  for (const [r, c] of [[0, 0], [0, m.length - 7], [m.length - 7, 0]]) assert.strictEqual(m[r][c] && m[r + 6][c + 6] && !m[r + 1][c + 1], true);
});

// ---- what a phone may do (levels set in Settings > Phone)

test('a new phone may "work": ask, send documents, mark deadlines done; not run actions on the PC', async (t) => {
  const s = await paired(t);
  assert.strictEqual(s.link.status().devices[0].level, 'work');
  const hello = await request(s.port, { path: '/phone/v1/hello', headers: { [DEVICE_HEADER]: s.token } });
  assert.strictEqual(hello.json.level, 'work');
  for (const [method, p] of [['GET', '/api/v1/chat/models'], ['PUT', '/api/v1/dashboard/deadlines/done'], ['POST', '/api/v1/documents/1/upload'],
    ['GET', '/api/v1/dashboard/system-status'], ['POST', '/api/v1/voice/transcribe']]) {
    const r = await request(s.port, { method, path: p, headers: { [DEVICE_HEADER]: s.token, 'content-type': 'application/json' }, body: method === 'GET' ? null : '{}' });
    assert.strictEqual(r.status, 200, `${method} ${p}`);
  }
  const action = await request(s.port, { method: 'POST', path: '/phone/v1/actions/backup-now', headers: { [DEVICE_HEADER]: s.token } });
  assert.strictEqual(action.status, 403);
  assert.deepStrictEqual(action.json, { error: 'not-allowed', needs: 'manage', level: 'work' });
});

test('a phone set to "ask" can read and ask, but not change anything', async (t) => {
  const s = await paired(t);
  s.link.setLevel(s.deviceId, 'ask');
  const seenBefore = s.engine.seen.length;
  for (const [method, p] of [['POST', '/api/v1/documents/1/upload'], ['DELETE', '/api/v1/chat/session/4'], ['PUT', '/api/v1/dashboard/deadlines/done'], ['POST', '/api/v1/chat/save-partial']]) {
    const r = await request(s.port, { method, path: p, headers: { [DEVICE_HEADER]: s.token }, body: method === 'DELETE' ? null : '{}' });
    assert.strictEqual(r.status, 403, `${method} ${p}`);
    assert.strictEqual(r.json.needs, 'work');
  }
  assert.strictEqual(s.engine.seen.length, seenBefore);
  const ok = await request(s.port, { method: 'POST', path: '/api/v1/chat/', headers: { [DEVICE_HEADER]: s.token, 'content-type': 'application/json' }, body: { workspace_id: 1, message: 'x' } });
  assert.strictEqual(ok.status, 200);
});

test('a phone set to "manage" runs the actions of the desktop app; the level survives a restart', async (t) => {
  const done = [];
  const s = await paired(t, { link: {
    pcStatus: () => ({ backup: { enabled: true, lastSuccess: 1700000000000 }, protection: { hasKey: true } }),
    actions: { 'backup-now': async () => { done.push('backup'); return { ok: true, file: 'x.starkbackup' }; }, 'go-offline': async () => { done.push('offline'); } }
  } });
  assert.deepStrictEqual(s.link.setLevel(s.deviceId, 'owner'), { error: 'bad-request' });
  s.link.setLevel(s.deviceId, 'manage');
  const st = await request(s.port, { path: '/phone/v1/status', headers: { [DEVICE_HEADER]: s.token } });
  assert.deepStrictEqual(st.json.actions, ['backup-now', 'go-offline']);
  assert.strictEqual(st.json.backup.enabled, true);
  assert.strictEqual(st.json.level, 'manage');
  const backup = await request(s.port, { method: 'POST', path: '/phone/v1/actions/backup-now', headers: { [DEVICE_HEADER]: s.token } });
  assert.deepStrictEqual(backup.json, { ok: true, action: 'backup-now', result: { ok: true, file: 'x.starkbackup' } });
  const unknown = await request(s.port, { method: 'POST', path: '/phone/v1/actions/format-disk', headers: { [DEVICE_HEADER]: s.token } });
  assert.strictEqual(unknown.status, 404);
  const offline = await request(s.port, { method: 'POST', path: '/phone/v1/actions/go-offline', headers: { [DEVICE_HEADER]: s.token } });
  assert.strictEqual(offline.status, 202);                  // answered first: going offline closes this link
  await new Promise((r) => setTimeout(r, 400));
  assert.deepStrictEqual(done, ['backup', 'offline']);
  s.link.stop();
  const again = s.make();
  t.after(() => again.stop());
  assert.strictEqual(again.status().devices[0].level, 'manage');
});

test('levels of the allow-list', () => {
  assert.deepStrictEqual(LEVELS, ['ask', 'work', 'manage']);
  assert.strictEqual(neededLevel('POST', '/api/v1/chat/'), 'ask');
  assert.strictEqual(neededLevel('POST', '/api/v1/voice/transcribe'), 'ask');
  assert.strictEqual(neededLevel('POST', '/api/v1/documents/3/upload'), 'work');
  assert.strictEqual(neededLevel('POST', '/api/v1/chat/save-partial'), 'work');
  assert.strictEqual(neededLevel('POST', '/api/v1/chat/models/pull'), null);
  assert.strictEqual(neededLevel('GET', '/api/v1/system/backup'), null);
});

test('a phone paired before levels existed may "work"', async (t) => {
  const s = await paired(t);
  const file = path.join(s.dir, 'phone-link.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.devices[0].level;
  fs.writeFileSync(file, JSON.stringify(saved));
  s.link.stop();
  const again = s.make();
  t.after(() => again.stop());
  assert.strictEqual(again.status().devices[0].level, 'work');
});

// ---- a phone question stays on the PC (outside review 2026-11-19)

test('cloud models: the same rule as the engine', () => {
  for (const n of ['gpt-oss:120b-cloud', 'deepseek-v3.1:671b-cloud', 'qwen3-coder:cloud', 'library/kimi-k2:1t-cloud', 'GLM-4.6:CLOUD']) assert.strictEqual(isCloudModel(n), true, n);
  for (const n of ['qwen2.5:7b', 'nomic-embed-text', 'llama3.2:3b', '', null, 'cloudy-model:7b']) assert.strictEqual(isCloudModel(n), false, String(n));
});

test('a phone question cannot use web search or a cloud model, and the phone sees no cloud models', async (t) => {
  const s = await paired(t, {
    engine: (r, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (r.url === '/api/v1/chat/models') return res.end(JSON.stringify({ models: ['qwen2.5:7b', 'gpt-oss:120b-cloud', 'nomic-embed-text', 'qwen3-coder:cloud'] }));
      return res.end('{"ok":true}');
    }
  });
  const h = { [DEVICE_HEADER]: s.token, 'content-type': 'application/json' };
  await request(s.port, { method: 'POST', path: '/api/v1/chat/', headers: h, body: { workspace_id: 1, message: 'x', use_web_search: true, model: 'qwen2.5:7b' } });
  assert.deepStrictEqual(JSON.parse(s.engine.seen.at(-1).body), { workspace_id: 1, message: 'x', model: 'qwen2.5:7b' });
  const before = s.engine.seen.length;
  const cloud = await request(s.port, { method: 'POST', path: '/api/v1/chat/', headers: h, body: { workspace_id: 1, message: 'x', model: 'gpt-oss:120b-cloud' } });
  assert.strictEqual(cloud.status, 403);
  assert.strictEqual(cloud.json.error, 'cloud-model-not-on-phone');
  assert.strictEqual(s.engine.seen.length, before);
  const list = await request(s.port, { path: '/api/v1/chat/models', headers: { [DEVICE_HEADER]: s.token } });
  assert.strictEqual(list.status, 200);
  assert.deepStrictEqual(list.json, { models: ['qwen2.5:7b', 'nomic-embed-text'] });
});

test('requests through the phone link have size limits', async (t) => {
  assert.strictEqual(bodyLimit('/api/v1/documents/3/upload'), 110 * 1024 * 1024);
  assert.strictEqual(bodyLimit('/api/v1/voice/transcribe'), 25 * 1024 * 1024);
  assert.strictEqual(bodyLimit('/api/v1/dashboard/deadlines/done'), 1024 * 1024);
  const s = await paired(t);
  // a declared length over the limit is refused before anything reaches the engine
  const big = await new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port: s.port, method: 'POST', path: '/api/v1/voice/transcribe', headers: { [DEVICE_HEADER]: s.token, 'content-length': String(26 * 1024 * 1024) }, rejectUnauthorized: false, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode);
      req.destroy();
    });
    req.on('error', () => resolve('closed'));
    req.write('x');
  });
  assert.strictEqual(big, 413);
  assert.strictEqual(s.engine.seen.filter((r) => r.url === '/api/v1/voice/transcribe').length, 0);
  // a body without a declared length is counted
  const chunked = await new Promise((resolve) => {
    const req = https.request({ host: '127.0.0.1', port: s.port, method: 'PUT', path: '/api/v1/dashboard/deadlines/done', headers: { [DEVICE_HEADER]: s.token, 'transfer-encoding': 'chunked' }, rejectUnauthorized: false, agent: false }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve('closed'));
    const piece = Buffer.alloc(64 * 1024, 120);
    let n = 0;
    const more = () => {
      while (n < 40) {
        n += 1;
        if (!req.write(piece)) return req.once('drain', more);
      }
      req.end();
    };
    more();
  });
  assert.ok(chunked === 413 || chunked === 'closed', String(chunked));
  const done = s.engine.seen.filter((r) => r.url === '/api/v1/dashboard/deadlines/done');
  assert.ok(done.every((r) => r.body.length <= 1024 * 1024));
});

test('wrong passwords through the phone link block the address after five', async (t) => {
  const s = await paired(t, {
    engine: (r, res) => {
      res.writeHead(r.url === '/api/v1/auth/login' ? 401 : 200, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });
  const h = { [DEVICE_HEADER]: s.token, 'content-type': 'application/json', authorization: 'Bearer x' };
  for (let i = 0; i < 5; i++) {
    const r = await request(s.port, { method: 'POST', path: '/api/v1/auth/login', headers: h, body: { username: 'anna', password: `guess${i}` } });
    assert.strictEqual(r.status, 401);
  }
  const blocked = await request(s.port, { method: 'POST', path: '/api/v1/auth/login', headers: h, body: { username: 'anna', password: 'guess5' } });
  assert.strictEqual(blocked.status, 429);
});

test('a device without a pairing is listed as refused, once per ten minutes', async (t) => {
  const s = await paired(t);
  const recorded = [];
  const record = s.guard.record;
  s.guard.record = (e) => {
    recorded.push(e);
    return record.call(s.guard, e);
  };
  for (let i = 0; i < 3; i++) await request(s.port, { path: '/api/v1/workspaces/', headers: { [DEVICE_HEADER]: 'not-a-token' } });
  const refused = recorded.filter((e) => e.feature === 'phone_link' && e.outcome === 'blocked');
  assert.strictEqual(refused.length, 1);
  assert.strictEqual(refused[0].error, 'not paired');
});

// ---- several accounts on one PC (owner, 22 Nov 2026)

test('a phone belongs to the account signed in on the PC when it paired, and uses only that session', async (t) => {
  const sessions = new Map([['anna', 'ANNA-SESSION'], ['ben', 'BEN-SESSION']]);
  const expired = [];
  const s = await setup(t, { link: { sessionFor: (u) => sessions.get(u) || null, sessionExpired: (u) => expired.push(u) } });
  s.api.token = null; // several accounts: no local user's session
  await s.link.setEnabled(true);
  const q = new URL(s.link.startPairing({ user: 'anna' }).uri).searchParams;
  const port = s.link.status().port;
  const r = await request(port, { method: 'POST', path: '/phone/v1/pair', body: { code: q.get('c'), name: 'Phone A' }, pin: q.get('f') });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(s.link.status().devices[0].user, 'anna');
  const headers = { [DEVICE_HEADER]: r.json.token };
  const hello = await request(port, { path: '/phone/v1/hello', headers, pin: q.get('f') });
  assert.strictEqual(hello.json.signed_in, true);
  await request(port, { path: '/api/v1/workspaces/', headers, pin: q.get('f') });
  assert.strictEqual(s.engine.seen.at(-1).headers.authorization, 'Bearer ANNA-SESSION');
  // the account is no longer signed in on the PC: no other account's session is used
  sessions.delete('anna');
  const later = await request(port, { path: '/phone/v1/hello', headers, pin: q.get('f') });
  assert.strictEqual(later.json.signed_in, false);
});

test('a phone paired without an account uses the local user, as before', async (t) => {
  const s = await paired(t);
  const hello = await request(s.port, { path: '/phone/v1/hello', headers: { [DEVICE_HEADER]: s.token }, pin: s.pin });
  assert.strictEqual(hello.json.signed_in, true);
  assert.strictEqual(s.link.status().devices[0].user, '');
});

test('a phone keeps its own sealed session after a restart, and loses its pairing when its account signs out', async (t) => {
  const seal = (x) => Buffer.from(`sealed:${x}`).toString('base64');
  const unseal = (x) => Buffer.from(x, 'base64').toString().replace(/^sealed:/, '');
  const s = await setup(t, { link: { seal, unseal } });
  s.api.token = null;
  await s.link.setEnabled(true);
  const q = new URL(s.link.startPairing({ user: 'anna', session: 'ANNA-PHONE-SESSION' }).uri).searchParams;
  const port = s.link.status().port;
  const r = await request(port, { method: 'POST', path: '/phone/v1/pair', body: { code: q.get('c'), name: 'Phone A' }, pin: q.get('f') });
  assert.strictEqual(r.status, 200);
  const saved = fs.readFileSync(path.join(s.dir, 'phone-link.json'), 'utf8');
  assert.ok(!saved.includes('ANNA-PHONE-SESSION'), 'the session is not in the file as plain text');
  s.link.stop();
  const again = s.make();
  t.after(() => again.stop());
  await again.setEnabled(true);
  const port2 = again.status().port;
  const headers = { [DEVICE_HEADER]: r.json.token };
  const hello = await request(port2, { path: '/phone/v1/hello', headers, pin: q.get('f') });
  assert.strictEqual(hello.json.signed_in, true);
  await request(port2, { path: '/api/v1/workspaces/', headers, pin: q.get('f') });
  assert.strictEqual(s.engine.seen.at(-1).headers.authorization, 'Bearer ANNA-PHONE-SESSION');
  again.removeDevicesOf('anna');
  assert.strictEqual(again.status().devices.length, 0);
  const gone = await request(port2, { path: '/phone/v1/hello', headers, pin: q.get('f') });
  assert.strictEqual(gone.status, 401);
});
