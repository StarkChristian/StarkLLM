// End-to-end through a real relay on a real socket: a fake PC (RemoteHost + fake engine) and a
// fake phone (PhoneClient). The test asserts the relay never sees plaintext: every frame it
// handled is searched for the secret strings in the clear, hex and base64 forms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeviceRegistry, MemoryDeviceStore, PhoneClient, RemoteHost, generateKeyPair, parsePairingUri,
} from '../../mobile/core/src/index.js';
import { startRelay, newPcIdentity, connectPc, connectPhone, until } from './helpers.js';

const SECRETS = {
  question: 'Wie hoch ist die Nachzahlung laut Bescheid von Herrn Mustermann-Geheim?',
  answer: 'Die Nachzahlung betraegt 4711,42 EUR laut Steuerbescheid GEHEIM-2025.',
  subject: 'Vertraulich: Kuendigung Mietvertrag Gartenstrasse 12',
  citation: 'Seite 3: Zahlungsfrist endet am 01.12.2026 (vertraulich)',
  device: 'iPhone von Christian-Geheim',
};

function engine() {
  const calls = [];
  return {
    calls,
    async inboxList() { calls.push('inboxList'); return { items: [{ id: 'm1', subject: SECRETS.subject }] }; },
    async deadlinesList() { calls.push('deadlinesList'); return { items: [] }; },
    async casesList() { calls.push('casesList'); return { items: [] }; },
    async sourceOpen(p) { calls.push('sourceOpen'); return { source_id: p.source_id, text: SECRETS.citation }; },
    async *chatAsk(p) {
      calls.push('chatAsk');
      yield { delta: SECRETS.answer.slice(0, 20) };
      yield { delta: SECRETS.answer.slice(20) };
      yield { citations: [{ source_id: 's1', title: 'Bescheid.pdf', snippet: SECRETS.citation }] };
    },
  };
}

function haystacks(buf) {
  return [buf.toString('latin1'), buf.toString('utf8'), buf.toString('hex'), buf.toString('base64'), buf.toString('base64url')];
}

