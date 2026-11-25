// A phone away from home reaches its PC through the relay (docs/phone-away.md), end to end:
// relay/server.js + desktop/phone-relay.js + desktop/phonelink.js + a phone that pins the PC's certificate.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const tls = require('tls');
const { Duplex } = require('stream');
const WebSocket = require('ws');
const { createRelay } = require('./server');
const { createPhoneLink, DEVICE_HEADER } = require('../desktop/phonelink');
const { createRelayClient } = require('../desktop/phone-relay');
const { createGuard } = require('../desktop/netguard');
const { fingerprintOf } = require('../desktop/selfcert');

const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return false;
};

// the phone: a WebSocket to the relay, TLS inside it with the pinned certificate, one HTTP request
function phoneRequest(relayPort, id, pin, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/v1/phone?id=${id}`);
    ws.on('unexpected-response', (_req, res) => reject(Object.assign(new Error(`relay ${res.statusCode}`), { status: res.statusCode })));
    ws.on('error', reject);
    ws.on('close', (code) => reject(Object.assign(new Error(`closed ${code}`), { code })));
    ws.on('message', (data, binary) => {
      if (binary || JSON.parse(String(data)).type !== 'ready') return;
      const duplex = new Duplex({
        read() {},
        write(chunk, _enc, cb) { ws.send(chunk, { binary: true }, cb); },
      });
      ws.on('message', (d, bin) => { if (bin) duplex.push(d); });
      ws.on('close', () => duplex.push(null));
      const sock = tls.connect({ socket: duplex, rejectUnauthorized: false, servername: 'starkllm-relay' });
      sock.on('secureConnect', () => {
        if (fingerprintOf(sock.getPeerCertificate(true).raw) !== pin) { reject(new Error('pin')); sock.destroy(); return; }
        const req = http.request({ method, path: p, headers, createConnection: () => sock }, (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => { resolve({ status: res.statusCode, json: text ? JSON.parse(text) : null }); ws.close(); });
        });
        req.on('error', reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });
      sock.on('error', reject);
    });
  });
}

test('a phone allowed away from home reaches its PC through the relay; others do not', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  const engine = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, url: req.url, auth: req.headers.authorization || '' })); });
  await new Promise((r) => engine.listen(0, '127.0.0.1', r));
  const { server: relayServer } = createRelay({ dataDir: path.join(dir, 'relay') });
  await new Promise((r) => relayServer.listen(0, '127.0.0.1', r));
  const relayPort = relayServer.address().port;
  const guard = createGuard({ dir: null });
  const link = createPhoneLink({
    dir: path.join(dir, 'pc'), guard, getApi: () => ({ url: `http://127.0.0.1:${engine.address().port}`, token: 'LOCAL' }),
    interfaces: () => ({ wlan: [{ family: 'IPv4', address: '192.168.0.47', internal: false }] }), firstPort: 0, listenHost: '127.0.0.1',
    relayUrl: `ws://127.0.0.1:${relayPort}`, createRelay: (o) => createRelayClient({ ...o, WebSocketImpl: WebSocket }),
  });
  t.after(() => { link.stop(); relayServer.close(); engine.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  await link.setEnabled(true);
  const q = new URL(link.startPairing().uri).searchParams;
  assert.strictEqual(q.get('r'), `ws://127.0.0.1:${relayPort}`);
  const id = q.get('i');
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  // pairing at home (the phone link's own port)
  const https = require('https');
  const paired = await new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port: link.status().port, method: 'POST', path: '/phone/v1/pair', rejectUnauthorized: false }, (res) => {
      let text = ''; res.on('data', (c) => { text += c; }); res.on('end', () => resolve(JSON.parse(text)));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ code: q.get('c'), name: 'Phone A' }));
  });
  const headers = { [DEVICE_HEADER]: paired.token };

  // away from home is off: the PC is not at the relay
  await assert.rejects(phoneRequest(relayPort, id, q.get('f'), { path: '/phone/v1/hello', headers }), (e) => e.status === 404);

  // on for the PC, but not for this phone: the PC does not even connect to the relay
  link.setAway(true);
  link.setDeviceAway(paired.device_id, false);
  assert.strictEqual(link.status().relay.state, 'off');
  link.setDeviceAway(paired.device_id, true);
  assert.ok(await until(() => link.status().relay.state === 'online'), 'the PC is online at the relay');

  const hello = await phoneRequest(relayPort, id, q.get('f'), { path: '/phone/v1/hello', headers });
  assert.strictEqual(hello.status, 200);
  assert.strictEqual(hello.json.via_relay, true);
  assert.strictEqual(hello.json.away, true);
  const ws = await phoneRequest(relayPort, id, q.get('f'), { path: '/api/v1/workspaces/', headers });
  assert.strictEqual(ws.json.url, '/api/v1/workspaces/');

  // pairing never through the relay
  const pair = await phoneRequest(relayPort, id, q.get('f'), { method: 'POST', path: '/phone/v1/pair', body: { code: 'x', name: 'y' } });
  assert.strictEqual(pair.status, 403);

  // the phone is no longer allowed away from home: refused at once
  link.setDeviceAway(paired.device_id, false);
  assert.ok(await until(async () => {
    try { await phoneRequest(relayPort, id, q.get('f'), { path: '/phone/v1/hello', headers }); return false; } catch (e) { return e.status === 404; }
  }, 15000), 'the relay no longer reaches this PC');
});

test('another PC cannot take an id that is registered', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  const { server } = createRelay({ dataDir: dir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const port = server.address().port;
  const connect = (key) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/pc?id=AAAAAAAAAAAAAAAAAAAAAA`);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', key })));
    ws.on('message', (d) => { if (JSON.parse(String(d)).type === 'hello') { resolve('hello'); ws.close(); } });
    ws.on('close', (code) => resolve(code));
  });
  assert.strictEqual(await connect('k'.repeat(43)), 'hello');
  assert.strictEqual(await connect('z'.repeat(43)), 4403);
  assert.strictEqual(await connect('k'.repeat(43)), 'hello');
});
