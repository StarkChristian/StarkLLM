# StarkLLM Remote Access — Design

Status: **approved on 2026-11-15** by the owner (all five decisions in section 13). Steps 2 and 3 of the order of work
(protocol core and relay) are implemented in this branch; see section 12 for what is done and what is next.
Date of the proposal: 9 November 2026. Roadmap phases 4 and 5: access from the phone, iOS and Android apps.

## 1. Goal

Use StarkLLM on your PC from your phone — at home and on the road — with the same promise as on the PC:
your documents and conversations stay yours.

Requirements, in order of priority:

1. **Nobody but your phone and your PC can read questions, answers or documents** — not the relay operator
   (us), not the network, not Apple or Google.
2. **The PC opens no port.** It only makes outgoing connections, like today's update check and the Telegram bridge.
3. **Only phones you approved on the PC get in**, and you can remove a phone at any time.
4. **A stolen phone or a leaked server must not expose the PC's data.**
5. **The relay is open source and can be self-hosted.** The official relay is run in Germany.
6. Simple for the user: scan a QR code once, then it works everywhere.

Non-goals for version 1: sharing with other people, several PCs behind one phone account, push
notifications with content, access without the PC running, uploading documents from the phone.

## 2. Overview

```
 Phone app (iOS / Android / PWA)          Relay (relay.starkllm.com, open source)          PC (StarkLLM)
 ───────────────────────────────          ──────────────────────────────────────          ────────────────────
 device key (Keychain / Keystore)                                                           PC key (data folder)
        │                                                                                         │
        │  WebSocket (TLS)  ──────────────►   forwards opaque frames   ◄────────────── WebSocket (TLS), outgoing
        │                                     by mailbox id; sees no                       │
        │                                     content, keeps no content                     │
        └──────────── end-to-end encrypted session (Noise IK) ─────────────────────────────┘
                                inside: StarkLLM remote protocol (allow-listed requests)
```

- **Protocol core** (`mobile/core`, package `@starkllm/remote-core`): one JavaScript codebase (ES modules with JSDoc
  types) used by every side — the PC side (Node, inside the Electron main process), the PWA and later the React Native
  app. One implementation of framing, allow-list and state machines means no second implementation to keep in sync.
  Specification: `mobile/core/PROTOCOL.md`.