test('end to end through the relay: pairing, session, request, refusal; the relay never sees plaintext', async () => {
  const t = await startRelay();
  const pcId = newPcIdentity();
  const eng = engine();
  const identity = { current: generateKeyPair() };
  const devices = new DeviceRegistry(new MemoryDeviceStore());
  let pcLink;
  const host = new RemoteHost({
    identity, devices, engine: eng, pcName: 'Test-PC',
    send: (peer, frame) => pcLink.link.send(peer, frame),
    closePeer: (peer) => pcLink.link.kick(peer),
  });
  pcLink = await connectPc(t, pcId, {
    onFrame: (peer, frame) => host.handleFrame(peer, frame),
    onPeer: (peer, up) => { if (!up) host.peerClosed(peer); },
  });

  try {
    // ---- pairing (QR payload + confirmation code) -------------------------------------------
    const { uri } = host.createPairingOffer({ relay: t.url, routingId: pcId.routingId });
    assert.equal(parsePairingUri(uri, { allowInsecure: true }).routingId, pcId.routingId);

    let phoneLink;
    const client = new PhoneClient({ qr: { allowInsecure: true }, send: (f) => phoneLink.link.send(f) });
    phoneLink = await connectPhone(t, pcId.routingId, { onFrame: (f) => client.handleFrame(f) });
    let phoneCode;
    const paired = client.startPairing(uri, SECRETS.device, (c) => (phoneCode = c));
    await until(() => host.pendingPairings().length === 1);
    const [pending] = host.pendingPairings();
    assert.equal(pending.code, phoneCode);
    host.confirmPairing(pending.pairingId, true);
    const record = await paired;
    phoneLink.link.close();

    // ---- session -----------------------------------------------------------------------------
    let link2;
    const c2 = new PhoneClient({ send: (f) => link2.link.send(f) });
    link2 = await connectPhone(t, pcId.routingId, { onFrame: (f) => c2.handleFrame(f) });
    await c2.startSession(record);

    const chunks = [];
    const answer = await c2.request('chat.ask', { question: SECRETS.question }, { onChunk: (c) => chunks.push(c.delta) });
    assert.equal(chunks.join(''), SECRETS.answer);
    assert.equal(answer.citations[0].snippet, SECRETS.citation);
    const inbox = await c2.request('inbox.list');
    assert.equal(inbox.items[0].subject, SECRETS.subject);
    const src = await c2.request('source.open', { source_id: 's1' });
    assert.equal(src.text, SECRETS.citation);

    // ---- refusal -------------------------------------------------------------------------------
    await assert.rejects(c2._unsafeSend({ type: 'settings.update', params: { telegram_token: 'x' } }), (e) => e.code === 'unknown_type');
    assert.deepEqual(eng.calls, ['chatAsk', 'inboxList', 'sourceOpen'], 'the refused request never reached the engine');

    // ---- the relay saw only ciphertext ------------------------------------------------------------
    assert.ok(t.taps.length >= 10, `relay handled ${t.taps.length} frames`);
    assert.ok(t.relay.stats.framesForwarded >= 10);
    const everything = Buffer.concat(t.taps.map((x) => x.bytes));
    for (const [name, secret] of Object.entries(SECRETS)) {
      for (const needle of [secret, secret.slice(0, 12), 'chat.ask', 'inbox.list', 'unknown_type', 'settings.update', 'telegram_token', 'Nachzahlung']) {
        for (const form of haystacks(everything)) {
          assert.ok(!form.includes(needle), `plaintext "${needle}" (from ${name}) visible to the relay`);
        }
      }
    }
    // The QR secret and keys never travelled either (they are in the QR code only).
    const qr = parsePairingUri(uri, { allowInsecure: true });
    for (const key of [qr.secret, identity.current.secretKey, qr.pcPublicKey.length && Buffer.from(record.deviceKey.secretKey, 'base64url')]) {
      assert.ok(!everything.includes(Buffer.from(key)), 'secret key material seen by the relay');
    }
    // and the relay's log has no content either
    const log = t.logs.join('\n');
    for (const secret of Object.values(SECRETS)) assert.ok(!log.includes(secret));
    // frame sizes are padded to 256-byte steps (plus Noise tag, 2 header bytes): no exact lengths leak
    const dataFrames = t.taps.filter((x) => x.direction === 'phone->relay' && x.bytes[1] === 5);
    assert.ok(dataFrames.length >= 4);
    for (const f of dataFrames) assert.equal((f.bytes.length - 2 - 16) % 256, 0);
  } finally {
    host.close();
    await t.relay.close();
  }
});

test('a phone that is not paired cannot talk to the engine even through the relay', async () => {
  const t = await startRelay();
  const pcId = newPcIdentity();
  const eng = engine();
  const devices = new DeviceRegistry(new MemoryDeviceStore());
  let pcLink;
  const host = new RemoteHost({
    identity: { current: generateKeyPair() }, devices, engine: eng,
    send: (peer, frame) => pcLink.link.send(peer, frame), closePeer: (peer) => pcLink.link.kick(peer),
  });
  pcLink = await connectPc(t, pcId, { onFrame: (p, f) => host.handleFrame(p, f), onPeer: (p, up) => { if (!up) host.peerClosed(p); } });
  try {
    // a stranger who knows the routing id and the PC's public key, but is not approved
    const pcKey = host.identity.current.publicKey;
    const stranger = { version: 1, relay: t.url, routingId: pcId.routingId, pcPublicKey: Buffer.from(pcKey).toString('base64url'), pcName: 'x', deviceId: 'x', permissions: ['read', 'chat'], deviceKey: (() => { const k = generateKeyPair(); return { publicKey: Buffer.from(k.publicKey).toString('base64url'), secretKey: Buffer.from(k.secretKey).toString('base64url') }; })() };
    let link;
    const c = new PhoneClient({ send: (f) => link.link.send(f) });
    link = await connectPhone(t, pcId.routingId, { onFrame: (f) => c.handleFrame(f) });
    c.startSession(stranger).catch(() => {});
    await until(() => link.closes.length === 1 || link.frames.length > 0, 1500).catch(() => {});
    assert.equal(link.frames.length, 0, 'the PC did not answer the stranger');
    assert.equal(eng.calls.length, 0);
  } finally {
    host.close();
    await t.relay.close();
  }
});

