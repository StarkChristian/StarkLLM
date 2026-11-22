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
  openPerMinute: 60,         // new phone connections per PC and minute
  pcWaitMs: 10000,           // the PC has this long to open the stream of a phone
  idleMs: 120000,            // a stream without traffic is closed
  maxFrame: 1024 * 1024,     // bytes per WebSocket message
  bytesPerMinute: 200 * 1024 * 1024, // per PC, both directions together
};

function hash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function createRelay({ dataDir = path.join(__dirname, 'data'), log = () => {}, now = () => Date.now() } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const keysPath = path.join(dataDir, 'pcs.json');
  let keys = {};
  try { keys = JSON.parse(fs.readFileSync(keysPath, 'utf8')); } catch (e) { keys = {}; }
  const saveKeys = () => fs.writeFileSync(keysPath, JSON.stringify(keys));

  const pcs = new Map();      // id -> { control, streams: Map(sid -> {phone, pc, timer}), opened: [times], bytes, minute }
  const waiting = new Map();  // sid -> { id, phone, timer }

  function pcOf(id) {
    let p = pcs.get(id);
    if (!p) { p = { control: null, streams: new Map(), opened: [], bytes: 0, minute: 0 }; pcs.set(id, p); }
    return p;
  }

  // the PC's secret: the first one registers the id, later ones must match
  function pcAllowed(id, secret) {
    if (!ID.test(id || '') || !SECRET.test(secret || '')) return false;
    const h = hash(secret);
    if (!keys[id]) { keys[id] = { key: h, since: new Date(now()).toISOString() }; saveKeys(); return true; }
    return crypto.timingSafeEqual(Buffer.from(keys[id].key), Buffer.from(h));
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
    const idle = () => { clearTimeout(s.timer); s.timer = setTimeout(() => end(1000), LIMITS.idleMs); };
    const end = (code) => {
      clearTimeout(s.timer);
      p.streams.delete(sid);
      for (const ws of [phone, pcWs]) { try { ws.close(code); } catch (e) { /* closed */ } }
    };
    idle();
    phone.on('message', (data, binary) => {
      if (!binary) return;
      if (!count(p, data.length)) return end(4429);
      idle();
      if (pcWs.readyState === 1) pcWs.send(data, { binary: true });
    });
    pcWs.on('message', (data, binary) => {
      if (!binary) return;
      if (!count(p, data.length)) return end(4429);
      idle();
      if (phone.readyState === 1) phone.send(data, { binary: true });
    });
    phone.on('close', () => end(1000));
    pcWs.on('close', () => end(1000));
    phone.on('error', () => end(1011));
    pcWs.on('error', () => end(1011));
    // the phone may now start its TLS handshake
    phone.send(JSON.stringify({ type: 'ready' }));
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('StarkLLM relay: nothing here');
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrame, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://relay'); } catch (e) { return socket.destroy(); }
    const id = url.searchParams.get('id') || '';
    const reject = (status) => { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (!ID.test(id)) return reject('400 Bad Request');

    if (url.pathname === '/v1/pc' || url.pathname === '/v1/pc-stream') {
      // the PC shows its secret in its first message (WebSocket clients cannot always send headers)
      return wss.handleUpgrade(req, socket, head, (ws) => {
        const timer = setTimeout(() => ws.close(4401), 5000);
        ws.once('message', (data, binary) => {
          clearTimeout(timer);
          let m = null;
          try { m = binary ? null : JSON.parse(String(data)); } catch (e) { m = null; }
          if (!m || m.type !== 'auth' || !pcAllowed(id, m.key)) return ws.close(4403);
          return pcConnected(ws);
        });
      });
      function pcConnected(ws) {
        const p = pcOf(id);
        if (url.pathname === '/v1/pc') {
          if (p.control) { try { p.control.close(4000, 'replaced'); } catch (e) { /* closed */ } }
          p.control = ws;
          ws.on('close', () => { if (p.control === ws) p.control = null; });
          ws.on('message', () => {}); // keep-alive pings of the PC
          ws.send(JSON.stringify({ type: 'hello' }));
          log(`pc online (${id.slice(0, 6)}…)`);
          return undefined;
        }
        const sid = url.searchParams.get('sid') || '';
        const w = waiting.get(sid);
        if (!w || w.id !== id) return ws.close(4404);
        waiting.delete(sid);
        clearTimeout(w.timer);
        return pipe(id, sid, w.phone, ws);
      }
    }

    if (url.pathname === '/v1/phone') {
      const p = pcOf(id);
      const t = now();
      p.opened = p.opened.filter((x) => t - x < 60000);
      if (!p.control) return reject('404 Not Found');      // the PC is not online (or not allowed away from home)
      if (p.opened.length >= LIMITS.openPerMinute || p.streams.size + waiting.size >= LIMITS.streamsPerPc * 4) return reject('429 Too Many Requests');
      if ([...p.streams.values()].length >= LIMITS.streamsPerPc) return reject('429 Too Many Requests');
      p.opened.push(t);
      return wss.handleUpgrade(req, socket, head, (phone) => {
        const sid = crypto.randomBytes(16).toString('base64url');
        const timer = setTimeout(() => { waiting.delete(sid); try { phone.close(4504); } catch (e) { /* closed */ } }, LIMITS.pcWaitMs);
        waiting.set(sid, { id, phone, timer });
        phone.on('close', () => { if (waiting.has(sid)) { clearTimeout(timer); waiting.delete(sid); } });
        // bytes of the phone before "ready" would be lost: the phone waits for "ready" before its TLS handshake
        try { p.control.send(JSON.stringify({ type: 'open', sid })); } catch (e) { phone.close(4404); }
      });
    }
    return reject('404 Not Found');
  });

  return { server, stats: () => ({ pcs: [...pcs.values()].filter((p) => p.control).length, streams: [...pcs.values()].reduce((n, p) => n + p.streams.size, 0) }) };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const { server } = createRelay({ dataDir: process.env.RELAY_DATA || path.join(__dirname, 'data'), log: (m) => console.log(new Date().toISOString(), m) });
  server.listen(port, host, () => console.log(`StarkLLM relay on ${host}:${port}`));
}

module.exports = { createRelay, LIMITS };
