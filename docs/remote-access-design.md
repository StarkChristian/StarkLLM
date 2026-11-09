# StarkLLM Remote Access — Design

Status: **proposal for review** (roadmap phases 3 and 6: access from the phone, iOS and Android apps).
Date: 9 November 2026.

## 1. Goal

Use StarkLLM on your PC from your phone — at home and on the road — with the same promise as on the PC:
your documents and conversations stay yours.

Requirements, in order of priority:

1. **Nobody but your phone and your PC can read questions, answers or documents** — not the relay operator
   (us), not the network, not Apple or Google.
2. **The PC opens no port.** It only makes outgoing connections, like today's update check and the Telegram bridge.
3. **Only phones you approved on the PC get in**, and you can remove a phone at any time.
4. **A stolen phone or a leaked server must not expose the PC's data.**
5. **The relay is open source and can be self-hosted.** The official relay is run in the EU.
6. Simple for the user: scan a QR code once, then it works everywhere.

Non-goals for version 1: sharing with other people, several PCs behind one phone account, push
notifications with content, access without the PC running.

## 2. Overview

```
 Phone app (iOS / Android / PWA)          Relay (relay.starkllm.com, open source)          PC (StarkLLM engine)
 ───────────────────────────────          ──────────────────────────────────────          ────────────────────
 device key (Keychain / Keystore)                                                           PC key (data folder)
        │                                                                                         │
        │  WebSocket (TLS)  ──────────────►   forwards opaque frames   ◄────────────── WebSocket (TLS), outgoing
        │                                     by routing id; sees no                       │
        │                                     content, keeps no content                     │
        └──────────── end-to-end encrypted session (Noise IK) ─────────────────────────────┘
                                inside: StarkLLM remote protocol (allow-listed requests)
```

- The **engine** (backend) holds the PC side, so it works the same with the Docker engine and the engine
  without Docker. Code: `backend/app/remote/`.
- The **relay** is a small, separate service: `relay/` in this repository, with its own Dockerfile.
- The **phone client** is one TypeScript codebase: first a web app (PWA), then the iOS and Android app
  (React Native with Expo) using the same protocol core. Code: `mobile/`.

Transport security is layered: TLS to the relay (protects relay credentials and metadata on the wire) **and**
end-to-end encryption between phone and PC (protects everything from the relay).

## 3. Keys and identities

| Key | Type | Where | Purpose |
|---|---|---|---|
| PC static key | X25519 | `data/remote/pc_key` (file mode 600) | Noise identity of the PC |
| PC relay key | Ed25519 | `data/remote/relay_key` | proves to the relay that the PC owns its routing id |
| Routing id | `base32(BLAKE2b-160(relay public key))` | public | address of the PC at the relay; reveals nothing else |
| Device static key | X25519 | iOS Keychain / Android Keystore (`expo-secure-store`), never exported | Noise identity of one phone |
| Pairing secret | 32 random bytes | only in the QR code and in the PC's memory | binds the first contact to the person who sees the PC screen |

All keys are created on the device that uses them. No key is ever sent to the relay or to us.

## 4. Pairing (once per phone)

1. On the PC: **Settings > Phones > Add phone**. The engine creates a pairing secret (valid 5 minutes, one use)
   and shows a QR code with:
   `starkllm://pair?v=1&relay=<url>&id=<routing id>&pk=<PC static public key>&s=<pairing secret>`
2. The phone scans it. It now knows *which* PC (its public key) and has a secret only someone who saw the screen
   can have.
3. The phone runs the **Noise IKpsk2** handshake through the relay, with the pairing secret as PSK. The handshake
   fails unless the phone has the secret *and* the PC has the private key matching the QR code.
4. The PC shows the phone's name and a 4-digit check code derived from the handshake hash; the phone shows the same
   code. **The user confirms on the PC** ("Allow *iPhone of Christian*? Code 4821"). Only then is the device key
   stored as approved.
5. The secret is deleted. A scanned-but-not-confirmed QR code is worthless after 5 minutes.

The confirmation step (4) means a photographed QR code alone is not enough: an attacker would also need someone to
press *Allow* on the PC.

## 5. Sessions (every connection)

- **Handshake:** Noise **IK** (`Noise_IK_25519_ChaChaPoly_BLAKE2b`), phone as initiator. The phone knows the PC's
  static key from pairing; the PC checks the phone's static key against its list of approved devices and drops the
  connection otherwise. Prologue: `StarkLLM-remote-v1` (binds the protocol version).
- **Forward secrecy:** new ephemeral keys every session; a later theft of a static key does not decrypt recorded
  sessions.
- **Transport:** Noise transport messages (ChaCha20-Poly1305, 64-bit counters). Frames arrive in order over the
  WebSocket; any decryption failure ends the session (this also stops replays and reordering). Rekey every
  10 000 messages or 1 hour.
- **Message size:** at most 64 KiB per frame; larger content (uploads, long answers) is split into chunks.
- **Idle timeout:** 10 minutes; the phone reconnects with a new handshake.

### Library rule

We do not implement cryptography ourselves. The Noise implementation on each side (Python on the PC, TypeScript
on the phone) is an existing, maintained library — candidates: `noiseprotocol` (Python, on `cryptography`) and a
libsodium-based TypeScript implementation (`react-native-libsodium` on the phone). **Before any other code, both
must pass the published Noise test vectors and an interoperability test against each other in CI.** If a candidate
fails, we replace it, not patch it.

## 6. What a phone may do (inside the session)

