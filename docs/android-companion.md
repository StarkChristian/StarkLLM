# StarkLLM for Android (companion app)

StarkLLM for Android is a companion of StarkLLM on a Windows PC. The phone asks, the PC answers: documents, the index
and the AI model stay on the PC. The phone reaches the PC over the home network only, encrypted, and only after the
user paired it in Settings > Phone on the PC.

## What the phone does

| Feature | How |
|---|---|
| Pair with PCs | Settings > Phone on the PC shows a QR code; the app scans it once. Several PCs (home, office) can be paired; the drawer switches between them. |
| Home | A greeting, the next deadlines, new documents and example questions; a question asked here starts a chat in the chosen workspace. |
| Drawer | Home, workspaces, deadlines, This PC, settings, and the latest chats of all workspaces. |
| Ask about documents | Workspaces, chats, answers that stream in, formatted (headings, lists, bold, code), with the documents used as chips, the warning for quotations that are not in the documents, and Copy. Choice of the AI model (the PC's local chat models; Ollama's cloud models are not offered) and of the knowledge base. An answer goes on when the chat or the app is left (a short foreground service while it comes in). |
| Add | Camera (photo of a letter), photos, files (PDF, EPUB, Word, PowerPoint, text, images) into a workspace; the PC reads them, also the text in photos. "Share" from other apps does the same (only `content://` files of other apps); shared text goes into the question field. Photos are deleted on the phone after sending. |
| Dictation | Hold the microphone button; the recording is turned into text by the speech model on the PC (not an online service) and lands in the question field. |
| Deadlines | Overdue, today, this week, later, done; "Done" marks it on the PC. Reminders (off by default) check the PC every few hours while the phone is at home; no cloud push. A home-screen widget shows the next three. |
| This PC | Connection, StarkLLM version, AI model, automatic backup, protection at rest, what this phone may do; at "manage": back up now and switch fully offline, each confirmed with the fingerprint (or face, or the phone's PIN) on the phone. The PC trusts the phone's token for these actions; the fingerprint protects against someone else picking up the unlocked phone, not against a copied token. |
| Settings | App lock (fingerprint when the app opens; while it is on, no screenshots or recent-apps preview, and the widget shows only how many deadlines are open), reminders (private on the lock screen), shortcuts (Quick Settings tile "Ask StarkLLM", widget, share). |
| Languages | The languages of the desktop app: English, German, Spanish, French, Italian, Turkish. Larger system text is followed by half. |

The phone keeps only what it shows (chat list, the open chat, the next deadlines for the widget) and settings. No
analytics, no crash reporting service, no Firebase, no Google Play services: the app can also be offered outside
Google Play.

Permissions: internet (the home network), camera (QR code and photos, only after a tap), microphone (only while the
button is held), notifications (reminders, and while an answer comes in), biometrics (app lock, actions on the PC).

## The phone link on the PC (`desktop/phonelink.js`)

The engine keeps listening on `127.0.0.1` only (`docker-compose.yml`, the engine without Docker). The phone link is a
small HTTPS server in the desktop app (Electron main process) in front of it:

1. **Off by default.** Settings > Phone > "Turn on" starts it; "Turn off" closes the port. While the app is fully
   offline it is closed too, and it opens again when the user goes back online.
2. **Its own certificate.** At the first start the app creates an EC P-256 key and a self-signed certificate
   (`desktop/selfcert.js`, Node's crypto, no package) in the profile folder (`phone/`).
3. **Pairing by QR code.** "Show QR code" makes a one-time code (128 bits, valid 5 minutes, works once; closed after
   10 wrong codes). The QR code holds
   `starkllm://pair?v=1&n=<PC name>&a=<addresses>&p=<port>&f=<SHA-256 of the certificate, base64url>&c=<code>`.
4. **Certificate pinning.** The app connects to one of the addresses and accepts the TLS connection only if the
   server's certificate has the fingerprint `f`. No certificate authority is trusted, so nobody else in the Wi-Fi can
   pose as the PC. A device with another certificate at one address is skipped (nothing is sent to it) and the next
   address is tried; when none has the pinned certificate the app says that another device answered and keeps the
   pairing. Only the PC's own `not-paired` answer over the pinned connection removes the pairing on the phone.
5. **Device token.** `POST /phone/v1/pair {code, name}` returns a random 256-bit token. The app keeps it in the
   Android Keystore; the PC keeps only its SHA-256 hash (`phone/phone-link.json`). Every later request carries it in
   `X-StarkLLM-Device`. Settings > Phone lists the paired phones (at most 10) with "Remove", which takes effect at once.
6. **Allow-list and levels.** A paired phone reaches only these engine calls (`ALLOWED` in `phonelink.js`), each at a
   level; everything else gets 404, also with `..` or encoded slashes in the path. Settings > Phone sets the level of
   each phone ("This phone may:"); a new pairing gets "work"; a call above the phone's level gets 403.

   | Level | Method | Path (`/api/v1/...`) |
   |---|---|---|
   | ask | GET | `auth/me`, `workspaces/`, `chat/sessions/{ws}`, `chat/session/{id}`, `chat/messages/{id}`, `chat/models`, `documents/{ws}`, `documents/{ws}/documents/{id}/status`, `dashboard/home`, `dashboard/inbox`, `dashboard/inbox/count`, `dashboard/deadlines`, `dashboard/system-status` |
   | ask | POST | `auth/login`, `chat/`, `chat/sessions/{ws}`, `voice/transcribe` (dictation with the PC's speech model) |
   | work | POST, PUT, DELETE | `documents/{ws}/upload`, `dashboard/deadlines/done`, `chat/session/{id}`, `chat/save-partial` |
   | manage | POST | `/phone/v1/actions/backup-now`, `/phone/v1/actions/go-offline`: actions of the desktop app, not of the engine; the phone app asks for the fingerprint first (checked on the phone, not on the PC) |

   `GET /phone/v1/status` tells every paired phone its level and what the desktop app knows about the PC (backup,
   protection; no paths, keys or file names). Not reachable from the phone: engine settings, model downloads,
   backup files, protection keys, knowledge base, tools (MCP), the OpenAI compatible API, imports from the web, and
   everything of the system. A phone question stays on the PC: a chat request loses `provider`, `api_key`,
   `base_url` and `use_web_search`, a request for one of Ollama's cloud models is refused, and `chat/models` lists no
   cloud models.
   Limits: request bodies up to 1 MB (documents 110 MB, dictation 25 MB); 20 wrong pairing codes or 5 wrong passwords
   block the address for 10 minutes; wrong codes do not close the pairing of the person at the PC. A device without a
   pairing that tries the port is listed as refused in Settings > Privacy & network (once per 10 minutes).
7. **Who is signed in.** With one user on the PC (the usual case) the phone link adds the local user's session, so the
   phone needs no password. With several accounts, a phone belongs to the account that was signed in in StarkLLM's
   window when its QR code was shown (Settings > Phone lists it as "account <name>"). The desktop app then gets a
   session for that phone from the engine (`POST /auth/phone-session`: only with the desktop key and the account's own
   session; one year; a new password of the account ends it) and keeps it in `phone-link.json`, encrypted by Windows
   (safeStorage, DPAPI). So the phone stays paired after restarts and when the window stays closed. Signing out of that
   account in the window removes its phones. Without Windows encryption, and for phones paired before, the phone link
   uses that account's session of the window: the window hands it over when the account signs in, the desktop app checks it with
   the engine (`auth/me`) and keeps it in memory only, never on disk. It never uses another account's session. When the
   PC has no session for the phone's account (signed out for more than 7 days, or a phone paired before 2.5.0 on a PC
   with several accounts), the PC answers `signed_in: false` and the app asks to sign in on the PC, or to pair again
   while the own account is signed in (`Problem.NOT_SIGNED_IN`, text `several_accounts`). The app has no login screen.
8. **Only the home network.** Connections from addresses that are not private (RFC 1918, link-local, this PC) are
   closed before TLS. Each connection of a phone is recorded in Settings > Privacy & network as "Paired phone
   (incoming)" (feature `phone_link`, method `IN`); see [privacy-network.md](privacy-network.md), D11.
9. **Windows Firewall.** Windows may ask once whether StarkLLM may be reached on networks. StarkLLM never changes the
   firewall itself; the settings page tells the user to allow private networks only.

Away from home: since 2.6.0, per phone and only when switched on, through the StarkLLM relay (end-to-end encrypted); see [phone-away.md](phone-away.md).

## The Android app (`mobile/android`)

- Kotlin, Jetpack Compose, Material 3; minimum Android 10 (API 29).
- OkHttp with a trust manager that checks the pinned fingerprint, kotlinx.serialization, CameraX and ZXing core for
  the QR code. Nothing from Google Play services.
- Built with Gradle in CI (debug APK for every pull request, a signed bundle for releases). Play App Signing; the
  upload key belongs to the project owner and never leaves the owner's PC.
- Google Play "Data safety": no data collected, none shared.
- Play path for a personal developer account: internal test, then a closed test with at least 12 testers for 14 days,
  then production.
