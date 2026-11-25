// StarkLLM relay (docs/phone-away.md): lets a paired phone reach its PC when it is not in the home network.
//
// The relay only introduces the two and passes bytes on. The phone's connection to the PC is TLS from end to end with
// the PC's own certificate, which the phone checks against the fingerprint it scanned when pairing (as at home): the
// relay sees encrypted bytes only, never a question, an answer, a document or a device token. It keeps no content and
// writes no log of content.
//
//   PC     -> WebSocket /v1/pc?id=<pc id>          first message {"type":"auth","key":<secret>}
//             (then the relay sends {"type":"open","sid":...} for each phone)
//   PC     -> WebSocket /v1/pc-stream?id=<id>&sid= first message {"type":"auth","key":<secret>}, then the bytes
//   phone  -> WebSocket /v1/phone?id=<pc id>                                       (the bytes; TLS to the PC inside)
//
// An id is a random 128-bit value the PC makes (it is in the pairing QR code). The first PC that registers an id keeps
// it: the relay stores a SHA-256 of its secret, later registrations must show the same secret.
//
// Limits (review of 23 Nov 2026): everything is counted per PC; a phone of an unknown or offline PC is refused before
// any state is made; registrations, unauthenticated connections and buffered bytes have caps; a PC record is dropped
// when nothing uses it; errors in a handler never stop the relay.
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const ID = /^[A-Za-z0-9_-]{22,64}$/;
const SECRET = /^[A-Za-z0-9_-]{32,128}$/;
const LIMITS = {
  streamsPerPc: 16,          // phone connections at the same time for one PC
  waitingPerPc: 8,           // phones waiting for their PC to answer, per PC
  waitingTotal: 2000,        // the same for all PCs together
  openPerMinute: 60,         // new phone connections per PC and minute
  pcWaitMs: 10000,           // the PC has this long to open the stream of a phone
  idleMs: 6 * 60 * 1000,     // a stream without any traffic (data or ping) is closed; longer than the phone's read timeout
  maxFrame: 1024 * 1024,     // bytes per WebSocket message
  maxBuffered: 8 * 1024 * 1024, // bytes waiting for a slow receiver before the stream is closed
  bytesPerMinute: 200 * 1024 * 1024, // per PC, both directions together
  registrationsPerMinute: 30,  // new PC ids, for all callers together
  maxPcs: 100000,            // registered PC ids
  authPending: 500,          // connections that have not shown their secret yet
};

