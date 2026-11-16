# StarkLLM remote protocol, version 1

All integers are big-endian. Strings are UTF-8. "PC" is the machine running StarkLLM, "phone" any client.

## Layers

```
 JSON message  ->  padded plaintext  ->  Noise transport message  ->  wire frame  ->  relay link
```

## Wire frame

```
 byte 0       protocol version (1); any other value is refused
 byte 1       kind
 bytes 2..    one Noise message (16..65535 bytes; handshake messages have their own minimum sizes)
```

| Kind | Direction | Content |
|---|---|---|
| 1 `PAIR_1` | phone -> PC | first message of `Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s` |
| 2 `PAIR_2` | PC -> phone | second message of the pairing handshake |
| 3 `SESSION_1` | phone -> PC | first message of `Noise_IK_25519_ChaChaPoly_BLAKE2s` |
| 4 `SESSION_2` | PC -> phone | second message of the session handshake |
| 5 `DATA` | both | Noise transport message |

Prologues: `StarkLLM-remote-v1/pairing` and `StarkLLM-remote-v1/session`.

## Handshake payloads (JSON, encrypted by Noise)

- `PAIR_1`, `SESSION_1`: `{"v":1,"ts":<unix ms>}`. The PC refuses it if `|now - ts| > 2 min` or the initiator's ephemeral
  key (first 32 bytes) was already seen in the last 4 minutes.
- `PAIR_2`: `{"v":1,"status":"ok"}`.
- `SESSION_2`: `{"v":1,"max_message":60000,"idle_ms":600000,"max_age_ms":3600000}`.

A PC answers an unknown, revoked or malformed handshake with **nothing** (the link is closed).

## Transport

- Plaintext = `u16 length || message || zero padding`, padded to a multiple of 256 bytes. The receiver checks that
  the padding is all zero.
- `message` is a JSON object of at most 60 000 bytes.
- Nonces are Noise's implicit 64-bit counters (one per direction). A message that is replayed, dropped, duplicated or
  reordered fails to decrypt, and **a failed decryption ends the session**.
- After every 1 000th message sent, a side calls `Rekey()` on its sending key; after every 1 000th message received it
  calls `Rekey()` on its receiving key. No message is exchanged for this.
- A session ends after 10 minutes without traffic or 1 hour of age.

## Pairing

1. The PC shows `starkllm://pair?v=1&relay=<wss url>&id=<routing id>&pk=<PC public key>&s=<32-byte secret>&exp=<unix s>[&n=<name>]`
   (keys in base64url without padding, `id` is 32 characters base32). Valid 5 minutes, one use.
2. Phone -> PC `PAIR_1`; PC -> phone `PAIR_2`. IKpsk2 mixes the secret into the keys of message 2, so only a phone that
   knows it can read what follows.
3. Phone -> PC `DATA`: `{"type":"pair.hello","name":"<device name, at most 64 characters>"}`. This is the proof of the
   secret. The PC marks the secret as spent and shows the name and the **check code**.
4. Check code: first four bytes of the handshake hash (after message 2), as an unsigned integer modulo 1 000 000,
   six digits with leading zeros. The phone shows the same code.
5. The user presses Allow or Deny on the PC. PC -> phone `DATA`:
   `{"type":"pair.result","approved":true,"device_id":"...","permissions":["read","chat"],"pc_name":"..."}`
   or `{"type":"pair.result","approved":false}`. The link is then closed.

## Requests and responses

Request: `{"id": "<1-64 chars [A-Za-z0-9_-]>", "type": "<allow-listed type>", "params": { ... }}` — no other fields.

| Type | Permission | Params (all closed; unknown fields refused) | Engine adapter method |
|---|---|---|---|
| `inbox.list` | read | `limit` 1-100, `cursor` opaque string, `unread_only` bool | `inboxList` |
| `deadlines.list` | read | `within_days` 1-365, `limit` 1-100 | `deadlinesList` |
| `cases.list` | read | `limit`, `cursor`, `status` = `open` / `closed` / `all` | `casesList` |
| `workspaces.list` | read | `limit` 1-100 | `workspacesList` |
| `chats.list` | read | `workspace_id`, `limit` 1-100, `cursor` | `chatsList` |
| `kb.search` | read | `query` (1-500 characters, required), `workspace_id`, `limit` 1-20 | `kbSearch` |
| `chat.ask` | chat | `question` (1-4000 characters, required), `workspace_id`, `conversation_id` | `chatAsk` (async iterable) |
| `source.open` | read | `source_id` (opaque id from a citation or search hit, required), `max_chars` 100-20000 | `sourceOpen` |
| `documents.upload.begin` | upload | `upload_id`, `name`, `size`, `chunks`, `hash`, `workspace_id` | answered by the host |
| `documents.upload.chunk` | upload | `upload_id`, `index` 0-799, `data` (base64url, at most 43 700 characters) | answered by the host |
| `documents.upload.finish` / `.status` / `.cancel` | upload | `upload_id` | answered by the host |
| `device.info` | read | none | answered by the host |
| `device.rotate_key` | read | `public_key` (base64url of 32 bytes) | answered by the host |

Permissions: `read`, `chat` (implies `read`), `upload` (separate, off by default). Plus the engine's one **ingest** method
`documentIngest`, which the host calls only after the user confirmed an upload on the PC; no request can trigger it.

