# StarkLLM relay

A small open-source service that lets a StarkLLM PC and its paired phones find each other without opening a port on the
PC. It forwards **opaque, end-to-end encrypted frames** by mailbox id and nothing else.

- No accounts, no database, nothing on disk. Everything lives in memory.
- Sees no content: the frames are Noise ciphertext between the PC and the phone. The relay only sees sizes (padded to
  256-byte steps) and timing.
- A mailbox exists only while its PC is connected. The PC proves it owns the routing id with an Ed25519 signature.
- Limits on frame size, frame rate, connections and bytes per day; idle and old connections are closed.
- Logs contain event names only (no IP addresses, no routing ids, no content).

Design and threat model: [`docs/remote-access-design.md`](../docs/remote-access-design.md). Link protocol:
[`mobile/core/PROTOCOL.md`](../mobile/core/PROTOCOL.md). Deployment notes for the official instance:
[`docs/relay-deployment-contabo.md`](../docs/relay-deployment-contabo.md).

## Run

```bash
npm ci --omit=dev
PORT=8787 node src/index.js
```

or with Docker (the image runs as a non-root user and needs no volumes, so a read-only root file system works):

```bash
docker build -t starkllm-relay relay
docker run -d --name starkllm-relay --read-only --cap-drop ALL --security-opt no-new-privileges \
  -p 127.0.0.1:8787:8787 starkllm-relay
curl http://127.0.0.1:8787/healthz
```

The relay speaks plain WebSocket (`ws://`). Put TLS in front of it (a Cloudflare tunnel, Caddy, nginx): the PC and
the apps require `wss://` for any relay except `localhost`.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `8787`, `0.0.0.0` | listen address |
| `RELAY_TRUSTED_IP_HEADER` | unset | header holding the client IP behind a trusted proxy, e.g. `cf-connecting-ip`. Without it the socket address is used (and a spoofed header is ignored). IPs are used for in-memory counters only |
| `RELAY_MAX_PHONES_PER_MAILBOX` | 8 | phones connected to one PC at once |
| `RELAY_MAX_PC_PER_IP` | 4 | PC connections per IP |
| `RELAY_MAX_PHONES_PER_IP` | 32 | phone connections per IP |
| `RELAY_CONNECTIONS_PER_IP_PER_MINUTE` | 120 | new connections per IP per minute |
| `RELAY_BYTES_PER_MAILBOX_PER_DAY` | 1073741824 | forwarded bytes per mailbox per day |

Fixed limits: 65 537-byte frames from phones, 40 frames per second per phone (burst 80), 200 per second for a PC (burst
400), phones disconnected after 10 minutes idle or 2 hours of age, PCs after 24 hours.

## Endpoints

- `GET /healthz` -> `{"status":"ok","version":"...","uptime_s":N,"mailboxes":N}`
- WebSocket `/v1/pc?id=<routing id>` and `/v1/phone?id=<routing id>` (see PROTOCOL.md)
- everything else: 404

## Tests

```bash
npm ci
npm test
```

`test/relay.test.js` covers authentication, routing, limits, short-lived mailboxes, replacement, revocation, logs and
malformed input. `test/e2e.test.js` runs a fake PC (the real protocol core with a fake engine) and a fake phone
through a real relay on a real socket and asserts that every frame the relay handled contains none of the plaintext,
in clear, hex or base64 form, and that a deliberately unencrypted frame *would* have been noticed. The end-to-end test
needs `../mobile/core` (run `npm ci` there once).