The phone does **not** get a tunnel to the engine's HTTP API. It speaks a small request protocol, and the PC answers
only an allow-list:

| Request | Notes |
|---|---|
| `workspaces.list`, `chats.list`, `chats.messages` | read |
| `chat.send` | streamed answer with sources, like the app's chat |
| `kb.search` | search the knowledge base |
| `documents.list` | read |
| `documents.upload` | chunked; only with the "may add documents" permission |
| `device.info` | the phone's own permissions |

Never available remotely: settings, model management, backup and restore, local tools (MCP), code execution,
account management, Telegram settings. Every request runs as the StarkLLM user who approved the phone. Each device
has permissions set on the PC (read only / chat / may add documents).

Requests are JSON objects `{ "id", "type", "params" }`; responses `{ "id", "ok", "result" | "error" }`; streams are
sequences of `{ "id", "chunk" }` ending with `{ "id", "done" }`. The parser on the PC rejects unknown types, unknown
fields and oversized values, and is fuzz-tested.

## 7. The relay

- Accepts WebSocket connections over TLS.
- A **PC** connects with its routing id and answers a random challenge with its Ed25519 key; only then does the
  relay accept frames for that id. A second connection for the same id replaces the first only after the same proof.
- A **phone** connects with a routing id; the relay pairs it with the PC's connection and forwards frames both ways.
  It cannot read them and cannot tell pairing from normal use beyond frame sizes and timing.
- Limits: frame size, frames per second, connections per IP and per routing id, total bandwidth per routing id per
  day (generous; stops abuse, not users).
- Logs: connection counts and errors, **no content, no routing ids together with IP addresses** beyond 7 days.
- Stateless apart from live connections: nothing to steal at rest.
- Open source (Apache-2.0, in this repository), Docker image, self-hostable: the PC and the app accept any relay URL.
- Official instance: `relay.starkllm.com`, hosted in Germany.

What the relay operator **can** learn: that a PC with routing id X is online, from which IP, and when and how much
a phone talks to it. Version 1 accepts this metadata exposure and documents it; padding frames to fixed sizes is
planned for version 2.

## 8. Threats and answers

| Threat | Answer |
|---|---|
| Relay operator or attacker on the relay reads data | End-to-end encryption; the relay only sees ciphertext |
| Someone impersonates the PC to the phone | The phone checks the PC's static key from the QR code (Noise IK) |
| Someone connects as an unapproved phone | The PC only accepts approved device keys; unknown keys are dropped before any request |
| Photo of the pairing QR code | Valid 5 minutes, one use, and the pairing must be confirmed on the PC with a matching code |
| Recorded traffic decrypted later | Forward secrecy (ephemeral keys per session) |
| Stolen or lost phone | Remove the phone on the PC; its key stops working at once. Optional app lock with Face ID / fingerprint |
| Phone malware reads the key | The key lives in Keychain / Keystore and is not exportable; the device's own protection applies |
| A bug lets the phone call internal functions | Allow-list protocol, no HTTP tunnel, strict parser, fuzzing, per-device permissions |
| Hijack of the PC's routing id at the relay | Ed25519 challenge; the relay never accepts an id without the key |
| Denial of service on the relay | Rate limits and quotas; the PC keeps working locally |
| Flooding a PC with handshakes | The relay limits phones per routing id; the PC drops unknown keys cheaply |

## 9. Phone app

- **One TypeScript protocol core** (`mobile/core`): Noise, framing, requests; tested in CI against the Python side.
- **PWA first** (`mobile/web`): installable from the browser on iOS and Android; proves the whole path end to end
  before the store apps. Keys in IndexedDB as non-extractable WebCrypto keys where possible; the PWA shows that the
  native app protects keys better.
- **iOS and Android app** (`mobile/app`, React Native with Expo): QR scanning, keys in Keychain / Keystore,
  optional biometric lock, streamed answers with sources, voice questions, *Share to StarkLLM* (send a PDF from
  another app to the PC), German and English like the desktop app.
- Builds in the cloud (Expo EAS) and in GitHub Actions; no Mac needed.
- Push notifications later and without content ("an answer is ready"), because they pass through Apple and Google.

## 10. Order of work (each a pull request with its own tests)

1. **This design** — review and approval.
2. **Protocol core** — Noise on both sides, official test vectors, Python↔TypeScript interoperability, framing,
   request parser with fuzzing.
3. **Relay** — service, limits, Docker image, tests including load and abuse cases.
4. **PC side** — relay connection, pairing with QR and confirmation, approved devices, allow-listed requests,
   *Settings > Phones*.
5. **Web app (PWA)** — end-to-end test in CI: engine + relay + headless browser.
6. **iOS and Android app** — Expo app, internal test builds (TestFlight, Google Play internal testing).
7. **Hardening** — security review of the whole path, an external audit before the public store release.

## 11. What the owner provides

- Apple Developer Program (99 USD per year) and Google Play developer account (25 USD once), in the owner's name.
- A small server in Germany for the official relay (about 5 EUR per month) and the DNS entry `relay.starkllm.com`.
- Privacy policy and imprint for the store listings (the website's pages, extended for the app).

## 12. Decisions to confirm

1. Noise (IKpsk2 for pairing, IK for sessions) with existing libraries that pass the official test vectors.
2. A relay we operate and publish as open source, instead of a third-party tunnel service.
3. The phone gets an allow-list protocol, not access to the engine's HTTP API.
4. Pairing needs a confirmation on the PC with a matching code.
5. PWA first, then the React Native (Expo) app for iOS and Android.
