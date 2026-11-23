# Phones away from home (2.6.0)

Status: built on `dev/2.6.0`, tested end to end (`relay/e2e.test.js`, `relay/limits.test.js`) and on the real phone.
The relay runs at `wss://relay.starkllm.com` (since 23 Nov 2026): a user service on the home server
(`relay/starkllm-relay.service`, 127.0.0.1:8787) behind the server2000 Cloudflare tunnel.

## What the user gets

Settings › Phone › "Phones away from home": off until the user turns it on, and then per phone ("Also away from home
(through the relay)"). A phone allowed this way reaches its PC also over mobile data or another Wi-Fi. The phone's top
bar says "Connected · away from home" when an answer came through the relay. At home nothing changes: the phone uses
the home network first, as before.

## How it works

```
 phone ──(TLS with the PC's own certificate, pinned at pairing)──────────────────────────────┐
   │                                                                                          │
   └─ WebSocket ─▶  StarkLLM relay  ◀─ WebSocket ─ desktop app (phone-relay.js) ─ 127.0.0.1 ─▶ phone link (phonelink.js)
                    passes bytes on                                                           TLS server, device tokens,
                    (encrypted only)                                                          levels, accounts
```

1. **Introduction.** The PC keeps one WebSocket to the relay (`/v1/pc`) while at least one phone may be used away from
   home. Its relay id is a random 128-bit value made by the PC; it is in the pairing QR code (`r=` relay address,
   `i=` id). The PC proves it owns the id with a secret only it knows (the relay keeps a SHA-256 of it; the first PC
   that registers an id keeps it).
2. **A phone connects.** The phone opens `/v1/phone?id=…`. The relay tells the PC, the PC opens a second WebSocket for
   this phone (`/v1/pc-stream`) and connects it to its own phone-link server on 127.0.0.1. The relay pipes the two.
3. **End to end.** Inside the pipe the phone does the same TLS handshake as at home and checks the PC's certificate
   against the fingerprint it scanned (`Pinning.kt`, `RelaySocket.kt`). The relay therefore sees encrypted bytes only:
   no question, answer, document, device token or account. It stores no content and logs no content.
4. **Rules on the PC.** A connection that came through the relay is accepted only for a phone with "Also away from
   home"; everything else (device token, level, account, cloud models never, web search never) is as at home. Pairing is
   never possible through the relay (`pair-at-home`). Wrong tokens through the relay are counted for the relay together.
   Fully offline closes the relay connection.
5. **Limits on the relay** (`relay/server.js`, after the independent review of 23 Nov 2026): per PC 16 phone connections,
   8 phones waiting for the PC, 60 new connections per minute, 200 MB per minute; 2000 waiting phones in all; 30 new PC
   ids per minute; 500 connections that have not shown their secret; 1 MB per message, 8 MB buffered for a slow
   receiver; a stream without traffic or pings is closed after 6 minutes; a PC has 10 s to answer a phone. A phone of an
   unknown or offline PC is refused before anything is stored; the key file is written atomically and a damaged one
   stops the relay; a ping every 30 s finds dead connections. On the PC, wrong tokens through the relay are counted per
   token, and a connection is marked as relayed once at its TLS handshake (`relay/limits.test.js`, `relay/e2e.test.js`).

## Direct connection (next step)

The owner's design (22 Nov 2026) is: the server only introduces the two, then they connect directly. This version
always passes the (encrypted) bytes through the relay, which works on every mobile network, also behind carrier NAT.
A direct path (UDP hole punching or WebRTC data channels, with the relay as fallback) is the next step; the privacy is
the same either way because the TLS is end to end.

## Running the relay

`relay/` is a small Node service (`npm install`, `node server.js`; `PORT`, `HOST`, `RELAY_DATA`). It must be reachable
as `wss://relay.starkllm.com` (the address the desktop app names in the pairing code; `STARKLLM_RELAY_URL` overrides it
for tests). Two ways, both need the owner:

- **On the home server behind the existing Cloudflare tunnel:** run the relay as a service on 127.0.0.1:8787 and add the
  public hostname `relay.starkllm.com` → `http://127.0.0.1:8787` to the tunnel in the Cloudflare Zero Trust dashboard.
- **As a Cloudflare Worker with a Durable Object** (no home server needed): a port of `server.js`; the Cloudflare login on
  the server can only write Pages, not Workers, so this needs the owner's permission or token.

Network log entries: `phone_relay` (the PC's connection to the relay) and incoming `phone_link` entries named
"StarkLLM relay".
