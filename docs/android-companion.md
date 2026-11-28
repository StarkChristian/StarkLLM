# StarkLLM for Android (companion app)

StarkLLM for Android is a companion of StarkLLM on a Windows PC. The phone asks, the PC answers: documents, the index
and the AI model stay on the PC. The phone reaches the PC over the home network only, encrypted, and only after the
user paired it in Settings > Phone on the PC.

## What the phone does

| Feature | How |
|---|---|
| Pair with PCs | Settings > Phone on the PC shows a QR code; the app scans it once. Several PCs (home, office) can be paired; the drawer switches between them. |
| Home | A greeting, a large "Photograph a letter" button (the camera app takes the photo into the chosen workspace), the next deadlines, new documents and example questions; a question asked here starts a chat in the chosen workspace. New documents show sender · kind · amount as the PC read them (`dashboard/home`: `sender`, `letter_kind`, `asked_amount`, else the amount of the letter's deadline); the file name only when the PC found neither sender nor kind. |
| Waiting questions | A question asked while the PC cannot be reached (`UNREACHABLE`, `UNREACHABLE_AWAY`, fully offline) waits on the phone, encrypted with its own Android Keystore key (`QuestionQueue`, `KeystoreBox`, at most 20). Home lists them ("Waiting for the PC", Cancel); a chat shows its own. While the app is open it asks the paired PC every 30 seconds (only the hello), then sends them one after the other to the same PC and workspace; answered ones can be opened from home. A question the PC refuses is marked and not tried again. Nothing is sent while the app is closed, and nothing goes anywhere but the paired PC. |
| Drawer | Home, workspaces, deadlines, This PC, settings, and the latest chats of all workspaces. |
| Ask about documents | Workspaces, chats, answers that stream in, formatted (headings, lists, bold, code), with the documents used as chips, the warning for quotations that are not in the documents, and Copy. Choice of the AI model (the PC's local chat models; Ollama's cloud models are not offered) and of the knowledge base. An answer goes on when the chat or the app is left (a short foreground service while it comes in). |
| Add | Camera (photo of a letter), photos, files (PDF, EPUB, Word, PowerPoint, text, images) into a workspace; the PC reads them, also the text in photos. "Share" from other apps does the same (only `content://` files of other apps); shared text goes into the question field. Photos are deleted on the phone after sending. |
| Dictation | Hold the microphone button; the recording is turned into text by the speech model on the PC (not an online service) and lands in the question field. |
| Deadlines | Overdue, today, this week, later, done; "Done" marks it on the PC. Colours by urgency from the PC's state (overdue red, today and this week amber, later neutral); the phone never counts days itself. "Add to calendar" opens the phone's calendar app with an all-day event filled in (Android's insert intent; no calendar permission, the app reads no calendar); the user saves it there, and a synced calendar then has it in its account. Reminders (off by default) check the PC every few hours while the phone is at home; no cloud push. A home-screen widget shows the next three. |
| This PC | Connection, StarkLLM version, AI model, automatic backup, protection at rest, what this phone may do; at "manage": back up now and switch fully offline, each confirmed with the fingerprint (or face, or the phone's PIN) on the phone. The PC trusts the phone's token for these actions; the fingerprint protects against someone else picking up the unlocked phone, not against a copied token. |
| Settings | App lock (fingerprint when the app opens; while it is on, no screenshots or recent-apps preview, and the widget shows only how many deadlines are open), reminders (private on the lock screen), shortcuts (Quick Settings tile "Ask StarkLLM", widget, share). |
| Languages | The languages of the desktop app: English, German, Spanish, French, Italian, Turkish, with formal address. Larger system text is followed by 40 %; at Android's largest text and display size no button, heading or deadline is cut (tested). |
| Galaxy Z Flip | Flex mode (half folded): home and chats put the cards and answers above the fold, the question field, camera button and examples below it (Jetpack WindowManager, `ui/Posture.kt`). Cover screen (Flex Window): the app leaves out decoration in small windows (height under 520 dp); the widget "StarkLLM deadlines (cover screen)" can be added under Settings > Cover screen > Widgets (Samsung's `sub_screen` metadata, `res/xml/samsung_widget_cover.xml`). The cover screen is visible on the closed phone: with the app lock on, the widget shows only how many deadlines are open. Whether the app itself opens on the cover screen is up to Samsung's settings (Labs / Good Lock), not the app. |
| Accessibility | Every button has a label for TalkBack (tested on each main screen); switches are one row with title and state; section titles are headings; the theme tiles are one group of choices. |

The phone keeps only what it shows (chat list, the open chat, the next deadlines for the widget), the questions that wait
for the PC (encrypted) and settings. No
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
- Built with Gradle in CI (`.github/workflows/android.yml`): unit tests and the screens' tests, a debug APK and an
  unsigned release bundle (AAB) for every pull request. Play App Signing; the upload key belongs to the project owner
  and never leaves the owner's PC, so CI never signs a release (see "Release on Google Play").
- Version: `versionCode` and `versionName` in `mobile/android/app/build.gradle.kts`; each release raises `versionCode`
  by one (0.4.0 = 4). Debug builds are `com.starkllm.app.debug`, version `…-debug`.
- Tests (`app/src/test`, `./gradlew testDebugUnitTest`): JVM tests of the data layer, and the screens' tests with
  Robolectric and Compose (`screens/`): home, deadlines, chat, This PC, settings and workspaces with demo data, at the
  Galaxy Z Flip5's size and 130 % text, at the largest text and display size, half folded and on the cover screen.
  They check the TalkBack labels, cut texts and the layout, and write screenshots to `app/build/outputs/screens`
  (in CI: the `android-reports` artifact). The screens' test activity (`ScreensTestActivity`) is in debug builds only.
- Google Play "Data safety": no data collected, none shared.
- Play path for a personal developer account: internal test, then a closed test with at least 12 testers for 14 days,
  then production.

## Release on Google Play

Google Play signs the app for the phones (Play App Signing). The owner signs only the upload: an upload key that is
created and kept on the owner's PC and never given to CI, GitHub or anyone else. StarkLLM's repository contains no
release key and no password.

Once (on the owner's PC):

1. Create the upload key with the JDK's `keytool` and keep the file and its password safe (a backup on a stick in a
   drawer, not in the cloud):
   `keytool -genkeypair -v -keystore C:\Keys\starkllm-upload.jks -alias upload -keyalg RSA -keysize 4096 -validity 10000`
2. In the Play Console: create the app `com.starkllm.app`, choose Play App Signing ("Let Google manage and protect your
   app signing key"), and register the upload key's certificate when Play asks for it
   (`keytool -export -rfc -keystore C:\Keys\starkllm-upload.jks -alias upload -file upload_certificate.pem`).

Each release:

1. Raise `versionCode` (and `versionName`) in `mobile/android/app/build.gradle.kts` in a pull request; after it is
   merged, CI builds the bundle on `main`.
2. Sign the bundle on the owner's PC, one of two ways:
   - The bundle from CI: download the artifact `starkllm-android-release-aab` of the run on `main`, then
     `powershell -ExecutionPolicy Bypass -File mobile\android\play\sign-bundle.ps1 -Bundle .\app-release.aab -Keystore C:\Keys\starkllm-upload.jks`
     (jarsigner asks for the password; it writes `app-release-signed.aab` and checks it).
   - Or build it on the PC: set `STARKLLM_UPLOAD_STORE` (path of the keystore), `STARKLLM_UPLOAD_STORE_PASSWORD` and, if
     they differ from the defaults, `STARKLLM_UPLOAD_KEY_ALIAS` (default `upload`) and `STARKLLM_UPLOAD_KEY_PASSWORD`
     for the PowerShell session (`$env:STARKLLM_UPLOAD_STORE = "C:\Keys\starkllm-upload.jks"`, the password with
     `Read-Host`), then `cd mobile\android; .\gradlew bundleRelease`. Without these settings the bundle stays unsigned.
3. Play Console: Testing > Internal testing > Create release, upload the signed AAB, release notes in the six
   languages, roll out. Store texts and images are in `mobile/android/play/`.
4. For a personal developer account: a closed test with at least 12 testers for 14 days before production; then
   promote the tested release to production.

Data safety form: no data collected, none shared (the app talks only to the user's own PC and, when the user allows it,
through the end-to-end encrypted relay).
