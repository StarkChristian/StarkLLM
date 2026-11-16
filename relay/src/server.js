// The StarkLLM relay.
//
// What it does: lets a PC (authenticated with an Ed25519 key whose hash is its routing id) and its
// phones meet at a short-lived mailbox and forwards opaque binary frames between them.
//
// What it does not do: read, parse, store or log frame content; keep accounts; persist anything.
// Frames are end-to-end encrypted between the PC and the phone (Noise); the relay only sees sizes
// and timing. Everything lives in memory and disappears when the PC disconnects.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { CLOSE, PATH_PC, PATH_PHONE, PEER_ID_BYTES, ROUTING_ID_RE } from './protocol.js';
import { verifyPcAuth } from './auth.js';
import { ConnectionCounter, TokenBucket, WindowCounter } from './limits.js';

export const DEFAULTS = Object.freeze({
  /** Largest binary frame from a phone: 2 header bytes + 65535-byte Noise message. */
  maxFrameBytes: 65_537,
  phoneFramesPerSecond: 40,
  phoneBurst: 80,
  pcFramesPerSecond: 200,
  pcBurst: 400,
  maxPhonesPerMailbox: 8,
  maxPcPerIp: 4,
  maxPhonesPerIp: 32,
  newConnectionsPerIpPerMinute: 120,
  bytesPerMailboxPerDay: 1024 ** 3,
  authTimeoutMs: 10_000,
  phoneIdleMs: 10 * 60_000,
  phoneMaxAgeMs: 2 * 3600_000,
  pcMaxAgeMs: 24 * 3600_000,
  pingIntervalMs: 30_000,
  maxBufferedBytes: 1024 * 1024,
  /** Header whose value is the client IP when running behind a trusted proxy (e.g. "cf-connecting-ip"). */
  trustedIpHeader: null,
});

const EVENTS = new Set(['start', 'stop', 'pc_connected', 'pc_disconnected', 'phone_connected', 'phone_disconnected', 'limit_hit', 'auth_failed', 'bad_frame', 'error']);

/**
 * @param {Partial<typeof DEFAULTS> & {
 *   version?: string,
 *   now?: () => number,
 *   log?: (line: string) => void,
 *   debugTap?: (frame: Buffer, direction: 'phone->relay'|'pc->relay'|'relay->pc'|'relay->phone') => void,
 * }} [options] debugTap exists only for tests ("the relay never sees plaintext"); nothing in the
 * production entry point sets it.
 */
