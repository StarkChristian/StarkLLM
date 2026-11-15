import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CLOSE } from '../src/protocol.js';
import { generateRelayKey, relaySigner, routingIdFromPublicKey } from '../../mobile/core/src/node.js';
import { startRelay, newPcIdentity, rawConnect, connectPc, connectPhone, until, WebSocket } from './helpers.js';

const ID = 'abcdefghijklmnopqrstuvwxyz234567';

async function withRelay(options, fn) {
  const t = await startRelay(options);
  try {
    await fn(t);
  } finally {
    await t.relay.close();
  }
}

test('health endpoint answers, everything else is a plain 404', () => withRelay({}, async (t) => {
  const h = await fetch(`${t.http}/healthz`);
  assert.equal(h.status, 200);
  const j = await h.json();
  assert.equal(j.status, 'ok');
  assert.equal(j.mailboxes, 0);
  assert.equal((await fetch(`${t.http}/`)).status, 404);
  assert.equal((await fetch(`${t.http}/admin`)).status, 404);
}));

test('bad paths, bad ids and a phone without a PC are rejected during the upgrade (404)', () => withRelay({}, async (t) => {
  await assert.rejects(rawConnect(`${t.url}/v1/other?id=${ID}`), { status: 404 });
  await assert.rejects(rawConnect(`${t.url}/v1/pc?id=short`), { status: 404 });
  await assert.rejects(rawConnect(`${t.url}/v1/pc`), { status: 404 });
  await assert.rejects(rawConnect(`${t.url}/v1/phone?id=${ID}`), { status: 404 }, 'unknown id and offline PC look the same');
}));

test('PC authentication: wrong key for the id, bad signature, garbage and silence are all refused', () => withRelay({ authTimeoutMs: 300 }, async (t) => {
  const me = newPcIdentity();
  const other = newPcIdentity();

  const attempt = async (answer) => {
    const c = await rawConnect(`${t.url}/v1/pc?id=${me.routingId}`);
    await until(() => c.messages.length > 0);
    const ch = JSON.parse(c.messages[0]);
    assert.equal(ch.t, 'challenge');
    if (answer) c.ws.send(JSON.stringify(await answer(ch.nonce)));
    return c.closed;
  };
  const { pcAuthMessage } = await import('../../mobile/core/src/index.js');
  const sign = (id, nonce, signer) => Buffer.from(signer.sign(pcAuthMessage(id, nonce))).toString('base64url');
  const pk = (k) => Buffer.from(k.key.publicKey).toString('base64url');

  // somebody else's key claiming my id
  assert.equal((await attempt((n) => ({ t: 'auth', pk: pk(other), sig: sign(me.routingId, n, other.signer) }))).code, CLOSE.AUTH_FAILED);
  // my key, signature over a different nonce (replay of an old answer)
  assert.equal((await attempt((n) => ({ t: 'auth', pk: pk(me), sig: sign(me.routingId, 'old-nonce', me.signer) }))).code, CLOSE.AUTH_FAILED);
  // my key, signature for a different id
  assert.equal((await attempt((n) => ({ t: 'auth', pk: pk(me), sig: sign(other.routingId, n, me.signer) }))).code, CLOSE.AUTH_FAILED);
  // garbage
  assert.equal((await attempt(() => ({ t: 'auth', pk: 'x', sig: 'y' }))).code, CLOSE.AUTH_FAILED);
  assert.equal((await attempt(() => ({ t: 'hello' }))).code, CLOSE.AUTH_FAILED);
  // silence: timeout
  assert.equal((await attempt(null)).code, CLOSE.AUTH_FAILED);
  assert.equal(t.relay.mailboxes.size, 0);
  assert.ok(t.relay.stats.authFailures >= 6);
}));

