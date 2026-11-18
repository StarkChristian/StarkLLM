// The phone link (docs/android-companion.md): the StarkLLM app for Android talks to StarkLLM on this PC over the home
// network. Off until the user turns it on in Settings > Phone; off again while the app is fully offline.
//
//  * The engine keeps listening on 127.0.0.1 only. This module listens on the home network with TLS and a self-signed
//    certificate (selfcert.js); the phone trusts it because the QR code it scanned holds the certificate's fingerprint.
//  * Pairing: Settings > Phone shows a QR code with the PC's addresses, the port, that fingerprint and a one-time code
//    (5 minutes, single use). The phone trades the code for a device token; only a hash of the token is kept here.
//  * Every request needs a device token and must be on the allow-list (ALLOWED): chat, workspaces, documents, upload,
//    inbox and deadlines. No settings, backup, protection, models, tools or system calls. A chat request cannot pick an
//    online provider: the phone always uses the local model.
//  * Only devices of the home network (and this PC) may connect. Every phone connection is recorded by the network
//    layer (netguard.js, feature "phone_link") and refused while the app is fully offline.
//
// No Electron here: the network layer, the engine address and the session are passed in, so CI tests all of it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { createSelfSigned, fingerprintOf } = require('./selfcert');
const { classify } = require('./netguard');

const FIRST_PORT = 47615;
const PORT_TRIES = 10;
const PAIR_MS = 5 * 60 * 1000;
const MAX_PAIR_FAILURES = 10;
const MAX_DEVICES = 10;
const FAILURES_BEFORE_BLOCK = 20;
const BLOCK_MS = 10 * 60 * 1000;
const SMALL_BODY = 1024 * 1024;        // chat questions and pairing requests are read whole; uploads are streamed
const DEVICE_HEADER = 'x-starkllm-device';

// What a paired phone may ask the engine. Everything else gets 404.
const ALLOWED = [
  ['GET', /^\/api\/v1\/auth\/me$/],
  ['POST', /^\/api\/v1\/auth\/login$/],
  ['GET', /^\/api\/v1\/workspaces\/?$/],
  ['GET', /^\/api\/v1\/chat\/sessions\/\d+$/],
  ['POST', /^\/api\/v1\/chat\/sessions\/\d+$/],
  ['GET', /^\/api\/v1\/chat\/session\/\d+$/],
  ['DELETE', /^\/api\/v1\/chat\/session\/\d+$/],
  ['GET', /^\/api\/v1\/chat\/messages\/\d+$/],
  ['POST', /^\/api\/v1\/chat\/?$/],
  ['POST', /^\/api\/v1\/chat\/save-partial$/],
  ['GET', /^\/api\/v1\/documents\/\d+$/],
  ['GET', /^\/api\/v1\/documents\/\d+\/documents\/\d+\/status$/],
  ['POST', /^\/api\/v1\/documents\/\d+\/upload$/],
  ['GET', /^\/api\/v1\/dashboard\/(home|inbox|inbox\/count|deadlines)$/]
];
const CHAT = /^\/api\/v1\/chat\/?$/;
// fields of a chat request the phone may not set: they would send the question to an online provider
const CHAT_FIELDS_DROPPED = ['provider', 'api_key', 'base_url'];
const FORWARDED_HEADERS = ['content-type', 'content-length', 'accept', 'accept-language', 'authorization'];
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'set-cookie']);

function isAllowed(method, pathname) {
  return ALLOWED.some(([m, re]) => m === method && re.test(pathname));
}

const plainAddress = (a) => String(a || '').replace(/^::ffff:/i, '');
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest();
const sameSecret = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);

// Adapters of virtual machines, containers and VPNs: a phone on the home network cannot reach them
const VIRTUAL = /^(docker|br-|veth|virbr|vmnet|vboxnet|lxc|lxd|cni|flannel|podman|tailscale|zt|wg|tun|tap|utun)|vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|Bluetooth|Teredo|isatap/i;
const MAX_ADDRESSES = 4;

// The PC's addresses on the home network (at most 4, without virtual adapters), the usual home ranges first
function homeAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(interfaces || {})) {
    if (VIRTUAL.test(name)) continue;
    for (const a of list || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal || /^169\.254\./.test(a.address) || classify(a.address) !== 'lan') continue;
      if (!out.includes(a.address)) out.push(a.address);
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return out.sort((x, y) => rank(x) - rank(y)).slice(0, MAX_ADDRESSES);
}

