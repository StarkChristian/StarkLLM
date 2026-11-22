// The phone link (docs/android-companion.md): the StarkLLM app for Android talks to StarkLLM on this PC over the home
// network. Off until the user turns it on in Settings > Phone; off again while the app is fully offline.
//
//  * The engine keeps listening on 127.0.0.1 only. This module listens on the home network with TLS and a self-signed
//    certificate (selfcert.js); the phone trusts it because the QR code it scanned holds the certificate's fingerprint.
//  * Pairing: Settings > Phone shows a QR code with the PC's addresses, the port, that fingerprint and a one-time code
//    (5 minutes, single use). The phone trades the code for a device token; only a hash of the token is kept here.
//  * Every request needs a device token and must be on the allow-list (ALLOWED) at the phone's level (LEVELS: ask,
//    work, manage; set per phone in Settings > Phone): chat, workspaces, documents, upload, inbox, deadlines, the list
//    of models, dictation. No engine settings, backup, protection, model downloads, tools or system calls. A phone
//    question stays on the PC: a chat request cannot pick an online provider, web search or one of Ollama's cloud
//    models, and the list of models the phone sees has no cloud models. Phones at "manage" may also run a
//    few actions of the desktop app (PHONE_ACTIONS: back up now, go fully offline).
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
const MAX_DEVICES = 10;
const FAILURES_BEFORE_BLOCK = 20;
const BLOCK_MS = 10 * 60 * 1000;
const SMALL_BODY = 1024 * 1024;        // chat questions and pairing requests are read whole; uploads are streamed
const MAX_UPLOAD = 110 * 1024 * 1024;  // a document (the engine refuses more than 100 MB) with its form fields
const MAX_VOICE = 25 * 1024 * 1024;    // a dictation: the engine reads it whole into memory
const LOGIN_WEIGHT = 4;                // a wrong password counts as 4 failures: an address is blocked after 5
const PROBE_LOG_MS = 10 * 60 * 1000;   // a device without a pairing is listed once per 10 minutes and address
const DEVICE_HEADER = 'x-starkllm-device';

// What a phone may do, set per phone in Settings > Phone (owner's plan 2026-11-18, "permission like the Claude app"):
//   ask    - read workspaces, chats, documents, inbox and deadlines; ask questions; dictate (the PC's speech model)
//   work   - also send documents and photos, delete chats, mark deadlines done (the default of a new pairing)
//   manage - also run actions on this PC: back up now, go fully offline (PHONE_ACTIONS)
const LEVELS = ['ask', 'work', 'manage'];
const DEFAULT_LEVEL = 'work';
const atLeast = (level, needed) => LEVELS.indexOf(level) >= LEVELS.indexOf(needed);

// What a paired phone may ask the engine, and the level it needs. Everything else gets 404.
const ALLOWED = [
  ['GET', /^\/api\/v1\/auth\/me$/, 'ask'],
  ['POST', /^\/api\/v1\/auth\/login$/, 'ask'],
  ['GET', /^\/api\/v1\/workspaces\/?$/, 'ask'],
  ['GET', /^\/api\/v1\/chat\/sessions\/\d+$/, 'ask'],
  ['POST', /^\/api\/v1\/chat\/sessions\/\d+$/, 'ask'],
  ['GET', /^\/api\/v1\/chat\/session\/\d+$/, 'ask'],
  ['GET', /^\/api\/v1\/chat\/messages\/\d+$/, 'ask'],
  ['GET', /^\/api\/v1\/chat\/models$/, 'ask'],
  ['POST', /^\/api\/v1\/chat\/?$/, 'ask'],
  ['POST', /^\/api\/v1\/voice\/transcribe$/, 'ask'],
  ['GET', /^\/api\/v1\/documents\/\d+$/, 'ask'],
  ['GET', /^\/api\/v1\/documents\/\d+\/documents\/\d+\/status$/, 'ask'],
  ['GET', /^\/api\/v1\/dashboard\/(home|inbox|inbox\/count|deadlines|system-status)$/, 'ask'],
  ['POST', /^\/api\/v1\/chat\/save-partial$/, 'work'],
  ['DELETE', /^\/api\/v1\/chat\/session\/\d+$/, 'work'],
  ['POST', /^\/api\/v1\/documents\/\d+\/upload$/, 'work'],
  ['PUT', /^\/api\/v1\/dashboard\/deadlines\/done$/, 'work']
];
// Actions on this PC itself (not the engine), for phones at the level "manage": POST /phone/v1/actions/<name>
const PHONE_ACTIONS = ['backup-now', 'go-offline'];
const CHAT = /^\/api\/v1\/chat\/?$/;
// fields of a chat request the phone may not set: they would send the question to an online provider or the web
const CHAT_FIELDS_DROPPED = ['provider', 'api_key', 'base_url', 'use_web_search'];
const MODELS = /^\/api\/v1\/chat\/models$/;
const LOGIN = /^\/api\/v1\/auth\/login$/;
const UPLOAD = /^\/api\/v1\/documents\/\d+\/upload$/;
const VOICE = /^\/api\/v1\/voice\/transcribe$/;
const FORWARDED_HEADERS = ['content-type', 'content-length', 'accept', 'accept-language', 'authorization'];
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'set-cookie']);