test('frames are routed by connection: each phone only talks to the PC, the PC answers one phone at a time', () => withRelay({}, async (t) => {
  const id = newPcIdentity();
  const pc = await connectPc(t, id);
  assert.equal(t.relay.mailboxes.size, 1);
  const a = await connectPhone(t, id.routingId);
  const b = await connectPhone(t, id.routingId);
  await until(() => pc.peers.filter((p) => p.up).length === 2);
  const [pa, pb] = pc.peers.map((p) => p.peer);

  a.link.send(Uint8Array.of(1, 5, 0xaa));
  b.link.send(Uint8Array.of(1, 5, 0xbb));
  await until(() => pc.frames.length === 2);
  const fa = pc.frames.find((f) => f.frame[2] === 0xaa);
  const fb = pc.frames.find((f) => f.frame[2] === 0xbb);
  assert.notEqual(fa.peer, fb.peer);
  assert.ok([pa, pb].includes(fa.peer) && [pa, pb].includes(fb.peer));

  pc.link.send(fa.peer, Uint8Array.of(1, 5, 0x01));
  await until(() => a.frames.length === 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual([...a.frames[0]], [1, 5, 0x01]);
  assert.equal(b.frames.length, 0, 'the other phone sees nothing');

  b.link.close();
  await until(() => pc.peers.some((p) => !p.up));
}));

test('size limits: oversized, empty and text frames close the connection', () => withRelay({}, async (t) => {
  const id = newPcIdentity();
  await connectPc(t, id);
  for (const [payload, label] of [[Buffer.alloc(65_538), 'too big'], [Buffer.alloc(1), 'too small']]) {
    const p = await rawConnect(`${t.url}/v1/phone?id=${id.routingId}`);
    p.ws.send(payload);
    const { code } = await p.closed;
    assert.ok([CLOSE.BAD_FRAME, 1009].includes(code), `${label}: ${code}`);
  }
  const p = await rawConnect(`${t.url}/v1/phone?id=${id.routingId}`);
  p.ws.send('{"hello":1}');
  assert.equal((await p.closed).code, CLOSE.BAD_FRAME);
  const huge = await rawConnect(`${t.url}/v1/phone?id=${id.routingId}`);
  huge.ws.send(Buffer.alloc(200_000));
  assert.ok([CLOSE.BAD_FRAME, 1009].includes((await huge.closed).code));
}));

test('rate limit: a phone flooding frames is disconnected', () => withRelay({ phoneFramesPerSecond: 1, phoneBurst: 5 }, async (t) => {
  const id = newPcIdentity();
  await connectPc(t, id);
  const p = await rawConnect(`${t.url}/v1/phone?id=${id.routingId}`);
  for (let i = 0; i < 30; i++) p.ws.send(Buffer.from([1, 5, i]));
  assert.equal((await p.closed).code, CLOSE.RATE_LIMITED);
  assert.ok(t.relay.stats.limitHits >= 1);
}));

test('daily byte quota per mailbox', () => withRelay({ bytesPerMailboxPerDay: 1000 }, async (t) => {
  const id = newPcIdentity();
  await connectPc(t, id);
  const p = await rawConnect(`${t.url}/v1/phone?id=${id.routingId}`);
  for (let i = 0; i < 20; i++) p.ws.send(Buffer.alloc(100, 1));
  assert.equal((await p.closed).code, CLOSE.RATE_LIMITED);
}));

test('connection caps: phones per mailbox, PCs per IP, new connections per minute', async () => {
  await withRelay({ maxPhonesPerMailbox: 2 }, async (t) => {
    const id = newPcIdentity();
    await connectPc(t, id);
    await rawConnect(`${t.url}/v1/phone?id=${id.routingId}`);
    await rawConnect(`${t.url}/v1/phone?id=${id.routingId}`);
    await assert.rejects(rawConnect(`${t.url}/v1/phone?id=${id.routingId}`), { status: 429 });
  });
  await withRelay({ maxPcPerIp: 1 }, async (t) => {
    await connectPc(t, newPcIdentity());
    await assert.rejects(rawConnect(`${t.url}/v1/pc?id=${newPcIdentity().routingId}`), { status: 429 });
  });
  await withRelay({ newConnectionsPerIpPerMinute: 3 }, async (t) => {
    for (let i = 0; i < 3; i++) await assert.rejects(rawConnect(`${t.url}/v1/phone?id=${ID}`), { status: 404 });
    await assert.rejects(rawConnect(`${t.url}/v1/phone?id=${ID}`), { status: 429 });
  });
});

test('the client IP comes from the proxy header only when configured (and it is never logged)', async () => {
  await withRelay({ newConnectionsPerIpPerMinute: 2, trustedIpHeader: 'cf-connecting-ip' }, async (t) => {
    const hit = (ip) => rawConnectWithHeader(`${t.url}/v1/phone?id=${ID}`, ip);
    await assert.rejects(hit('203.0.113.1'), { status: 404 });
    await assert.rejects(hit('203.0.113.1'), { status: 404 });
    await assert.rejects(hit('203.0.113.1'), { status: 429 });
    await assert.rejects(hit('203.0.113.2'), { status: 404 }, 'a different client behind the proxy has its own budget');
    assert.ok(!t.logs.join('\n').includes('203.0.113'));
  });
  await withRelay({ newConnectionsPerIpPerMinute: 2 }, async (t) => {
    // header ignored without trustedIpHeader: spoofing it does not help
    await assert.rejects(rawConnectWithHeader(`${t.url}/v1/phone?id=${ID}`, '1.1.1.1'), { status: 404 });
    await assert.rejects(rawConnectWithHeader(`${t.url}/v1/phone?id=${ID}`, '2.2.2.2'), { status: 404 });
    await assert.rejects(rawConnectWithHeader(`${t.url}/v1/phone?id=${ID}`, '3.3.3.3'), { status: 429 });
  });
});

function rawConnectWithHeader(url, ip) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { 'cf-connecting-ip': ip } });
    ws.on('open', () => resolve(ws));
    ws.on('unexpected-response', (req, res) => { res.resume(); reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })); });
    ws.on('error', () => {});
  });
}

test('mailboxes are short-lived: they vanish with the PC, and its phones are disconnected', () => withRelay({}, async (t) => {
  const id = newPcIdentity();
  const pc = await connectPc(t, id);
  const phone = await connectPhone(t, id.routingId);
  pc.link.close();
  await until(() => phone.closes.length === 1);
  assert.equal(phone.closes[0], CLOSE.PC_OFFLINE);
  assert.equal(t.relay.mailboxes.size, 0);
  await assert.rejects(rawConnect(`${t.url}/v1/phone?id=${id.routingId}`), { status: 404 });
}));