function pairingUri({ pcName, addresses, port, fingerprint, code }) {
  const q = new URLSearchParams({ v: '1', n: pcName, a: addresses.join(','), p: String(port), f: fingerprint, c: code });
  return `starkllm://pair?${q.toString()}`;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' });
  res.end(text);
}

/**
 * dir: folder for phone-link.json and the certificate; guard: the network layer (netguard.js);
 * getApi(): { url, token } of the engine on this PC (token: the local user's session, or null when accounts exist);
 * refreshToken(): signs in the local user again (after the engine said 401).
 */
function createPhoneLink({ dir, guard, getApi, refreshToken = async () => {}, log = () => {}, version = '', pcName = os.hostname(),
  interfaces = () => os.networkInterfaces(), now = () => Date.now(), firstPort = FIRST_PORT, listenHost = '0.0.0.0',
  remoteAllowed = (address) => ['lan', 'this_pc'].includes(classify(plainAddress(address))), onChange = () => {} }) {
  const statePath = path.join(dir, 'phone-link.json');
  const keyPath = path.join(dir, 'phone-link-key.pem');
  const certPath = path.join(dir, 'phone-link-cert.pem');
  let state = { enabled: false, port: null, devices: [] };
  try {
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state = { enabled: saved.enabled === true, port: Number(saved.port) || null, devices: Array.isArray(saved.devices) ? saved.devices : [] };
  } catch (e) {
    // first use: off
  }
  let server = null;
  let port = null;
  let fingerprint = null;
  let lastError = null;
  let pairing = null;            // { code, expires, failures }
  const sockets = new Map();     // open TLS connection -> device id (once it showed a token)
  const rawSockets = new Set();  // every open connection, also during the handshake (closed by stop())
  const failures = new Map();    // address -> { count, until }

  function save() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    } catch (e) {
      log(`phone link: settings not saved (${e.message})`);
    }
  }

  function certificate() {
    try {
      const keyPem = fs.readFileSync(keyPath, 'utf8');
      const certPem = fs.readFileSync(certPath, 'utf8');
      return { keyPem, certPem, fingerprint: fingerprintOf(certPem) };
    } catch (e) {
      const made = createSelfSigned({ name: `StarkLLM phone link (${cleanName(pcName) || 'PC'})` });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(keyPath, made.keyPem, { mode: 0o600 });
      fs.writeFileSync(certPath, made.certPem);
      log('phone link: certificate created');
      return made;
    }
  }

  const blocked = (address) => {
    const f = failures.get(address);
    return Boolean(f && f.until > now());
  };
  const failed = (address) => {
    const f = failures.get(address) || { count: 0, until: 0 };
    f.count += 1;
    if (f.count >= FAILURES_BEFORE_BLOCK) {
      f.until = now() + BLOCK_MS;
      f.count = 0;
      log(`phone link: ${address} blocked for 10 minutes after repeated wrong codes`);
    }
    failures.set(address, f);
  };

  function deviceFor(token) {
    if (!token) return null;
    const h = hash(token).toString('hex');
    return state.devices.find((d) => d.tokenHash && d.tokenHash.length === h.length && crypto.timingSafeEqual(Buffer.from(d.tokenHash), Buffer.from(h))) || null;
  }

  function seen(device) {
    const t = now();
    if (!device.lastSeen || t - Date.parse(device.lastSeen) > 60 * 1000) {
      device.lastSeen = new Date(t).toISOString();
      save();
    }
  }

  async function pair(req, res, address) {
    let body;
    try {
      body = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}');
    } catch (e) {
      return send(res, e.status || 400, { error: 'bad-request' });
    }
    if (!pairing || pairing.expires < now()) {
      pairing = null;
      return send(res, 410, { error: 'pairing-closed' });
    }
    if (typeof body.code !== 'string' || !sameSecret(body.code, pairing.code)) {
      failed(address);
      pairing.failures += 1;
      if (pairing.failures >= MAX_PAIR_FAILURES) {
        pairing = null;
        log('phone link: pairing closed after wrong codes');
        onChange();
      }
      return send(res, 401, { error: 'wrong-code' });
    }
    pairing = null;
    if (state.devices.length >= MAX_DEVICES) {
      onChange();
      return send(res, 409, { error: 'too-many-devices' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const at = new Date(now()).toISOString();
    const device = { id: crypto.randomBytes(8).toString('hex'), name: cleanName(body.name) || 'Phone', created: at, lastSeen: at, tokenHash: hash(token).toString('hex') };
    state.devices.push(device);
    save();
    log(`phone link: "${device.name}" paired`);
    onChange();
    return send(res, 200, { device_id: device.id, token, pc_name: pcName, version });
  }

  async function forward(req, res, url, device) {
    const api = getApi() || {};
    if (!api.url) return send(res, 503, { error: 'engine-not-ready' });
    const target = new URL(api.url);
    const headers = {};
    for (const h of FORWARDED_HEADERS) if (req.headers[h] !== undefined) headers[h] = req.headers[h];
    const injected = !headers.authorization && api.token;
    if (injected) headers.authorization = `Bearer ${api.token}`;
    let body = null;
    if (req.method === 'POST' && CHAT.test(url.pathname)) {
      try {
        const data = JSON.parse((await readBody(req, SMALL_BODY)).toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
        for (const f of CHAT_FIELDS_DROPPED) delete data[f];
        body = Buffer.from(JSON.stringify(data));
      } catch (e) {
        return send(res, e.status || 400, { error: 'bad-request' });
      }
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(body.length);
    }
    const upstream = http.request({
      hostname: target.hostname, port: target.port || 80, method: req.method, path: url.pathname + url.search,
      headers: { ...headers, host: target.host }
    }, (up) => {
      if (up.statusCode === 401 && injected) refreshToken().catch(() => {});
      const out = {};
      for (const [k, v] of Object.entries(up.headers)) if (!HOP_HEADERS.has(k)) out[k] = v;
      res.writeHead(up.statusCode, out);
      up.pipe(res);
    });
    upstream.on('error', (e) => {
      log(`phone link: engine not reached (${e.code || e.message})`);
      send(res, 502, { error: 'engine-not-reached' });
    });
    res.on('close', () => upstream.destroy());
    if (body) upstream.end(body);
    else req.pipe(upstream);
    return undefined;
  }

  async function handle(req, res) {
    const address = plainAddress(req.socket.remoteAddress);
    if (guard.isOffline()) return send(res, 503, { error: 'offline' });
    if (blocked(address)) return send(res, 429, { error: 'try-later' });
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch (e) {
      return send(res, 400, { error: 'bad-request' });
    }
    if (req.method === 'POST' && url.pathname === '/phone/v1/pair') {
      try {
        guard.inbound('phone_link', address, 'A phone asked to pair (Settings > Phone)');
      } catch (e) {
        return send(res, 503, { error: 'offline' });
      }
      return pair(req, res, address);
    }
    const device = deviceFor(req.headers[DEVICE_HEADER]);
    if (!device) {
      failed(address);
      return send(res, 401, { error: 'not-paired' });
    }
    if (!sockets.get(req.socket)) {
      try {
        guard.inbound('phone_link', address, 'A paired phone on the home network (Settings > Phone)');
      } catch (e) {
        return send(res, 503, { error: 'offline' });
      }
      sockets.set(req.socket, device.id);
    }
    seen(device);
    if (req.method === 'GET' && url.pathname === '/phone/v1/hello') {
      const api = getApi() || {};
      return send(res, 200, { pc_name: pcName, version, device_id: device.id, signed_in: Boolean(api.token) });
    }
    if (!isAllowed(req.method, url.pathname)) return send(res, 404, { error: 'not-available-on-phone' });
    return forward(req, res, url, device);
  }

  function listenOn(p, tls) {
    return new Promise((resolve, reject) => {
      const s = https.createServer({ key: tls.keyPem, cert: tls.certPem, minVersion: 'TLSv1.2' }, (req, res) => {
        handle(req, res).catch((e) => {
          log(`phone link: ${e.message}`);
          send(res, 500, { error: 'failed' });
        });
      });
      s.headersTimeout = 30 * 1000;
      s.requestTimeout = 15 * 60 * 1000;     // uploads of large documents
      s.keepAliveTimeout = 30 * 1000;
      s.maxConnections = 32;
      // before TLS: only the home network and this PC, and nothing while fully offline
      s.on('connection', (raw) => {
        if (!remoteAllowed(raw.remoteAddress) || guard.isOffline()) {
          raw.destroy();
          return;
        }
        rawSockets.add(raw);
        raw.on('close', () => rawSockets.delete(raw));
      });
      s.on('secureConnection', (socket) => {
        sockets.set(socket, null);
        socket.on('close', () => sockets.delete(socket));
      });
      s.on('tlsClientError', () => {});
      s.once('error', reject);
      s.listen(p, listenHost, () => {
        s.removeListener('error', reject);
        s.on('error', (e) => log(`phone link: ${e.message}`));
        resolve(s);
      });
    });
  }

  async function start() {
    if (!state.enabled || guard.isOffline()) {
      stop();
      lastError = state.enabled ? 'offline' : null;
      return;
    }
    if (server) return;
    let tls;
    try {
      tls = certificate();
    } catch (e) {
      lastError = 'certificate';
      log(`phone link: no certificate (${e.message})`);
      return;
    }
    const ports = [...new Set([state.port, ...Array.from({ length: PORT_TRIES }, (_, i) => firstPort + i)].filter((p) => p !== null && p !== undefined))];
    for (const p of ports) {
      try {
        server = await listenOn(p, tls);
        port = server.address().port;
        fingerprint = tls.fingerprint;
        lastError = null;
        if (state.port !== port) {
          state.port = port;
          save();
        }
        log(`phone link: listening on port ${port}`);
        onChange();
        return;
      } catch (e) {
        if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') {
          lastError = 'failed';
          log(`phone link: not started (${e.code || e.message})`);
          return;
        }
      }
    }
    lastError = 'port-busy';
    log('phone link: no free port');
  }

  function stop() {
    pairing = null;
    if (!server) return;
    const s = server;
    server = null;
    port = null;
    s.close();
    for (const socket of sockets.keys()) socket.destroy();
    for (const raw of rawSockets) raw.destroy();
    sockets.clear();
    rawSockets.clear();
    log('phone link: stopped');
    onChange();
  }

  function status() {
    if (pairing && pairing.expires < now()) pairing = null;
    return {
      enabled: state.enabled,
      listening: Boolean(server),
      port,
      addresses: server ? homeAddresses(interfaces()) : [],
      fingerprint: server ? fingerprint : null,
      pcName,
      offline: guard.isOffline(),
      error: lastError,
      pairing: pairing ? { expiresAt: pairing.expires } : null,
      devices: state.devices.map(({ id, name, created, lastSeen }) => ({ id, name, created, lastSeen }))
    };
  }

  return {
    status,
    start,
    stop,
    async setEnabled(on) {
      state.enabled = Boolean(on);
      save();
      if (state.enabled) await start();
      else stop();
      return status();
    },
    // The QR code's content; null fields mean it cannot be shown (see error)
    startPairing() {
      if (!server) return { error: guard.isOffline() ? 'offline' : 'not-on' };
      const addresses = homeAddresses(interfaces());
      if (!addresses.length) return { error: 'no-network' };
      if (state.devices.length >= MAX_DEVICES) return { error: 'too-many-devices' };
      pairing = { code: crypto.randomBytes(16).toString('base64url'), expires: now() + PAIR_MS, failures: 0 };
      return { uri: pairingUri({ pcName, addresses, port, fingerprint, code: pairing.code }), expiresAt: pairing.expires, addresses, port };
    },
    cancelPairing() {
      pairing = null;
      return status();
    },
    removeDevice(id) {
      const before = state.devices.length;
      state.devices = state.devices.filter((d) => d.id !== id);
      if (state.devices.length !== before) {
        save();
        for (const [socket, deviceId] of sockets) if (deviceId === id) socket.destroy();
        log('phone link: a phone was removed');
      }
      return status();
    }
  };
}

module.exports = { createPhoneLink, isAllowed, homeAddresses, pairingUri, ALLOWED, CHAT_FIELDS_DROPPED, DEVICE_HEADER, FIRST_PORT };