function hash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function sameHash(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createRelay({ dataDir = path.join(__dirname, 'data'), log = () => {}, now = () => Date.now(), heartbeatMs = 30000 } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const keysPath = path.join(dataDir, 'pcs.json');
  let keys = {};
  if (fs.existsSync(keysPath)) {
    // a damaged file must not free every id for anyone: the relay does not start (the file was written atomically)
    keys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));
  }
  const saveKeys = () => {
    const tmp = `${keysPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(keys));
    fs.renameSync(tmp, keysPath);
  };

  const pcs = new Map();      // id -> { control, streams: Map(sid -> stream), waiting: Set(sid), opened: [times], bytes, minute }
  const waiting = new Map();  // sid -> { id, phone, timer }
  let registrations = [];
  let authPending = 0;

  function pcOf(id) {
    let p = pcs.get(id);
    if (!p) { p = { control: null, streams: new Map(), waiting: new Set(), opened: [], bytes: 0, minute: 0 }; pcs.set(id, p); }
    return p;
  }
  function dropIfUnused(id) {
    const p = pcs.get(id);
    if (p && !p.control && p.streams.size === 0 && p.waiting.size === 0) pcs.delete(id);
  }

  // the PC's secret: the first one registers the id (within the caps), later ones must match
  function pcAllowed(id, secret) {
    if (!ID.test(id || '') || !SECRET.test(secret || '')) return false;
    const h = hash(secret);
    if (keys[id]) return sameHash(keys[id].key, h);
    const t = now();
    registrations = registrations.filter((x) => t - x < 60000);
    if (registrations.length >= LIMITS.registrationsPerMinute || Object.keys(keys).length >= LIMITS.maxPcs) return false;
    registrations.push(t);
    keys[id] = { key: h, since: new Date(t).toISOString() };
    saveKeys();
    return true;
  }

  function count(p, n) {
    const m = Math.floor(now() / 60000);
    if (p.minute !== m) { p.minute = m; p.bytes = 0; }
    p.bytes += n;
    return p.bytes <= LIMITS.bytesPerMinute;
  }

  function pipe(id, sid, phone, pcWs) {
    const p = pcOf(id);
    const s = { phone, pc: pcWs, timer: null };
    p.streams.set(sid, s);
    let ended = false;
    const end = (code) => {
      if (ended) return;
      ended = true;
      clearTimeout(s.timer);
      p.streams.delete(sid);
      for (const ws of [phone, pcWs]) { try { ws.close(code); } catch (e) { /* closed */ } }
      dropIfUnused(id);
    };
    const idle = () => { clearTimeout(s.timer); s.timer = setTimeout(() => end(1000), LIMITS.idleMs); };
    const forward = (from, to) => (data, binary) => {
      if (!binary) return;
      if (!count(p, data.length)) return end(4429);
      // a receiver that does not read: the stream is closed instead of keeping its bytes here
      if (to.bufferedAmount > LIMITS.maxBuffered) return end(4413);
      idle();
      if (to.readyState === 1) to.send(data, { binary: true });
      return undefined;
    };
    idle();
    phone.on('message', forward(phone, pcWs));
    pcWs.on('message', forward(pcWs, phone));
    // pings keep a stream alive while the PC thinks (a large model can take minutes before its first word)
    for (const ws of [phone, pcWs]) {
      ws.on('ping', idle);
      ws.on('pong', idle);
      ws.on('close', () => end(1000));
      ws.on('error', () => end(1011));
    }
    // the phone may now start its TLS handshake
    phone.send(JSON.stringify({ type: 'ready' }));
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('StarkLLM relay: nothing here');
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrame, perMessageDeflate: false });
  // connections that died without closing (a PC that went to sleep, a phone that lost its network) are found by a
  // ping every 30 s: whoever has not answered the last one is closed, so a PC is not shown online when it is gone
  wss.on('connection', (ws) => { ws.alive = true; ws.on('pong', () => { ws.alive = true; }); });
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false;
      try { ws.ping(); } catch (e) { /* closed */ }
    }
  }, heartbeatMs);
  beat.unref();
  server.on('close', () => clearInterval(beat));

  function handleUpgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://relay'); } catch (e) { return socket.destroy(); }
    const id = url.searchParams.get('id') || '';
    const reject = (status) => { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (!ID.test(id)) return reject('400 Bad Request');

    if (url.pathname === '/v1/pc' || url.pathname === '/v1/pc-stream') {
      if (authPending >= LIMITS.authPending) return reject('503 Service Unavailable');
      authPending += 1;
      // the PC shows its secret in its first message (WebSocket clients cannot always send headers)
      return wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req); // the heartbeat watches it (noServer mode does not emit this by itself)
        let counted = true;
        const done = () => { if (counted) { counted = false; authPending -= 1; } };
        const timer = setTimeout(() => { done(); ws.close(4401); }, 5000);
        ws.on('close', done);
        ws.once('message', (data, binary) => {
          clearTimeout(timer);
          done();
          try {
            let m = null;
            try { m = binary ? null : JSON.parse(String(data)); } catch (e) { m = null; }
            if (!m || m.type !== 'auth' || !pcAllowed(id, m.key)) return ws.close(4403);
            return pcConnected(ws, url, id);
          } catch (e) {
            log(`auth failed: ${e.message}`);
            try { ws.close(1011); } catch (e2) { /* closed */ }
            return undefined;
          }
        });
      });
    }

    if (url.pathname === '/v1/phone') {
      const p = pcs.get(id);
      if (!p || !p.control) return reject('404 Not Found');      // the PC is not online (or not allowed away from home)
      const t = now();
      p.opened = p.opened.filter((x) => t - x < 60000);
      if (p.opened.length >= LIMITS.openPerMinute || p.streams.size >= LIMITS.streamsPerPc
          || p.waiting.size >= LIMITS.waitingPerPc || waiting.size >= LIMITS.waitingTotal) return reject('429 Too Many Requests');
      p.opened.push(t);
      return wss.handleUpgrade(req, socket, head, (phone) => {
        wss.emit('connection', phone, req);
        const sid = crypto.randomBytes(16).toString('base64url');
        const forget = () => { if (waiting.delete(sid)) { p.waiting.delete(sid); dropIfUnused(id); } };
        const timer = setTimeout(() => { forget(); try { phone.close(4504); } catch (e) { /* closed */ } }, LIMITS.pcWaitMs);
        waiting.set(sid, { id, phone, timer });
        p.waiting.add(sid);
        phone.on('close', () => { clearTimeout(timer); forget(); });
        // bytes of the phone before "ready" would be lost: the phone waits for "ready" before its TLS handshake
        try { p.control.send(JSON.stringify({ type: 'open', sid })); } catch (e) { phone.close(4404); }
      });
    }
    return reject('404 Not Found');
  }

  function pcConnected(ws, url, id) {
    const p = pcOf(id);
    if (url.pathname === '/v1/pc') {
      if (p.control) { try { p.control.close(4000, 'replaced'); } catch (e) { /* closed */ } }
      p.control = ws;
      ws.on('close', () => { if (p.control === ws) p.control = null; dropIfUnused(id); });
      ws.on('message', () => {}); // keep-alive pings of the PC
      ws.send(JSON.stringify({ type: 'hello' }));
      log(`pc online (${id.slice(0, 6)}…)`);
      return undefined;
    }
    const sid = url.searchParams.get('sid') || '';
    const w = waiting.get(sid);
    if (!w || w.id !== id) { ws.close(4404); dropIfUnused(id); return undefined; }
    waiting.delete(sid);
    p.waiting.delete(sid);
    clearTimeout(w.timer);
    return pipe(id, sid, w.phone, ws);
  }

  server.on('upgrade', (req, socket, head) => {
    try {
      handleUpgrade(req, socket, head);
    } catch (e) {
      log(`upgrade failed: ${e.message}`);
      try { socket.destroy(); } catch (e2) { /* closed */ }
    }
  });

  return { server, stats: () => ({ pcs: [...pcs.values()].filter((p) => p.control).length, records: pcs.size, waiting: waiting.size, streams: [...pcs.values()].reduce((n, p) => n + p.streams.size, 0) }) };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const { server } = createRelay({ dataDir: process.env.RELAY_DATA || path.join(__dirname, 'data'), log: (m) => console.log(new Date().toISOString(), m) });
  // a port that is taken ends the process (it must not stay alive without listening)
  server.on('error', (e) => { console.error(new Date().toISOString(), 'relay not started:', e.message); process.exit(1); });
  server.listen(port, host, () => console.log(`StarkLLM relay on ${host}:${port}`));
  // a bug in a handler must not take every PC offline
  process.on('uncaughtException', (e) => console.error(new Date().toISOString(), 'uncaught', e && e.message));
}

module.exports = { createRelay, LIMITS };