export function createRelay(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const now = options.now ?? Date.now;
  const version = options.version ?? '0.1.0';
  const startedAt = now();
  const stats = { pcConnected: 0, phoneConnected: 0, framesForwarded: 0, bytesForwarded: 0, limitHits: 0, authFailures: 0, badFrames: 0 };

  // The only things ever logged: an event name and a reason code from a fixed vocabulary.
  // Never ids, IP addresses or frame content.
  const out = options.log ?? ((line) => process.stdout.write(line + '\n'));
  const log = (ev, reason) => {
    if (!EVENTS.has(ev)) return;
    out(JSON.stringify({ t: new Date(now()).toISOString(), ev, ...(reason ? { reason: String(reason).slice(0, 40).replace(/[^a-z0-9_ .-]/gi, '') } : {}) }));
  };
  const tap = options.debugTap ?? null;

  /** @type {Map<string, { pc: any, phones: Map<string, any> }>} */
  const mailboxes = new Map();
  const pcPerIp = new ConnectionCounter();
  const phonesPerIp = new ConnectionCounter();
  const connectionRate = new WindowCounter(60_000, now);
  const dailyBytes = new WindowCounter(24 * 3600_000, now);

  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxFrameBytes + PEER_ID_BYTES + 64, perMessageDeflate: false });

  const clientIp = (req) => {
    if (cfg.trustedIpHeader) {
      const v = req.headers[cfg.trustedIpHeader];
      if (typeof v === 'string' && v.length < 64) return v;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ status: 'ok', version, uptime_s: Math.round((now() - startedAt) / 1000), mailboxes: mailboxes.size }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end('StarkLLM relay. See https://github.com/StarkChristian/StarkLLM\n');
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.maxHeadersCount = 40;

  function reject(socket, code, text) {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    let url;
    try {
      url = new URL(req.url ?? '', 'http://relay');
    } catch {
      return reject(socket, 400, 'Bad Request');
    }
    const id = url.searchParams.get('id') ?? '';
    const isPc = url.pathname === PATH_PC;
    const isPhone = url.pathname === PATH_PHONE;
    if ((!isPc && !isPhone) || !ROUTING_ID_RE.test(id)) return reject(socket, 404, 'Not Found');
    const ip = clientIp(req);
    if (connectionRate.add(ip, 1) > cfg.newConnectionsPerIpPerMinute) {
      stats.limitHits++;
      log('limit_hit', 'connection rate');
      return reject(socket, 429, 'Too Many Requests');
    }
    if (isPhone) {
      const box = mailboxes.get(id);
      if (!box) return reject(socket, 404, 'Not Found'); // PC offline: same answer as an unknown id
      if (box.phones.size >= cfg.maxPhonesPerMailbox) {
        stats.limitHits++;
        log('limit_hit', 'phones per mailbox');
        return reject(socket, 429, 'Too Many Requests');
      }
      if (!phonesPerIp.tryAcquire(ip, cfg.maxPhonesPerIp)) {
        stats.limitHits++;
        log('limit_hit', 'phones per ip');
        return reject(socket, 429, 'Too Many Requests');
      }
      wss.handleUpgrade(req, socket, head, (ws) => onPhone(ws, id, ip));
    } else {
      if (!pcPerIp.tryAcquire(ip, cfg.maxPcPerIp)) {
        stats.limitHits++;
        log('limit_hit', 'pcs per ip');
        return reject(socket, 429, 'Too Many Requests');
      }
      wss.handleUpgrade(req, socket, head, (ws) => onPc(ws, id, ip));
    }
  });

  const closeWs = (ws, code, reason) => {
    try {
      ws.close(code, reason);
    } catch { /* already closed */ }
  };

  function heartbeat(ws) {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  }

  /** Counts bytes against the mailbox's daily quota; false = over quota. */
  const account = (id, n) => {
    stats.framesForwarded++;
    stats.bytesForwarded += n;
    return dailyBytes.add(id, n) <= cfg.bytesPerMailboxPerDay;
  };

  // ---------------------------------------------------------------- PC side
  function onPc(ws, id, ip) {
    heartbeat(ws);
    const bucket = new TokenBucket(cfg.pcFramesPerSecond, cfg.pcBurst, now);
    const nonce = randomBytes(16).toString('base64url');
    let box = null;
    const connectedAt = now();
    ws.send(JSON.stringify({ t: 'challenge', nonce }));
    const authTimer = setTimeout(() => {
      stats.authFailures++;
      log('auth_failed', 'timeout');
      closeWs(ws, CLOSE.AUTH_FAILED, 'auth timeout');
    }, cfg.authTimeoutMs);

    ws.on('message', (data, isBinary) => {
      if (!box) {
        // The first and only thing accepted before authentication: a signed answer to the challenge.
        let m;
        try {
          if (isBinary) throw new Error('binary before auth');
          m = JSON.parse(data.toString('utf8'));
        } catch {
          stats.authFailures++;
          log('auth_failed', 'malformed');
          return closeWs(ws, CLOSE.AUTH_FAILED, 'auth failed');
        }
        if (m?.t !== 'auth' || typeof m.pk !== 'string' || typeof m.sig !== 'string' || !verifyPcAuth(id, nonce, m.pk, m.sig)) {
          stats.authFailures++;
          log('auth_failed', 'bad proof');
          return closeWs(ws, CLOSE.AUTH_FAILED, 'auth failed');
        }
        clearTimeout(authTimer);
        const old = mailboxes.get(id);
        if (old) {
          // The same key connected again: the old connection and its phones are replaced.
          mailboxes.delete(id);
          closeWs(old.pc, CLOSE.REPLACED, 'replaced');
          for (const p of old.phones.values()) closeWs(p, CLOSE.PC_OFFLINE, 'pc reconnected');
        }
        box = { pc: ws, phones: new Map() };
        mailboxes.set(id, box);
        stats.pcConnected++;
        log('pc_connected');
        ws.send(JSON.stringify({ t: 'ready' }));
        return;
      }
      if (!bucket.take()) {
        stats.limitHits++;
        log('limit_hit', 'pc frame rate');
        return closeWs(ws, CLOSE.RATE_LIMITED, 'rate limited');
      }
      if (!isBinary) {
        let m;
        try {
          m = JSON.parse(data.toString('utf8'));
        } catch {
          stats.badFrames++;
          log('bad_frame', 'pc text');
          return closeWs(ws, CLOSE.BAD_FRAME, 'bad frame');
        }
        if (m?.t === 'kick' && typeof m.peer === 'string') {
          const target = box.phones.get(m.peer);
          if (target) closeWs(target, CLOSE.AUTH_FAILED, 'removed by the PC');
        } else {
          stats.badFrames++;
          log('bad_frame', 'pc control');
          closeWs(ws, CLOSE.BAD_FRAME, 'bad frame');
        }
        return;
      }
      const buf = /** @type {Buffer} */ (data);
      if (buf.length <= PEER_ID_BYTES || buf.length > cfg.maxFrameBytes + PEER_ID_BYTES) {
        stats.badFrames++;
        log('bad_frame', 'pc size');
        return closeWs(ws, CLOSE.BAD_FRAME, 'bad frame');
      }
      tap?.(buf, 'pc->relay');
      if (!account(id, buf.length)) {
        stats.limitHits++;
        log('limit_hit', 'daily bytes');
        return closeWs(ws, CLOSE.RATE_LIMITED, 'daily quota');
      }
      const phone = box.phones.get(buf.subarray(0, PEER_ID_BYTES).toString('hex'));
      if (!phone || phone.readyState !== 1) return; // phone already left: drop
      if (phone.bufferedAmount > cfg.maxBufferedBytes) return closeWs(phone, CLOSE.RATE_LIMITED, 'slow reader');
      const payload = buf.subarray(PEER_ID_BYTES);
      tap?.(payload, 'relay->phone');
      phone.send(payload, { binary: true });
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      pcPerIp.release(ip);
      if (box && mailboxes.get(id) === box) {
        mailboxes.delete(id); // the mailbox disappears with the PC
        for (const p of box.phones.values()) closeWs(p, CLOSE.PC_OFFLINE, 'pc offline');
        stats.pcConnected--;
        log('pc_disconnected');
      }
    });
    ws.on('error', () => {});
    ws.maxAgeAt = connectedAt + cfg.pcMaxAgeMs;
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
  }

  // ---------------------------------------------------------------- phone side
  function onPhone(ws, id, ip) {
    heartbeat(ws);
    const box = mailboxes.get(id);
    if (!box || box.pc.readyState !== 1) {
      phonesPerIp.release(ip);
      return closeWs(ws, CLOSE.PC_OFFLINE, 'pc offline');
    }
    const bucket = new TokenBucket(cfg.phoneFramesPerSecond, cfg.phoneBurst, now);
    const peer = randomBytes(PEER_ID_BYTES);
    const peerHex = peer.toString('hex');
    box.phones.set(peerHex, ws);
    ws.lastFrameAt = now();
    ws.maxAgeAt = now() + cfg.phoneMaxAgeMs;
    stats.phoneConnected++;
    log('phone_connected');
    ws.send(JSON.stringify({ t: 'ready', peer: peerHex }));
    box.pc.send(JSON.stringify({ t: 'peer', peer: peerHex, up: true }));

    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        stats.badFrames++;
        log('bad_frame', 'phone text');
        return closeWs(ws, CLOSE.BAD_FRAME, 'bad frame');
      }
      const buf = /** @type {Buffer} */ (data);
      if (buf.length < 2 || buf.length > cfg.maxFrameBytes) {
        stats.badFrames++;
        log('bad_frame', 'phone size');
        return closeWs(ws, CLOSE.BAD_FRAME, 'bad frame');
      }
      if (!bucket.take()) {
        stats.limitHits++;
        log('limit_hit', 'phone frame rate');
        return closeWs(ws, CLOSE.RATE_LIMITED, 'rate limited');
      }
      ws.lastFrameAt = now();
      tap?.(buf, 'phone->relay');
      if (!account(id, buf.length)) {
        stats.limitHits++;
        log('limit_hit', 'daily bytes');
        return closeWs(ws, CLOSE.RATE_LIMITED, 'daily quota');
      }
      const pc = box.pc;
      if (pc.readyState !== 1) return;
      if (pc.bufferedAmount > cfg.maxBufferedBytes) return closeWs(ws, CLOSE.RATE_LIMITED, 'pc busy');
      const framed = Buffer.concat([peer, buf]);
      tap?.(framed, 'relay->pc');
      pc.send(framed, { binary: true });
    });
    ws.on('close', () => {
      phonesPerIp.release(ip);
      if (box.phones.get(peerHex) === ws) {
        box.phones.delete(peerHex);
        stats.phoneConnected--;
        log('phone_disconnected');
        if (box.pc.readyState === 1) box.pc.send(JSON.stringify({ t: 'peer', peer: peerHex, up: false }));
      }
    });
    ws.on('error', () => {});
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
  }

  // ---------------------------------------------------------------- housekeeping
  const sockets = new Set();
  const housekeeping = setInterval(() => {
    const t = now();
    for (const ws of sockets) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* closing */ }
      if (ws.lastFrameAt !== undefined && t - ws.lastFrameAt > cfg.phoneIdleMs) closeWs(ws, CLOSE.IDLE, 'idle');
      else if (ws.maxAgeAt !== undefined && t > ws.maxAgeAt) closeWs(ws, CLOSE.RENEW, 'renew');
    }
    connectionRate.sweep();
    dailyBytes.sweep();
  }, cfg.pingIntervalMs);
  housekeeping.unref();

  return {
    server,
    stats,
    mailboxes,
    /** @returns {Promise<number>} the port */
    listen(port = 8787, host = '0.0.0.0') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          log('start');
          resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port);
        });
      });
    },
    /** Housekeeping pass on demand (tests use this instead of waiting for the timer). */
    sweepNow() {
      housekeeping.refresh();
      const t = now();
      for (const ws of sockets) {
        if (ws.lastFrameAt !== undefined && t - ws.lastFrameAt > cfg.phoneIdleMs) closeWs(ws, CLOSE.IDLE, 'idle');
        else if (ws.maxAgeAt !== undefined && t > ws.maxAgeAt) closeWs(ws, CLOSE.RENEW, 'renew');
      }
    },
    close() {
      clearInterval(housekeeping);
      for (const ws of sockets) ws.terminate();
      return new Promise((resolve) => {
        wss.close();
        server.close(() => {
          log('stop');
          resolve(undefined);
        });
        server.closeAllConnections?.();
      });
    },
  };
}