test('control: the tap would notice plaintext (a deliberately unencrypted frame is found)', async () => {
  const t = await startRelay();
  const pcId = newPcIdentity();
  const pc = await connectPc(t, pcId);
  try {
    const phone = await connectPhone(t, pcId.routingId);
    phone.link.send(Buffer.concat([Buffer.from([1, 5]), Buffer.from(SECRETS.question)]));
    await until(() => pc.frames.length === 1);
    const everything = Buffer.concat(t.taps.map((x) => x.bytes));
    assert.ok(haystacks(everything).some((h) => h.includes(SECRETS.question)));
  } finally {
    await t.relay.close();
  }
});

test('document upload through the relay: chunked, confirmed on the PC, and the relay never sees the file or its name', async () => {
  const t = await startRelay();
  const pcId = newPcIdentity();
  const ingested = [];
  const eng = { ...engine(), async documentIngest(file) { ingested.push(file); return { document_id: 'doc-1' }; } };
  const devices = new DeviceRegistry(new MemoryDeviceStore());
  let pcLink;
  const host = new RemoteHost({
    identity: { current: generateKeyPair() }, devices, engine: eng,
    send: (peer, frame) => pcLink.link.send(peer, frame), closePeer: (peer) => pcLink.link.kick(peer),
  });
  pcLink = await connectPc(t, pcId, { onFrame: (p, f) => host.handleFrame(p, f), onPeer: (p, up) => { if (!up) host.peerClosed(p); } });
  try {
    const { uri } = host.createPairingOffer({ relay: t.url, routingId: pcId.routingId });
    let l1;
    const c1 = new PhoneClient({ qr: { allowInsecure: true }, send: (f) => l1.link.send(f) });
    l1 = await connectPhone(t, pcId.routingId, { onFrame: (f) => c1.handleFrame(f) });
    const paired = c1.startPairing(uri, 'Test phone', () => {});
    await until(() => host.pendingPairings().length === 1);
    host.confirmPairing(host.pendingPairings()[0].pairingId, true, { permissions: ['read', 'chat', 'upload'] });
    const record = await paired;
    l1.link.close();

    let l2;
    const c2 = new PhoneClient({ send: (f) => l2.link.send(f) });
    l2 = await connectPhone(t, pcId.routingId, { onFrame: (f) => c2.handleFrame(f) });
    await c2.startSession(record);

    const secretText = 'Kuendigung des Mietvertrags Gartenstrasse 12, streng vertraulich. '.repeat(1500); // ~100 KB, 4 chunks
    const bytes = new TextEncoder().encode(secretText);
    const fileName = 'Kuendigung-Gartenstrasse-geheim.txt';
    const done = c2.uploadDocument({ name: fileName, bytes, pollMs: 50 });
    await until(() => host.pendingUploads().length === 1, 5000);
    assert.equal(ingested.length, 0, 'nothing is ingested before the user decides');
    assert.equal(await host.confirmUpload(host.pendingUploads()[0].ref, true), 'accepted');
    assert.equal((await done).status, 'accepted');
    assert.equal(ingested.length, 1);
    assert.deepEqual(Buffer.from(ingested[0].bytes), Buffer.from(bytes));
    assert.equal(ingested[0].untrusted, true);

    const everything = Buffer.concat(t.taps.map((x) => x.bytes));
    for (const needle of [fileName, 'Gartenstrasse', 'Kuendigung', 'documents.upload', 'vertraulich', 'Test phone']) {
      for (const form of haystacks(everything)) assert.ok(!form.includes(needle), `"${needle}" visible to the relay`);
    }
    assert.ok(t.relay.stats.bytesForwarded > bytes.length, 'the file really went through the relay');
  } finally {
    host.close();
    await t.relay.close();
  }
});
