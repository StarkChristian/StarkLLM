# @starkllm/remote-core

The protocol core of StarkLLM remote access: everything a PC and a phone need to talk to each other
end-to-end encrypted through an untrusted relay. One JavaScript codebase (ES modules, JSDoc types, no
build step) used by the PC side (Node / Electron main process), the PWA and, later, the React Native app.

Design and threat model: [`docs/remote-access-design.md`](../../docs/remote-access-design.md).
Wire format and message reference: [`PROTOCOL.md`](PROTOCOL.md).

## What is in it

| File | Purpose |
|---|---|
| `src/noise.js` | the only file that touches the Noise library (`salty-crypto`): IKpsk2 / IK handshakes, transport with padding and rekey, confirmation code |
| `src/wire.js` | frame format and strict frame parser |
| `src/protocol.js` | the allow-list, closed parameter schemas, strict request/response parsing |
| `src/qr.js` | the pairing QR payload (`starkllm://pair?...`) |
| `src/devices.js` | approved devices: approval, permissions, revocation, key rotation |
| `src/host.js` | `RemoteHost`: the PC side (pairing, sessions, allow-listed dispatch to an engine adapter) |
| `src/client.js` | `PhoneClient`: the phone side |
| `src/relay-client.js` | WebSocket clients for the relay (PC and phone); the WebSocket class is injected |
| `src/node.js` | Node-only: Ed25519 relay key, routing id, file storage |

## Use

PC side (sketch; the desktop integration is the next step of the plan):

```js
import { RemoteHost, DeviceRegistry, RelayPcLink } from '@starkllm/remote-core';
import { loadOrCreateIdentity, relaySigner, FileDeviceStore } from '@starkllm/remote-core/node';

const id = loadOrCreateIdentity(dataDir + '/remote');
const devices = new DeviceRegistry(new FileDeviceStore(dataDir + '/remote/devices.json'));
const host = new RemoteHost({
  identity: id.noise,
  devices,
  engine,                                   // the five adapter methods, see PROTOCOL.md
  send: (peer, frame) => link.send(peer, frame),
  closePeer: (peer) => link.kick(peer),
  onEvent: (e) => ui.show(e),               // 'pairing-pending' etc.
});
const link = new RelayPcLink({
  relay: 'wss://relay.starkllm.com', routingId: id.routingId, signer: relaySigner(id.relay),
  WebSocketImpl: WebSocket,
  onFrame: (peer, frame) => host.handleFrame(peer, frame),
  onPeer: (peer, up) => { if (!up) host.peerClosed(peer); },
});
await link.connect();
const { uri } = host.createPairingOffer({ relay: 'wss://relay.starkllm.com', routingId: id.routingId });
// show `uri` as a QR code; when 'pairing-pending' arrives, show the name and the 6-digit code,
// then host.confirmPairing(pairingId, true | false)
setInterval(() => host.tick(), 1000);
```

Phone side:

```js
import { PhoneClient, RelayPhoneLink } from '@starkllm/remote-core';

const client = new PhoneClient({ send: (f) => link.send(f) });
const link = new RelayPhoneLink({ relay, routingId, WebSocketImpl: WebSocket, onFrame: (f) => client.handleFrame(f) });
await link.connect();
const record = await client.startPairing(qrText, 'iPhone of Christian', (code) => showCode(code));
// store `record` in Keychain / Keystore. Later, for every connection:
await client.startSession(record);
const answer = await client.request('chat.ask', { question }, { onChunk: (c) => append(c.delta) });
```

On React Native a `crypto.getRandomValues` polyfill must be installed before the first import (the Noise
library needs it for key generation).

## Tests

```bash
npm ci
npm test            # everything below
npm run typecheck   # tsc over the JSDoc types
```

| Test file | What it proves |
|---|---|
| `test/noise-vectors.test.js` | the Noise library reproduces the official test vectors (cacophony, snow, noise-c), including IK and IKpsk2 |
| `test/interop.test.js` + `test/interop/verify_fixture.py` | a second implementation (Python `noiseprotocol`) produces and accepts the same bytes: both handshakes, padded transport, rekey |
| `test/framing.test.js` | property and fuzz tests: frame parser, padding, replay / reorder / drop / tamper, rekey boundaries, mutated handshakes, QR parser |
| `test/allowlist.test.js` | allow-list property and fuzz tests; random messages never reach the engine unless valid |
| `test/host-security.test.js` | handshake replay, stale timestamps, idle and age limits, pairing limits, device registry |
| `test/e2e-simulated.test.js` | simulated end-to-end: QR payload and code, pairing, session, answered request, refused requests, revocation, stolen QR, key rotation |

The Python interop check (needs Python 3 and `pip install noiseprotocol==0.3.1`):

```bash
python test/interop/verify_fixture.py
```

To regenerate the committed fixtures after a deliberate protocol change: `npm run interop:generate`
(and `npm run vectors:fetch` to refresh the vector files).

## Rules

- No home-made cryptography. If the Noise library fails a vector after an update, replace it in
  `src/noise.js`; never patch it.
- A new request type is a deliberate act: one entry in `REQUEST_TYPES`, one engine adapter method, tests.
- Anything a remote peer can cause is a `ProtocolError`; the host drops the frame or the link, it never forwards.