test('the same PC connecting again replaces the old connection', () => withRelay({}, async (t) => {
  const id = newPcIdentity();
  const closes = [];
  await connectPc(t, id, { onClose: (c) => closes.push(c) });
  const phone = await connectPhone(t, id.routingId);
  await connectPc(t, id);
  await until(() => closes.length === 1 && phone.closes.length === 1);
  assert.equal(closes[0], CLOSE.REPLACED);
  assert.equal(phone.closes[0], CLOSE.PC_OFFLINE);
  assert.equal(t.relay.mailboxes.size, 1);
}));

test('the PC can remove one phone (revocation)', () => withRelay({}, async (t) => {
  const id = newPcIdentity();
  const pc = await connectPc(t, id);
  const a = await connectPhone(t, id.routingId);
  const b = await connectPhone(t, id.routingId);
  await until(() => pc.peers.length === 2);
  pc.link.kick(pc.peers[0].peer);
  await until(() => a.closes.length + b.closes.length === 1);
  assert.equal([...a.closes, ...b.closes][0], CLOSE.AUTH_FAILED);
}));

test('idle phones and very old connections are closed (fake clock)', async () => {
  let clock = 1_000_000;
  await withRelay({ now: () => clock, phoneIdleMs: 60_000, phoneMaxAgeMs: 600_000 }, async (t) => {
    const id = newPcIdentity();
    await connectPc(t, id);
    const idle = await connectPhone(t, id.routingId);
    clock += 61_000;
    t.relay.sweepNow();
    await until(() => idle.closes.length === 1);
    assert.equal(idle.closes[0], CLOSE.IDLE);
    const old = await connectPhone(t, id.routingId);
    for (let i = 0; i < 12; i++) { clock += 59_000; old.link.send(Uint8Array.of(1, 5, 0)); await new Promise((r) => setTimeout(r, 5)); t.relay.sweepNow(); }
    await until(() => old.closes.length === 1);
    assert.equal(old.closes[0], CLOSE.RENEW);
  });
});

test('logs contain event names only: no routing ids, no IPs, no frame content', () => withRelay({}, async (t) => {
  const id = newPcIdentity();
  const pc = await connectPc(t, id);
  const phone = await connectPhone(t, id.routingId);
  phone.link.send(new TextEncoder().encode('\x01\x05TOP-SECRET-PLAINTEXT'));
  await until(() => pc.frames.length === 1);
  await rawConnect(`${t.url}/v1/phone?id=${id.routingId}`).then((c) => c.ws.send('text is refused'));
  await until(() => t.logs.some((l) => l.includes('bad_frame')));
  const all = t.logs.join('\n');
  assert.ok(all.includes('pc_connected') && all.includes('phone_connected'));
  for (const secret of [id.routingId, '127.0.0.1', 'TOP-SECRET', 'secret', Buffer.from('TOP-SECRET').toString('hex')]) {
    assert.ok(!all.includes(secret), `log leaked ${secret}`);
  }
  for (const line of t.logs) assert.deepEqual(Object.keys(JSON.parse(line)).filter((k) => !['t', 'ev', 'reason'].includes(k)), []);
}));

test('malformed HTTP and slowloris-style connections do not crash the relay', () => withRelay({}, async (t) => {
  const net = await import('node:net');
  await new Promise((resolve) => {
    const s = net.connect(Number(new URL(t.http).port), '127.0.0.1', () => {
      s.write('GET /v1/pc?id=%%% HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    s.on('data', () => {});
    s.on('close', resolve);
    s.on('error', resolve);
    setTimeout(() => s.destroy(), 200);
  });
  assert.equal((await fetch(`${t.http}/healthz`)).status, 200);
}));

test('the constants shared with the core library are identical', async () => {
  const core = await import('../../mobile/core/src/relay-protocol.js');
  const mine = await import('../src/protocol.js');
  assert.deepEqual({ ...core.CLOSE }, { ...mine.CLOSE });
  assert.equal(core.PATH_PC, mine.PATH_PC);
  assert.equal(core.PATH_PHONE, mine.PATH_PHONE);
  assert.equal(core.PEER_ID_BYTES, mine.PEER_ID_BYTES);
  assert.equal(core.RELAY_PROTOCOL, mine.RELAY_PROTOCOL);
  // routing id derivation agrees too
  const { routingIdFromPublicKey: mineId } = await import('../src/auth.js');
  const k = generateRelayKey();
  assert.equal(mineId(Buffer.from(k.publicKey)), routingIdFromPublicKey(k.publicKey));
});

test('the relay source never reads or parses frame content (static check)', () => {
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  // binary frames are only measured, sliced and forwarded; JSON.parse is applied to PC control text only
  const parses = src.match(/JSON\.parse\(/g) ?? [];
  assert.equal(parses.length, 2, 'JSON.parse is used for the PC auth message and PC control messages only');
});