// The level an engine call needs, or null when no phone may make it
function neededLevel(method, pathname) {
  const hit = ALLOWED.find(([m, re]) => m === method && re.test(pathname));
  return hit ? hit[2] : null;
}
const isAllowed = (method, pathname) => neededLevel(method, pathname) !== null;

// The largest body a phone may send with an engine call
function bodyLimit(pathname) {
  if (UPLOAD.test(pathname)) return MAX_UPLOAD;
  if (VOICE.test(pathname)) return MAX_VOICE;
  return SMALL_BODY;
}

// Ollama's cloud models run on Ollama's servers although StarkLLM talks to the local Ollama. The same rule as
// is_cloud_model in backend/app/core/netguard.py.
function isCloudModel(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  return n.endsWith(':cloud') || n.endsWith('-cloud') || n.split('/').pop().includes(':cloud') || n.split(':').pop().includes('-cloud');
}
const levelOf = (device) => (LEVELS.includes(device && device.level) ? device.level : DEFAULT_LEVEL);

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
 * sessionFor(user): the session of that account in the PC's window, or null (a phone paired while that account was
 * signed in on the PC uses it); sessionExpired(user): the engine refused it (401).
 * pcStatus(): what the desktop app knows about this PC for the phone (backup, protection); no secrets.
 * actions: { name: async () => result } for PHONE_ACTIONS, run for phones at the level "manage".
 */
