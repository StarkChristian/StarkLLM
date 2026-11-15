// Test harness: a fake engine, an in-memory "relay" between a RemoteHost and PhoneClients.
import { DeviceRegistry, MemoryDeviceStore, PhoneClient, RemoteHost, generateKeyPair } from '../src/index.js';

export const ROUTING_ID = 'abcdefghijklmnopqrstuvwxyz234567';
export const RELAY = 'wss://relay.example.org';

/** A fake engine that records every call, so tests can prove what did (not) reach it. */
export function fakeEngine() {
  const calls = [];
  const engine = {
    calls,
    async inboxList(params, ctx) {
      calls.push(['inboxList', params, ctx]);
      return { items: [{ id: 'm1', from: 'Finanzamt Berlin', subject: 'Bescheid 2025', unread: true }], next_cursor: null };
    },
    async deadlinesList(params, ctx) {
      calls.push(['deadlinesList', params, ctx]);
      return { items: [{ id: 'd1', title: 'Einspruch einlegen', due: '2026-12-01' }] };
    },
    async casesList(params, ctx) {
      calls.push(['casesList', params, ctx]);
      return { items: [{ id: 'c1', title: 'Steuer 2025', status: 'open' }] };
    },
    async sourceOpen(params, ctx) {
      calls.push(['sourceOpen', params, ctx]);
      return { source_id: params.source_id, title: 'Bescheid.pdf', page: 2, text: 'Die Frist endet am 1. Dezember.' };
    },
    async kbSearch(params, ctx) {
      calls.push(['kbSearch', params, ctx]);
      return { hits: [{ source_id: 'src-1', title: 'Bescheid.pdf', page: 2, snippet: 'Einspruch bis 1. Dezember', score: 0.91 }] };
    },
    async workspacesList(params, ctx) {
      calls.push(['workspacesList', params, ctx]);
      return { items: [{ id: 'w1', name: 'Steuer' }] };
    },
    async chatsList(params, ctx) {
      calls.push(['chatsList', params, ctx]);
      return { items: [{ id: 'ch1', title: 'Frist Einspruch', workspace_id: 'w1' }] };
    },
    async documentIngest(file, ctx) {
      calls.push(['documentIngest', file, ctx]);
      if (engine.failIngest) throw new Error('C:\\\\secret\\\\path exploded');
      return { document_id: 'doc-' + file.hash.slice(0, 8) };
    },
    async *chatAsk(params, ctx) {
      calls.push(['chatAsk', params, ctx]);
      yield { delta: 'Die Frist ' };
      yield { delta: 'endet am 1. Dezember.' };
      yield { citations: [{ source_id: 'src-1', title: 'Bescheid.pdf', page: 2, snippet: 'Einspruch bis 1. Dezember' }] };
    },
  };
  return engine;
}

/**
 * An engine whose every property access outside the five adapter methods fails the test.
 * Used to prove that a refused request never touches anything else.
 */
export function strictEngine(inner = fakeEngine()) {
  const allowed = new Set(['inboxList', 'deadlinesList', 'casesList', 'sourceOpen', 'chatAsk', 'kbSearch', 'workspacesList', 'chatsList', 'documentIngest', 'calls', 'failIngest']);
  return new Proxy(inner, {
    get(target, prop) {
      if (typeof prop === 'symbol' || allowed.has(prop) || prop === 'then') return target[prop];
      throw new Error(`engine property touched outside the allow-list: ${String(prop)}`);
    },
  });
}

const tick = () => new Promise((r) => setImmediate(r));

export function createWorld(opts = {}) {
  let clock = opts.start ?? 1_800_000_000_000;
  const now = () => clock;
  const identity = { current: generateKeyPair() };
  const devices = new DeviceRegistry(new MemoryDeviceStore(), now);
  const engine = opts.engine ?? strictEngine();
  const events = [];
  const closed = [];
  const clients = new Map(); // peerId -> PhoneClient
  const log = { toHost: [], toPhone: [] };
  let drop = null; // (direction, frame) => boolean

  const host = new RemoteHost({
    identity,
    devices,
    engine,
    pcName: 'Christian-PC',
    now,
    send: (peerId, frame) => {
      log.toPhone.push({ peerId, frame });
      if (drop?.('toPhone', frame)) return;
      setImmediate(() => clients.get(peerId)?.handleFrame(frame));
    },
    closePeer: (peerId) => {
      closed.push(peerId);
      setImmediate(() => clients.get(peerId)?.close('link closed'));
    },
    onEvent: (e) => events.push(e),
    limits: opts.limits,
    uploads: opts.uploads,
  });

  let n = 0;
  function newPhone(peerId = `peer${++n}`, clientOpts = {}) {
    const client = new PhoneClient({
      now,
      qr: { allowInsecure: true },
      ...clientOpts,
      send: (frame) => {
        log.toHost.push({ peerId, frame });
        if (drop?.('toHost', frame)) return;
        setImmediate(() => host.handleFrame(peerId, frame));
      },
    });
    clients.set(peerId, client);
    return { peerId, client };
  }

  /** Full pairing, returns { peerId, client, record, code }. */
  async function pairPhone({ name = 'iPhone of Christian', permissions, approve = true } = {}) {
    const { uri } = host.createPairingOffer({ relay: RELAY, routingId: ROUTING_ID });
    const { peerId, client } = newPhone();
    let phoneCode;
    const done = client.startPairing(uri, name, (c) => (phoneCode = c));
    done.catch(() => {});
    for (let i = 0; i < 20 && !host.pendingPairings().length; i++) await tick();
    const [pending] = host.pendingPairings();
    if (!pending) throw new Error('no pending pairing');
    host.confirmPairing(pending.pairingId, approve, { permissions });
    const record = await done;
    return { peerId, client, record, phoneCode, pcCode: pending.code };
  }

  async function connectPhone(record, peerId) {
    const p = newPhone(peerId);
    await p.client.startSession(record);
    return p;
  }

  return {
    host, devices, engine, identity, events, closed, clients, log, newPhone, pairPhone, connectPhone, tick,
    now, advance: (ms) => { clock += ms; },
    setDrop: (fn) => { drop = fn; },
  };
}