### Document upload

```
begin   {upload_id, name, size, chunks, hash, workspace_id?}  -> {upload_id, chunk_bytes: 32768, chunks}
chunk   {upload_id, index, data}                              -> {received}          (in order, exact size)
finish  {upload_id}                                           -> {upload_id, status: "pending_confirmation"}
status  {upload_id}                                           -> {status: receiving|pending_confirmation|accepted|denied|failed|cancelled|expired, ...}
cancel  {upload_id}                                           -> {status: "cancelled"}
event   {"event":"upload.result","data":{"upload_id","status","document_id"?}}   after the user decided
```

- `size` at most 25 MiB; `chunks` must equal `ceil(size / 32768)`; every chunk except the last has exactly 32 768 bytes.
- `hash` is the BLAKE2s-256 of the whole file as 64 lower-case hex characters.
- `name`: a single file name (letters and digits of any script, space, `._()+-`; at most 120 characters; no path parts, no `..`,
  no reserved Windows names, no executable-looking stem). Extension (case-insensitive): `pdf`, `txt`, `md`, `docx`, `png`, `jpg`, `jpeg`.
- At `finish` the host checks hash and content (magic bytes; text must be UTF-8 without control characters and not look like a
  script). The file is never opened, unpacked or executed by the remote code.
- The file then waits for the user's Allow or Deny on the PC for 10 minutes; Deny, timeout, a failed check or removal of the
  phone deletes it. Only after Allow does `documentIngest({name, bytes, size, hash, workspace_id, origin: "phone-upload",
  untrusted: true}, ctx)` run.
- One open upload per phone; an upload with no new chunk for 10 minutes expires.

Opaque ids are printable ASCII without spaces, 1-128 characters. They are looked up by the engine adapter; they are
never used as paths.

Responses:

```
{"id": "...", "ok": true,  "result": { ... }}
{"id": "...", "ok": false, "error": {"code": "...", "message": "..."}}
{"id": "...", "chunk": {"delta": "text"}}                                   (streamed requests, zero or more)
{"id": "...", "done": true, "result": {"citations": [{"source_id": "...", "title": "...", "page": 2, "snippet": "..."}]}}
{"event": "host.key_rotated", "data": {"public_key": "..."}}                (unsolicited, authenticated)
{"event": "host.session_expired"}
```

Error codes: `bad_request`, `unknown_type`, `forbidden`, `duplicate_id`, `rate_limited`, `too_large`,
`not_found` (unknown upload), `engine_error` (always a generic message; internal details are never sent), `session_expired`.

Anything that is not an allow-listed type gets `unknown_type` and nothing else happens. Per device: 10 requests per
second (burst 30), 4 requests in flight, streamed answers at most 4 MiB.

## Engine adapter (PC side)

```js
{
  inboxList(params, ctx) -> Promise<object>       // { items: [...], next_cursor }
  deadlinesList(params, ctx) -> Promise<object>
  casesList(params, ctx) -> Promise<object>
  sourceOpen(params, ctx) -> Promise<object>      // { source_id, title, page, text }
  chatAsk(params, ctx) -> AsyncIterable<{ delta?: string, citations?: object[] }>
  kbSearch(params, ctx) -> Promise<object>        // { hits: [{ source_id, title, page, snippet, score }] }
  workspacesList(params, ctx) -> Promise<object>  // { items: [{ id, name }] }
  chatsList(params, ctx) -> Promise<object>       // { items: [{ id, title, workspace_id }] }
  documentIngest(file, ctx) -> Promise<{ document_id?: string }>   // only after the user confirmed an upload
}
```

`params` is the validated copy; `ctx` is frozen `{ deviceId, deviceName, permissions }`. The host never calls anything
else on the adapter.

## Relay link (between a client and the relay)

WebSocket over TLS. The relay only handles the envelope; it never parses frames.

- PC: `GET /v1/pc?id=<routing id>`. The relay sends `{"t":"challenge","nonce":"<base64url>"}`; the PC answers
  `{"t":"auth","pk":"<Ed25519 public key>","sig":"<signature>"}` over the bytes
  `starkllm-relay-v1|pc-auth|<routing id>|<nonce>`. The relay checks that `base32(SHA-256(pk)[0..20]) == id`, then
  sends `{"t":"ready"}`. Later it sends `{"t":"peer","peer":"<16 hex>","up":true|false}`.
  Binary frames between PC and relay carry an 8-byte connection id in front of the wire frame. The PC can send
  `{"t":"kick","peer":"<16 hex>"}` to disconnect a phone.
- Phone: `GET /v1/phone?id=<routing id>`. If the PC is not connected the upgrade is answered with 404. The relay sends
  `{"t":"ready","peer":"<16 hex>"}`; binary frames are wire frames.
- Close codes: 4000 renew (maximum age), 4001 replaced, 4003 auth failed / removed, 4004 PC offline, 4008 bad frame,
  4009 limit, 4010 idle, 4029 rate limited.

## Versioning

`v1` is this document. A breaking change increments the version byte and the prologue; both sides refuse versions
they do not know (`unsupported_version`). New request types and new optional fields in responses are not breaking
changes; new fields in requests are refused by older PCs, so a phone must only send what the PC announces to support
(planned for version 2: capability list in `SESSION_2`).
