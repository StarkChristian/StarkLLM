// The PC's side of the StarkLLM relay (relay/server.js, docs/phone-away.md): while phones may be used away from home,
// the desktop app keeps one connection to the relay. For each phone that connects there, it opens a second connection
// and passes its bytes to the phone link's own TLS server on this PC (phonelink.js), unchanged. The TLS connection is
// between the phone and this PC: the relay and this file only see encrypted bytes.
'use strict';
const net = require('net');

const PING_MS = 25000;

/**
 * url: the relay ("wss://relay.example"); id, key: this PC's relay id and secret; localPort(): the phone link's port;
 * guard: the network layer (feature "phone_relay"); onRelayed(port, on): a local connection of the relay starts/ends
 * (the phone link tells relayed connections apart by their local port); WebSocketImpl: for tests.
 */
function createRelayClient({ url, id, key, localPort, guard, log = () => {}, onRelayed = () => {}, onState = () => {},
  WebSocketImpl = globalThis.WebSocket, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let control = null;
  let stopped = true;
  let retry = 1000;
  let retryTimer = null;
  let pingTimer = null;
  let state = 'off';
  const streams = new Set();
  const host = (() => { try { return new URL(url).hostname; } catch (e) { return ''; } })();

  function setState(s) {
    if (s !== state) { state = s; onState(s); }
  }

  function wsUrl(path, extra = '') {
    return `${url.replace(/\/+$/, '')}${path}?id=${encodeURIComponent(id)}${extra}`;
  }

  function open(path, extra) {
    const ws = new WebSocketImpl(wsUrl(path, extra));
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', key })));
    return ws;
  }

  function connect() {
    if (stopped || control) return;
    if (guard && guard.isOffline()) { setState('offline'); return; }
    if (guard) guard.record({ feature: 'phone_relay', host, purpose: 'Phones away from home: the connection to the StarkLLM relay (only encrypted bytes pass)', scheme: 'wss' });
    setState('connecting');
    const ws = open('/v1/pc');
    control = ws;
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      let m = null;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'hello') { retry = 1000; setState('online'); log('phone relay: online'); }
      if (m.type === 'open' && typeof m.sid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(m.sid)) stream(m.sid);
    });
    const closed = (ev) => {
      if (control !== ws) return;
      control = null;
      clearInterval(pingTimer);
      if (stopped) return;
      setState(ev && ev.code === 4403 ? 'refused' : 'retrying');
      if (ev && ev.code === 4403) { log('phone relay: the relay refused this PC (another PC has its id)'); return; }
      retryTimer = setTimer(connect, retry);
      retry = Math.min(retry * 2, 60000);
    };
    ws.addEventListener('close', closed);
    ws.addEventListener('error', () => { try { ws.close(); } catch (e) { /* closed */ } });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { try { if (ws.readyState === 1) ws.send('{"type":"ping"}'); } catch (e) { /* closed */ } }, PING_MS);
  }

  // one phone connection: relay <-> the phone link's TLS server on this PC
  function stream(sid) {
    if (guard && guard.isOffline()) return;
    const ws = open('/v1/pc-stream', `&sid=${encodeURIComponent(sid)}`);
    let sock = null;
    const queue = [];
    const end = () => {
      streams.delete(ws);
      if (sock) { onRelayed(sock.localPort, false); sock.destroy(); }
      try { ws.close(); } catch (e) { /* closed */ }
    };
    streams.add(ws);
    ws.addEventListener('open', () => {
      sock = net.connect({ host: '127.0.0.1', port: localPort() });
      sock.on('connect', () => {
        onRelayed(sock.localPort, true);
        for (const b of queue.splice(0)) sock.write(b);
      });
      sock.on('data', (b) => { try { ws.send(b); } catch (e) { end(); } });
      sock.on('close', end);
      sock.on('error', end);
    });
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') return;
      const b = Buffer.from(ev.data);
      if (sock && !sock.connecting) sock.write(b);
      else queue.push(b);
    });
    ws.addEventListener('close', end);
    ws.addEventListener('error', end);
  }

  return {
    start() { if (!stopped) return; stopped = false; retry = 1000; connect(); },
    stop() {
      stopped = true;
      clearTimer(retryTimer);
      clearInterval(pingTimer);
      if (control) { try { control.close(); } catch (e) { /* closed */ } control = null; }
      for (const ws of [...streams]) { try { ws.close(); } catch (e) { /* closed */ } }
      streams.clear();
      setState('off');
    },
    state: () => state,
  };
}

module.exports = { createRelayClient };