- The **PC side** is the `RemoteHost` class of the core plus a small integration in the desktop app (relay connection,
  *Settings > Phones*, adapter to the engine's HTTP API). The engine itself (Python) never sees the phone and has no
  new endpoint; the adapter calls the five existing read/ask functions on `127.0.0.1`.
- The **relay** is a small, separate service: `relay/` in this repository (Node, one dependency, own Dockerfile).
- The **phone client** is the same core: first a web app (PWA), then the iOS and Android app (React Native with Expo).

Transport security is layered: TLS to the relay (protects the relay link on the wire) **and** end-to-end encryption
between phone and PC (protects everything from the relay).

## 3. Keys and identities

| Key | Type | Where | Purpose |
|---|---|---|---|
| PC static key | X25519 | `<data>/remote/identity.json` (file mode 600) | Noise identity of the PC |
| PC relay key | Ed25519 | same file | proves to the relay that the PC owns its routing id |
| Routing id | `base32(SHA-256(relay public key)[0..20])`, 32 characters | public | address of the PC at the relay; reveals nothing else |
| Device static key | X25519 | iOS Keychain / Android Keystore (`expo-secure-store`), never exported | Noise identity of one phone |
| Pairing secret | 32 random bytes | only in the QR code and in the PC's memory | binds the first contact to the person who sees the PC screen |

All keys are created on the device that uses them. No key is ever sent to the relay or to us. (The routing id uses
SHA-256 truncated to 160 bits because Node's crypto library has no 160-bit BLAKE2b; the construction is equivalent for
this purpose.)

## 4. Pairing (once per phone)

1. On the PC: **Settings > Phones > Add phone**. The PC creates a pairing secret (valid 5 minutes, one use, a new
   offer replaces the previous one) and shows a QR code with:
   `starkllm://pair?v=1&relay=<wss url>&id=<routing id>&pk=<PC static public key>&s=<pairing secret>&exp=<unix seconds>&n=<PC name>`
2. The phone scans it. It now knows *which* PC (its public key) and has a secret only someone who saw the screen
   can have. It refuses the QR code if it is expired, not `wss://` (except `ws://localhost` in development), or has
   unknown or duplicate fields.
3. The phone runs the **Noise IKpsk2** handshake through the relay, with the pairing secret as PSK. The handshake
   fails unless the phone has the secret *and* the PC has the private key matching the QR code. The phone proves it
   knows the secret by sending the first encrypted message (`pair.hello` with its name); that message can only be
   built with keys that depend on the secret. Up to three unfinished handshakes per offer are tolerated; the first
   phone that completes the proof spends the secret and the others are dropped.
4. The PC shows the phone's name and a **6-digit check code** derived from the handshake hash; the phone shows the
   same code. **The user confirms on the PC** ("Allow *iPhone of Christian*? Code 482 913"). Only then is the device key
   stored as approved, with the permissions the user chose. (The proposal said four digits; six are used because the
   cost is nil and the chance of an accidental match drops from 1 in 10 000 to 1 in a million.)
5. The secret is deleted. A scanned-but-not-confirmed QR code is worthless after 5 minutes.

The confirmation step (4) means a photographed QR code alone is not enough: an attacker would also need someone to
press *Allow* on the PC.

## 5. Sessions (every connection)

- **Handshake:** Noise **IK** (`Noise_IK_25519_ChaChaPoly_BLAKE2s`), phone as initiator. The phone knows the PC's
  static key from pairing; the PC checks the phone's static key against its list of approved devices and **drops the
  connection without any reply** otherwise (no oracle for attackers). Prologue: `StarkLLM-remote-v1/session`
  (`…/pairing` for the pairing handshake), which binds the protocol version and the purpose.
- **Suite:** `25519_ChaChaPoly_BLAKE2s`. The proposal named BLAKE2b; BLAKE2s is the variant the chosen library
  implements, it is part of the Noise specification, and it is the faster one on 32-bit phone CPUs.
- **Forward secrecy:** new ephemeral keys every session; a later theft of a static key does not decrypt recorded
  sessions.
- **Replay protection:** every first handshake message carries a timestamp (accepted within ±2 minutes) and its
  ephemeral key is remembered for 4 minutes; a replayed or stale first message is dropped without reply. Inside
  a session Noise's implicit 64-bit counters make a replayed, dropped, duplicated or reordered frame fail to decrypt,
  and **any decryption failure ends the session**. Request ids are unique per session (duplicates are refused).
- **Rekeying:** both sides rekey their sending and receiving key after every 1 000 messages (deterministic, no extra
  message). A session lives at most 1 hour (the phone then reconnects with a fresh handshake) and ends after 10 minutes
  without traffic.
- **Padding:** plaintexts are padded to multiples of 256 bytes, so the relay learns sizes only in coarse steps
  (the proposal planned this for version 2; it was cheap enough for version 1).
- **Message size:** at most 60 000 bytes per JSON message (one Noise message is at most 65 535 bytes); longer answers
  are streamed as chunks.
- **Versioning:** the first byte of every frame is the protocol version; unknown versions are refused. Breaking changes
  get a new version and a new prologue.
- **Key rotation and revocation:** see section 7.

### Library rule

We do not implement cryptography ourselves. The Noise implementation is an existing library, **`salty-crypto`**
(TypeScript, MIT, no dependencies, works in Node, browsers and React Native; exact version pinned). The decision was
made after checking the alternatives: `noise-protocol` and `noise-handshake` (JavaScript) do not support IKpsk2,
`noise-c.wasm` does not support it either and is unmaintained, `clatterjs` is aimed at post-quantum patterns and does
not run the official vectors. Python's `noiseprotocol` supports everything but would mean a second language for the
phone side.

Safeguards that make the choice replaceable and checked:

- **Official test vectors run in CI** (`mobile/core/test/noise-vectors.test.js`): the vector sets of cacophony (the set
  listed on the Noise wiki), snow and noise-c, filtered to our suite — 125 vectors over 72 distinct protocols, including `IK`
  and `IKpsk2` — are replayed against the library byte for byte. The reduced files are committed with the SHA-256 of
  the original downloads.
- **Interoperability with a second, independent implementation** (`mobile/core/test/interop/verify_fixture.py`): CI
  replays a deterministic transcript (both handshakes, padded transport messages, the rekey schedule) with the Python
  library `noiseprotocol` and requires identical bytes.
- All Noise code is behind one file (`mobile/core/src/noise.js`). If a vector fails after an update, or the library is
  abandoned, we replace it there; we do not patch cryptography.
- Honest caveat: version `1.0.0-rc.4` is a release candidate from a single maintainer. Before the public store release
  the external audit (section 12, step 7) covers this dependency explicitly.

## 6. What a phone may do (inside the session)

The phone does **not** get a tunnel to the engine's HTTP API. It speaks a small request protocol, and the PC answers
only an allow-list. Requests are JSON objects `{ "id", "type", "params" }`; responses `{ "id", "ok", "result" | "error" }`;
streams are `{ "id", "chunk" }` messages ending with `{ "id", "done", "result" }`.

| Request | Permission | Notes |
|---|---|---|
| `inbox.list` | read | the latest inbox summaries, paged (`limit`, `cursor`, `unread_only`) |
| `deadlines.list` | read | upcoming deadlines (`within_days`, `limit`) |
| `cases.list` | read | cases with status (`status`, `limit`, `cursor`) |
| `chat.ask` | chat | ask a question; the answer streams in chunks and ends with the **citations** (`source_id`, title, page, snippet) |
| `source.open` | read | open one source passage by the opaque `source_id` returned in a citation |
| `device.info` | read | the phone's own name and permissions |
| `device.rotate_key` | read | the phone announces a new device key (section 7) |

The phone keeps the latest summaries (inbox, deadlines, cases) in encrypted storage on the device so the app can show
them offline.

Never available remotely: settings, model management, backup and restore, local tools (MCP), code execution, account
management, Telegram settings, document upload. Other read requests (workspaces, chats, knowledge-base search) can be
added later by an explicit decision; adding a type means adding one entry to the allow-list table, one engine adapter
method and tests. Every request runs as the StarkLLM user who approved the phone. Each device has permissions set on the
PC (`read`, or `read` + `chat`).

How "anything outside the allow-list is refused" is enforced (`mobile/core/src/protocol.js`, `host.js`):

1. `parseRequest` accepts only types that are own properties of the frozen allow-list table, with closed parameter
   schemas: unknown fields, wrong types, out-of-range numbers, control characters and oversized strings are refused.
   The engine receives the validated copy, never the received object.
2. The permission of the device is checked per request type.
3. The host calls exactly five engine adapter methods, selected from its own table (never by a name from the
   message). Refused requests get an error response and nothing else happens.
4. Tests: property-based and fuzz tests on the parser, 400 random messages inside a live session and 300 random frames
   on the link, with an engine object that fails the test if anything outside the five methods is touched.

## 7. Key rotation and revocation

- **Revoking a phone** (*Settings > Phones > Remove*): the device record is marked revoked; its live sessions are
  closed at once (and the relay is asked to disconnect it); the key no longer completes a handshake, and every
  request re-checks the registry, so a session cannot outlive the revocation. The record stays (name, time) so the
  PC can show the history.
- **Phone key rotation:** inside an authenticated session the phone sends `device.rotate_key` with a new public key.
  The PC accepts both keys until the first session with the new key succeeds, then retires the old one. A rotation
  that was announced but not used is cancelled by revocation.
- **PC key rotation:** the PC creates a new key and keeps the previous one for a grace period (default 14 days).
  A phone that connects with the old key is accepted and told the new key inside the authenticated session; it stores
  it and uses it from then on. A phone that was offline longer than the grace period must be paired again. Rotation
  also invalidates any open pairing offer.
- **Relay key** (the routing id): it is never rotated silently, because the id is in every paired phone's record.
  Changing it means pairing again; the PC shows it as "Create a new address".
- Sessions rekey themselves (section 5), so no long-lived symmetric key exists.

## 8. The relay

Code: `relay/`. Notes for operators: `relay/README.md`; deployment on the Contabo server: `docs/relay-deployment-contabo.md`
(a document only; nothing is deployed by this change).

- Accepts WebSocket connections (TLS terminates at the Cloudflare tunnel in front of it).
- A **PC** connects to `/v1/pc?id=<routing id>` and answers a random challenge with an Ed25519 signature; the relay
  checks that the key's hash is the routing id. Only then does it create the **mailbox**. A new connection with the
  same proof replaces the old one.
- A **phone** connects to `/v1/phone?id=<routing id>`. If no mailbox exists the upgrade is answered with 404 (an
  unknown id and an offline PC look the same). The relay gives each phone connection a random 8-byte connection id,
  prefixes frames to the PC with it and removes it again on the way back. It cannot read frames and cannot tell pairing
  from normal use beyond frame sizes and timing.
- **No accounts, no stored data.** Everything lives in memory. A mailbox exists only while its PC is connected; when
  the PC leaves, its phones are disconnected and the mailbox is gone. Phones are disconnected after 10 minutes without
  traffic or 2 hours of age; a PC connection after 24 hours (the client reconnects).
- **Limits:** frame size (65 537 bytes from a phone), frames per second per connection (token bucket), phones per
  mailbox (8), PCs per IP (4), phones per IP (32), new connections per IP per minute (120), bytes per mailbox per
  day (1 GiB). All configurable by environment variables; exceeding a limit closes the connection with a specific code.
- **Logs:** event names and a reason code from a fixed list. No IP addresses, no routing ids, no content — the
  logging function cannot emit anything else, and a test checks it. The proposal allowed connection data for 7 days;
  the implementation keeps none.
- Health endpoint: `GET /healthz`.
- Open source (Apache-2.0), Docker image, self-hostable: the PC and the app accept any relay URL.
- Official instance: `relay.starkllm.com`, hosted in Germany.

## 9. Threat model

### 9.1 What is protected, and from whom

Assets: the content of questions, answers, documents, inbox summaries, deadlines and cases; the PC's data and engine;
the identity of the paired phones.

| Adversary | Capabilities assumed |
|---|---|
| Network observer | sees all traffic between the phone and the relay and between the PC and the relay |
| Relay operator / relay host compromised | runs arbitrary code on the relay: reads, drops, delays, replays, reorders and injects frames; connects as any client |
| Someone who photographs or copies the QR code | has the pairing secret, the PC's public key and the routing id |
| Finder or thief of a phone | has the phone, possibly unlocked, possibly able to extract app storage |
| Other app on the phone | tries to read the key or the cached summaries |
| Malicious phone (approved or not) | sends arbitrary frames, tries to call anything on the PC |
| Local attacker on the PC | already has the PC — out of scope (they can read the documents directly) |

### 9.2 What the relay can and cannot learn

| The relay **can** learn | The relay **cannot** learn |
|---|---|
| That a PC with routing id X is online, its IP address (the Cloudflare tunnel adds its own layer), and when it connects | Any question, answer, document name, summary, deadline or case |
| That phones connect to X, their IP addresses, how many at once, and when | Which phone is which, a phone's name, or whether a connection is pairing or normal use (beyond timing and size) |
| Frame sizes (in 256-byte steps, plus a fixed overhead) and timing, so roughly *when* and *how much* someone asks and how long an answer is | The exact length of any message (padding) |
| That a connection failed or was refused | The PC's or the phones' static keys (they are encrypted inside the handshake; the routing id is a hash of the *relay* key, not of the Noise key) |
| | The pairing secret or any session key |

Traffic analysis (for example guessing that a long streamed answer followed a question) remains possible. Version 1
accepts this and documents it; constant-rate cover traffic is not planned because of battery cost on phones.

### 9.3 Malicious or compromised relay (active attacks)

| Attack | Result |
|---|---|
| Read frames | Ciphertext only (ChaCha20-Poly1305 under Noise keys the relay never has) |
| Modify a frame | Authentication fails; the session ends |
| Replay a frame, or a recorded first handshake message | Frames: counter mismatch, the session ends. First messages: stale timestamp or seen ephemeral key, dropped without reply |
| Drop, delay or reorder frames | The session fails (counter mismatch) or stalls; no wrong data is ever accepted. This is denial of service, which a relay can always do |
| Pose as the PC to a phone | Needs the PC's static private key; the phone checks the key from the QR code (Noise IK) |
| Pose as a phone to the PC | Needs an approved device private key; unknown keys are dropped without reply |
| Hijack the PC's routing id | Needs the PC's Ed25519 private key (challenge-response); the id is the hash of the public key |
| Man in the middle during pairing | Needs the pairing secret (IKpsk2); also the codes on the two screens would differ |
| Send a PC thousands of handshakes | The PC drops unknown keys cheaply; the relay (the honest one) rate-limits, a malicious one can still flood — the PC bounds its peers and handshake state (64 peers, replay cache bound) |
| Kick phones off, refuse service | Possible. Mitigation: relay URL is configurable, self-hosting is documented |
| Serve a modified web app to the phone | Not the relay's job: the PWA is loaded **from the PC**, not from the relay (decision 5) |

### 9.4 Stolen or photographed QR code

- The QR code is shown only while pairing and expires after 5 minutes; it works once (the first phone that completes
  the proof spends it), and a new offer replaces it.
- Someone with only the QR code can start a pairing, but the user then sees an unfamiliar device name and a code on
  the PC and presses **Deny**; nothing is approved without the click. The phone is told when a pairing was
  denied or expired.
- Someone who photographed the QR *and* wins the race against the real phone: the real phone then fails (the secret is
  spent) and shows an error; the user will notice that the phone did not pair, and the PC shows the stranger's code.
  Remaining weak point: a user who presses **Allow** without checking the device name and code. The PC dialog (step 4 of the order of work)
  must show the name and code prominently and default to Deny.
- The relay cannot use the QR code: it does not see it (it is shown on the PC screen and scanned by the phone).

### 9.5 Lost or stolen phone

- **Remove the phone on the PC** (*Settings > Phones > Remove*): live sessions end immediately, the key is refused from
  then on. If the PC is switched off, removal takes effect the moment the PC is online, and nothing can be read from
  the PC while it is off.
- What the thief can get **from the phone** if they can unlock it or extract the app data: the cached summaries
  (inbox, deadlines, cases) and the device key. Mitigations: the cache is encrypted with a key kept in Keychain /
  Keystore; the native app offers an optional Face ID / fingerprint lock; the PWA stores keys in IndexedDB as
  non-extractable keys where the browser allows it, which is weaker (the PWA says so, and recommends the native app).
- What the thief can get **from the PC**: only what an approved phone with its permissions can ask, and only until the
  user removes the phone. `read`-only phones cannot ask new questions. A thief cannot change settings, models,
  backups, tools or other phones (not in the allow-list).
- A thief who knows only the old QR code gets nothing: it was spent or expired long ago.

### 9.6 Other threats

| Threat | Answer |
|---|---|
| A bug lets the phone call internal functions | Allow-list protocol, closed schemas, five engine methods, no HTTP tunnel; fuzzing in CI |
| Flooding or oversized messages from an approved phone | Per-device token bucket, in-flight limit, message and stream size limits |
| Compromise of the phone's key later | Forward secrecy: recorded sessions stay unreadable. Remove the phone and pair again |
| Compromise of the PC's static key | A thief could pose as the PC to phones that still trust it; rotate the PC key (section 7), phones learn the new key from the next session. Recorded past sessions stay unreadable |
| Small-order Curve25519 points, malformed handshakes | Refused before use; every malformed input is a `ProtocolError`, tested with mutation fuzzing |
| Library flaw in Noise | Official vectors and independent interop in CI; replaceable behind one file; external audit before the public release |
| Metadata at Apple and Google | Push notifications (later) carry no content ("an answer is ready"); everything else goes through our own relay |
| The relay's logs or backups leak | Nothing to leak: no content, no ids, no IPs, nothing on disk |

### 9.7 Known limitations of version 1

- Traffic analysis as described in 9.2.
- The first PWA keeps keys in browser storage (weaker than Keychain / Keystore).
- One PC per phone record; no sharing between people.
- The `rc` status of the Noise library (audit planned).
- The pairing code is 6 digits; it protects against *accidental* wrong pairings and a confused user, while the
  cryptographic protection against an active attacker is the pairing secret.

## 10. Phone app

- **One protocol core** (`mobile/core`): Noise, framing, requests; tested in CI against the Python implementation.
- **PWA first** (`mobile/web`): installable from the browser on iOS and Android; loaded **from the PC** (not from the
  relay), so the relay can never serve code that reads the keys. It proves the whole path end to end before the store
  apps. Keys in IndexedDB as non-extractable WebCrypto keys where possible.
- **iOS and Android app** (`mobile/app`, React Native with Expo): QR scanning, keys in Keychain / Keystore,
  optional biometric lock, streamed answers with sources, voice questions, *Share to StarkLLM* (send a PDF from
  another app to the PC), German and English like the desktop app (international audience: English first,
  German second).
- Builds in the cloud (Expo EAS) and in GitHub Actions; no Mac needed.
- Push notifications later and without content ("an answer is ready"), because they pass through Apple and Google.

## 11. Repository layout

| Path | What |
|---|---|
| `docs/remote-access-design.md` | this document |
| `docs/relay-deployment-contabo.md` | deployment notes for the official relay (document only) |
| `mobile/core/` | protocol core: `src/`, `PROTOCOL.md`, tests, vectors, interop fixture |
| `relay/` | the relay: `src/`, `Dockerfile`, `README.md`, tests |
| `.github/workflows/mobile-core.yml` | CI: vectors, property/fuzz tests, Python interop, relay tests, Docker build |

## 12. Order of work (each a pull request with its own tests)

1. **This design** — approved 2026-11-15.
2. **Protocol core** — *done in this branch*: Noise handshakes (IKpsk2, IK) with official vectors and Python
   interoperability in CI, framing, versioning, allow-list and strict parser with property/fuzz tests, replay
   protection, key rotation, revocation, pairing and session state machines, simulated end-to-end test.
3. **Relay** — *done in this branch*: service, limits, Docker image, end-to-end test through a real relay with a
   plaintext-leak check, deployment notes. Not deployed. Load testing at larger scale is left for the first
   deployment.
4. **PC side** — relay connection in the desktop app, pairing page with QR code and confirmation, approved devices
   storage, engine adapter for the five requests, *Settings > Phones*. *Next.*
5. **Web app (PWA)** — end-to-end test in CI: engine + relay + headless browser.
6. **iOS and Android app** — Expo app, internal test builds (TestFlight, Google Play internal testing).
7. **Hardening** — security review of the whole path, an external audit before the public store release.

## 13. Decisions (approved 2026-11-15)

1. Noise (IKpsk2 for pairing, IK for sessions) with existing libraries that pass the official test vectors. **Approved.**
   Implemented with `salty-crypto` (section 5, "Library rule").
2. A relay we operate and publish as open source, instead of a third-party tunnel service. **Approved.** The official
   instance runs at `relay.starkllm.com` on the Contabo server in Germany behind a Cloudflare tunnel.
3. The phone gets an allow-list protocol, not access to the engine's HTTP API. **Approved.** Allow-list in section 6.
4. Pairing by QR code plus confirmation of a matching code on the PC. **Approved.**
5. PWA first (loaded from the PC), then the React Native (Expo) app for iOS and Android built in the cloud with EAS.
   **Approved.**

### Concrete choices made while implementing (for review)

| Topic | Choice | Why |
|---|---|---|
| Language of the core | JavaScript (ES modules, JSDoc types, no build step) | one codebase for Electron, PWA and React Native |
| Noise library | `salty-crypto` 1.0.0-rc.4, pinned | only maintained JS library that supports IKpsk2 and has no dependencies |
| Hash | BLAKE2s (not BLAKE2b) | what the library implements; part of the Noise specification |
| Routing id | base32 of the first 20 bytes of SHA-256 of the Ed25519 key | Node has no 160-bit BLAKE2b |
| Check code | 6 digits | safer against accidents, same effort |
| Padding | 256-byte steps from version 1 | cheap, hides exact lengths |
| Rekey | every 1 000 messages per direction, session maximum 1 hour | deterministic, no extra message |
| Allow-list | `inbox.list`, `deadlines.list`, `cases.list`, `chat.ask`, `source.open`, `device.info`, `device.rotate_key` | matches the phone's first use cases; the older list in the proposal (workspaces, chats, `kb.search`, documents) can be added later |
| Uploads | not in version 1 | smaller attack surface for the first release |
| Relay language | Node with `ws` (one dependency) | same language as the core, tests can run the real core against the real relay |
| Mailbox model | in memory, exists while the PC is connected | nothing to store, nothing to leak |
| Logging | fixed vocabulary, no ids or IPs | a test enforces it |