function createPhoneLink({ dir, guard, getApi, refreshToken = async () => {}, sessionFor = () => null, sessionExpired = () => {}, log = () => {}, version = '', pcName = os.hostname(),
  interfaces = () => os.networkInterfaces(), now = () => Date.now(), firstPort = FIRST_PORT, listenHost = '0.0.0.0',
  remoteAllowed = (address) => ['lan', 'this_pc'].includes(classify(plainAddress(address))), onChange = () => {},
  pcStatus = () => ({}), actions = {} }) {
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
  const probes = new Map();      // address -> when a device without a pairing from there was last listed

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
  const failed = (address, weight = 1) => {
    const f = failures.get(address) || { count: 0, until: 0 };
    f.count += weight;
    if (f.count >= FAILURES_BEFORE_BLOCK) {
      f.until = now() + BLOCK_MS;
      f.count = 0;
      log(`phone link: ${address} blocked for 10 minutes after repeated wrong codes or passwords`);
    }
    failures.set(address, f);
  };

  // A device without a pairing (or with a removed one) is listed in Settings > Privacy & network as refused, at most
  // once per 10 minutes and address, so someone trying the port on the home network is visible.
  function probed(address) {
    const t = now();
    if (t - (probes.get(address) || 0) < PROBE_LOG_MS) return;
    if (probes.size > 256) probes.clear();
    probes.set(address, t);
    try {
      guard.record({ feature: 'phone_link', host: address, purpose: 'A device without a pairing tried the phone link', method: 'IN', scheme: 'https', outcome: 'blocked', error: 'not paired' });
    } catch (e) {
      // the list is not essential here
    }
  }

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
    // A wrong code blocks only the address that sent it (after 20). It does not close the pairing: with a 128-bit
    // code that would protect nothing, and anyone on the network could close the pairing of the person at the PC.
    if (typeof body.code !== 'string' || !sameSecret(body.code, pairing.code)) {
      failed(address);
      return send(res, 401, { error: 'wrong-code' });
    }
    const user = pairing.user || '';
    pairing = null;
    if (state.devices.length >= MAX_DEVICES) {
      onChange();
      return send(res, 409, { error: 'too-many-devices' });
    }
    const token = crypto.randomBytes(32).toString('base64url');
    const at = new Date(now()).toISOString();
    const device = { id: crypto.randomBytes(8).toString('hex'), name: cleanName(body.name) || 'Phone', created: at, lastSeen: at,
      tokenHash: hash(token).toString('hex'), level: DEFAULT_LEVEL, ...(user ? { user } : {}) };
    state.devices.push(device);
    save();
    log(`phone link: "${device.name}" paired`);
    onChange();
    return send(res, 200, { device_id: device.id, token, pc_name: pcName, version, level: device.level });
  }

  // POST /phone/v1/actions/<name>: an action on this PC (level "manage"). The answer comes before the action takes
  // effect where the action closes the link itself (going fully offline).
  async function runAction(res, name, device) {
    const fn = PHONE_ACTIONS.includes(name) ? actions[name] : null;
    if (!fn) return send(res, 404, { error: 'not-available-on-phone' });
    log(`phone link: "${device.name}" asked for "${name}"`);
    if (name === 'go-offline') {
      send(res, 202, { ok: true, action: name });
      setTimeout(() => Promise.resolve().then(fn).catch((e) => log(`phone link: ${name} failed (${e.message})`)), 300);
      return undefined;
    }
    try {
      const result = await fn();
      return send(res, 200, { ok: !(result && result.ok === false), action: name, result: result || null });
    } catch (e) {
      log(`phone link: ${name} failed (${e.message})`);
      return send(res, 500, { error: 'action-failed', message: String(e.message || e).slice(0, 200) });
    }
  }

  // the engine session for this phone: its own account's (paired while that account was signed in on the PC), else the
  // local user's (one account on the PC). Never another account's.
  function apiFor(device) {
    const api = getApi() || {};
    if (!device || !device.user) return api;
    const own = sessionFor(device.user);
    return { url: api.url, token: own || (device.user === 'local' ? api.token : null), user: device.user, own: Boolean(own) };
  }

  async function forward(req, res, url, address, device) {
    const api = apiFor(device);
    if (!api.url) return send(res, 503, { error: 'engine-not-ready' });
    const limit = bodyLimit(url.pathname);
    if (Number(req.headers['content-length']) > limit) return send(res, 413, { error: 'too-large' });
    const target = new URL(api.url);
    const headers = {};
    for (const h of FORWARDED_HEADERS) if (req.headers[h] !== undefined) headers[h] = req.headers[h];
    const injected = !headers.authorization && api.token;
    if (injected) headers.authorization = `Bearer ${api.token}`;
    let body = null;
    let model = null;
    if (req.method === 'POST' && CHAT.test(url.pathname)) {
      try {
        const data = JSON.parse((await readBody(req, SMALL_BODY)).toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
        for (const f of CHAT_FIELDS_DROPPED) delete data[f];
        model = data.model;
        body = Buffer.from(JSON.stringify(data));
      } catch (e) {
        return send(res, e.status || 400, { error: 'bad-request' });
      }
      if (isCloudModel(model)) return send(res, 403, { error: 'cloud-model-not-on-phone' });
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(body.length);
    }
    const upstream = http.request({
      hostname: target.hostname, port: target.port || 80, method: req.method, path: url.pathname + url.search,
      headers: { ...headers, host: target.host }
    }, (up) => {
      if (up.statusCode === 401 && injected) {
        if (api.own) sessionExpired(api.user);
        else refreshToken().catch(() => {});
      }
      if (up.statusCode === 401 && LOGIN.test(url.pathname)) failed(address, LOGIN_WEIGHT);
      if (up.statusCode === 200 && req.method === 'GET' && MODELS.test(url.pathname)) return withoutCloudModels(up, res);
      const out = {};
      for (const [k, v] of Object.entries(up.headers)) if (!HOP_HEADERS.has(k)) out[k] = v;
      res.writeHead(up.statusCode, out);
      up.pipe(res);
    });
    let tooLarge = false;
    upstream.on('error', (e) => {
      if (tooLarge) return;
      log(`phone link: engine not reached (${e.code || e.message})`);
      send(res, 502, { error: 'engine-not-reached' });
    });
    res.on('close', () => upstream.destroy());
    if (body) {
      upstream.end(body);
      return undefined;
    }
    // a body without a length (chunked) is counted too
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit && !tooLarge) {
        tooLarge = true;
        req.unpipe(upstream);
        upstream.destroy();
        send(res, 413, { error: 'too-large' });
        req.destroy();
      }
    });
    req.pipe(upstream);
    return undefined;
  }

  // GET /api/v1/chat/models: the list without Ollama's cloud models (a small JSON answer, read whole)
  function withoutCloudModels(up, res) {
    const chunks = [];
    let size = 0;
    up.on('data', (c) => {
      size += c.length;
      if (size <= SMALL_BODY) chunks.push(c);
    });
    up.on('end', () => {
      try {
        if (size > SMALL_BODY) throw new Error('too large');
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (Array.isArray(data.models)) data.models = data.models.filter((m) => !isCloudModel(typeof m === 'string' ? m : m && m.name));
        send(res, 200, data);
      } catch (e) {
        log(`phone link: list of models not read (${e.message})`);
        send(res, 502, { error: 'engine-not-reached' });
      }
    });
    up.on('error', () => send(res, 502, { error: 'engine-not-reached' }));
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
      probed(address);
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
    const level = levelOf(device);
    if (req.method === 'GET' && url.pathname === '/phone/v1/hello') {
      const api = apiFor(device);
      return send(res, 200, { pc_name: pcName, version, device_id: device.id, signed_in: Boolean(api.token), level });
    }
    if (req.method === 'GET' && url.pathname === '/phone/v1/status') {
      let pc = {};
      try {
        pc = pcStatus() || {};
      } catch (e) {
        log(`phone link: status (${e.message})`);
      }
      return send(res, 200, { pc_name: pcName, version, level, actions: atLeast(level, 'manage') ? PHONE_ACTIONS : [], ...pc });
    }
    const action = url.pathname.match(/^\/phone\/v1\/actions\/([a-z-]{1,40})$/);
    if (action && req.method === 'POST') {
      if (!atLeast(level, 'manage')) return send(res, 403, { error: 'not-allowed', needs: 'manage', level });
      return runAction(res, action[1], device);
    }
    const needs = neededLevel(req.method, url.pathname);
    if (!needs) return send(res, 404, { error: 'not-available-on-phone' });
    if (!atLeast(level, needs)) return send(res, 403, { error: 'not-allowed', needs, level });
    return forward(req, res, url, address, device);
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
      devices: state.devices.map((d) => ({ id: d.id, name: d.name, created: d.created, lastSeen: d.lastSeen, level: levelOf(d), user: d.user || '' }))
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
    // opts.user: the account signed in on the PC; the phone will belong to it
    startPairing(opts = {}) {
      if (!server) return { error: guard.isOffline() ? 'offline' : 'not-on' };
      const addresses = homeAddresses(interfaces());
      if (!addresses.length) return { error: 'no-network' };
      if (state.devices.length >= MAX_DEVICES) return { error: 'too-many-devices' };
      pairing = { code: crypto.randomBytes(16).toString('base64url'), expires: now() + PAIR_MS, user: String(opts.user || '').slice(0, 200) };
      return { uri: pairingUri({ pcName, addresses, port, fingerprint, code: pairing.code }), expiresAt: pairing.expires, addresses, port };
    },
    cancelPairing() {
      pairing = null;
      return status();
    },
    // Settings > Phone: what this phone may do (LEVELS)
    setLevel(id, level) {
      const device = state.devices.find((d) => d.id === id);
      if (!device || !LEVELS.includes(level)) return { error: 'bad-request' };
      if (device.level !== level) {
        device.level = level;
        save();
        log(`phone link: "${device.name}" may now ${level}`);
      }
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

module.exports = { createPhoneLink, isAllowed, neededLevel, homeAddresses, pairingUri, isCloudModel, bodyLimit, ALLOWED, LEVELS,
  DEFAULT_LEVEL, PHONE_ACTIONS, CHAT_FIELDS_DROPPED, DEVICE_HEADER, FIRST_PORT };
