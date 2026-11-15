# Ideas for the StarkLLM phone app

Status: **proposal for the owner**, written 2026-11-15 alongside the protocol core and relay
(`docs/remote-access-design.md`). Nothing here is built yet. The list is ordered by priority; each idea names its **privacy
impact** and the **allow-list entries** it needs, so that every addition to what a phone may do stays a deliberate decision.

## 1. What comparable apps do (short survey)

The survey is a quick desk review of public descriptions and help pages (see the sources at the end; most are third-party
guides, so details such as plan limits may be out of date). It is only used for inspiration; StarkLLM's rule is different:
the documents never leave the PC, so many cloud-style features are done differently or not at all.

| Product | Mobile features that matter for us |
|---|---|
| **ChatGPT** | voice conversation, camera and photo input, file upload from the share sheet, home and lock-screen widgets (start a chat or voice mode with one tap) |
| **Claude** | voice input and read-aloud, photos from camera or library and file upload, projects synced with the web, iOS App Intents: "Ask Claude" from Spotlight, Siri, the Share menu and Shortcuts, widgets |
| **Perplexity** | share-sheet extension ("ask about this page" from Safari, Mail, Notes), file uploads, voice assistant |
| **Gemini** | assistant with access to the user's mail, calendar and drive (cloud context), voice, camera |
| **Notion AI** | quick-add widget (capture), share sheet "save to Notion", images and PDFs shared into the AI for context |
| **Local-first document tools** (AnythingLLM Mobile, on-device "chat with your PDFs" apps) | answers with citations, everything on the device; typically small models, no sync with a big machine |

What StarkLLM can offer that none of them can: **the answer comes from the owner's own documents on their own PC, with
citations, and the phone only carries encrypted bytes.** The most valuable mobile features are therefore the ones that move
*documents and deadlines* between the phone and the PC, not a second chatbot.

## 2. Reading the tables

- **Privacy impact:** *none* = stays inside the phone and the encrypted channel; *low* = uses a phone OS feature that may touch
  the OS vendor in a minor way (explained); *medium* = involves Apple or Google servers or shows content outside the app;
  *high* = we recommend against it.
- **Allow-list:** the request types from section 6 of the design document the idea needs. "none new" means the idea works with
  what the first version already has; "new: ..." means a deliberate extension.
- **Phase:** *PWA* = possible in the first web app, *native* = needs the Expo app (camera, share sheet, notifications, widgets).

## 3. Prioritised list

### Priority 1 - the reasons to install the app

| # | Idea | Why | Privacy impact | Allow-list | Phase |
|---|---|---|---|---|---|
| 1 | **Deadlines and inbox on the phone, offline** - the latest summaries (inbox, deadlines, cases) are cached encrypted on the phone and refreshed when the PC is reachable; open them on the train without the PC | the core promise: "my paperwork overview in my pocket"; works even when the PC is off | none (cache encrypted with a key in Keychain / Keystore; optional Face ID lock) | none new: `inbox.list`, `deadlines.list`, `cases.list` | PWA (IndexedDB) and native |
| 2 | **Deadline reminders** - local notifications "Einspruchsfrist Finanzamt in 3 days", scheduled by the app from the cached deadlines; the user chooses lead times | the single most useful thing a paperwork assistant can do for a phone owner; no server involved | none: notifications are generated on the phone from local data; the text stays on the device (the lock-screen text is a setting, "hide details" by default) | none new: `deadlines.list` | native (PWA only while open) |
| 3 | **Share-sheet upload ("Send to StarkLLM")** - share a PDF, letter photo or mail attachment from any app; the PC asks the user to confirm and ingests it | how paperwork reaches the PC in practice: it arrives on the phone first (mail, messengers, scans) | low: the file goes encrypted to the PC; the share sheet is an OS feature, nothing leaves the device otherwise | none new: `documents.upload.*` (permission `upload`) | native |
| 4 | **Scan with the camera** - multi-page scan, edge detection, send as JPEG or a PDF built on the phone; OCR happens on the PC | the same flow as 3 for paper letters; replaces separate scanner apps | none: on-device capture (use the OS document scanner), images never leave except encrypted to the PC | none new: `documents.upload.*` (the app builds a PDF; images as `jpg`/`png`) | native |
| 5 | **Voice questions** - dictate a question, optionally hear the answer read aloud | hands-free use and accessibility; a standard feature in every comparable app | low if the OS speech recognition runs **on the device** (recommended, offered only where the OS supports it offline); medium if it falls back to the vendor's cloud speech service: off by default, with a clear note | none new: `chat.ask` (the question is plain text) | native (PWA: the browser's speech API often uses a cloud service, so not recommended) |

### Priority 2 - makes the app pleasant

| # | Idea | Why | Privacy impact | Allow-list | Phase |
|---|---|---|---|---|---|
| 6 | **Quick capture** - "note to inbox": type or dictate a short note, or take a photo, and send it to the PC to be filed | cheap capture while on the road (Notion's quick-add and ChatGPT's one-tap widgets show the demand) | none/low (as 3) | none new: a note is a small `.txt`/`.md` upload; the PC confirmation can be slightly lighter for notes only if the owner wants it (a design decision, see questions) | native |
| 7 | **Citations that open** - tap a citation to see the passage and page, jump between cited sources | trust: the answer is only useful if the source is one tap away | none | none new: `source.open` (optionally later `source.page_image`, new, to show the page as an image) | PWA and native |
| 8 | **Chats and workspaces browser** - continue a conversation started on the PC, switch the workspace for questions and search | continuity between PC and phone | none | none new: `workspaces.list`, `chats.list`; reading old messages needs **new: `chats.messages`** (deliberately left out of version 1) | PWA and native |
| 9 | **Knowledge-base search as its own screen** - search first, ask second; results with snippets and sources | fast "where is that letter?" without waiting for a model answer | none | none new: `kb.search`, `source.open` | PWA and native |
| 10 | **Connection and trust indicator** - "connected to *Christian-PC*, end-to-end encrypted", PC online or offline, a short fingerprint of the PC key to compare, list and remove this phone's pairing | makes the privacy promise visible; helps debugging | none | none new: `device.info` | PWA and native |
| 11 | **App lock and privacy screen** - Face ID / fingerprint on open, blur in the app switcher, no content in notifications by default | protects a lost, unlocked phone | none | none | native |
| 12 | **German and English UI**, dynamic type, VoiceOver / TalkBack, dark mode | audience and accessibility (English first, German second) | none | none | PWA and native |

### Priority 3 - useful, but needs a decision or more design

| # | Idea | Why | Privacy impact | Allow-list | Phase |
|---|---|---|---|---|---|
| 13 | **Home-screen widget** (next deadline, "ask" button) | Claude, ChatGPT and Notion all use widgets; quick glance at deadlines | medium for a widget that shows deadline text on a lock screen (visible to bystanders); low for "tap to open the app" and a home-screen widget with a "hide details" mode | none new (reads the local cache) | native |
| 14 | **Siri, Spotlight and Shortcuts: "Ask StarkLLM"** (iOS App Intents) and an Android assistant entry | system-wide shortcut, as Claude offers | medium: the spoken or typed text passes through the OS; Siri may process speech on Apple servers unless on-device. Offer it, explain it, default off | none new: `chat.ask` | native |
| 15 | **Mark a deadline done / snooze it** | closes the loop of reminders | none | **new: `deadlines.update`** with a new permission (it changes data on the PC); needs its own design | native |
| 16 | **Push notification "answer ready" / "new deadline found"** without content | useful when a long answer is running or the PC found a new deadline | medium: goes through Apple and Google push services (metadata: the app was notified at time T); the payload carries no content | none new, plus **new PC-side event channel** (the PC cannot push through the relay to a sleeping phone without a push token held by the relay: needs a design review) | native |
| 17 | **Document list** ("what is in my knowledge base?") | orientation | none | **new: `documents.list`** (was in the first proposal, dropped in the current list) | PWA and native |
| 18 | **Ask about a photo** - take a photo of a letter and ask a question about it without adding it to the knowledge base | quick answers for one-off letters | none/low (the image is processed on the PC and discarded after the answer) | **new: `chat.ask` with an attachment** or a temporary upload that is deleted after use; needs a design with the same quarantine rules | native |
| 19 | **Offline question queue** - write a question without a connection; it is sent when the PC is reachable | convenience on trains | none (queue encrypted on the phone) | none new | native |
| 20 | **Several PCs** (home and office) behind one app | power users | none | none new, but a larger product change (currently a non-goal) | later |

### Not recommended (high privacy impact or against the product promise)

- **Cloud speech-to-text or text-to-speech by default.** Voice would leave the phone in clear form to a third party. Only on-device
  recognition by default.
- **Live camera or screen-sharing "vision mode"** streamed to a cloud model, as other apps do. StarkLLM's model runs on the PC;
  a live stream over the relay is also expensive in bandwidth. Single photos (4, 18) cover the need.
- **Push notifications that carry text** ("Finanzamt: deadline 1 December"). Apple and Google would see it.
- **Syncing the cache through iCloud or Google backup.** Exclude the app's data from OS backups, or the encrypted cache ends up on
  third-party servers with a key that may be backed up too.
- **Analytics and crash reporting with content.** If crash reports are ever added: opt-in, no file names, no questions.

## 4. Suggested order

1. **PWA (step 5 of the plan):** 1 (offline summaries), 7, 9, 10, 12: everything that needs only the first allow-list.
2. **First native release (step 6):** 2 (reminders), 3 (share sheet), 4 (scan), 5 (voice on-device), 11 (app lock), plus the PWA features.
3. **Then:** 6 (quick capture), 8, 13, 14.
4. **Only after a design review:** 15, 16, 17, 18.

## 5. Allow-list impact at a glance

| Allow-list entry | Used by ideas |
|---|---|
| `inbox.list`, `deadlines.list`, `cases.list` | 1, 2, 13, 19 |
| `kb.search`, `source.open` | 7, 9 |
| `chat.ask` | 5, 14, 19 |
| `workspaces.list`, `chats.list` | 8 |
| `documents.upload.*` (permission `upload`) | 3, 4, 6 |
| `device.info` | 10 |
| **new, needs a decision:** `chats.messages`, `documents.list`, `deadlines.update`, `source.page_image`, `chat.ask` with attachment, a push channel | 8, 17, 15, 7, 18, 16 |

Every "new" entry follows the same rule as the existing ones: one entry in the allow-list table, one engine adapter method, a
permission, tests that include the refusals, and an update of the threat model.

## 6. Questions for the owner

1. Should *quick capture* of short notes (idea 6) skip the per-file confirmation on the PC (faster, slightly weaker), or keep
   one confirmation for everything that is added? (Recommended: keep it for everything in version 1.)
2. Is a push channel for "answer ready" (16) wanted at all, given that Apple and Google would see the metadata?
3. Do you want `chats.messages` (read the full text of old chats on the phone) in the first native release, or only the list?

## Sources (third-party summaries, last checked 2026-11-15)

- ChatGPT mobile app overviews: [ai-toolbox.co](https://www.ai-toolbox.co/chatgpt-management-and-productivity/chatgpt-mobile-app-guide-2026), [Tom's Guide](https://www.tomsguide.com/ai/4-hidden-chatgpt-mobile-tricks-that-make-it-way-more-useful)
- Claude on iOS (App Intents, Shortcuts, widgets): [Claude support article](https://support.claude.com/en/articles/10263469-using-claude-app-intents-shortcuts-and-widgets-on-ios); mobile guide: [beginnersinai.org](https://beginnersinai.org/claude-app-guide/)
- Notion's mobile AI app: [Notion help](https://www.notion.com/help/notion-ai-app-for-ios); comparison with Perplexity and Gemini: [G2](https://www.g2.com/compare/notion-vs-perplexity-vs-google-gemini)
- Local-first document Q&A apps: [AnythingLLM Mobile](https://docs.anythingllm.com/mobile/overview), [Privacy Guides forum thread on an on-device document search app](https://discuss.privacyguides.net/t/local-ai-for-document-search-informity-ai-runs-entirely-on-device/37769)

The Gemini, Perplexity and local-first entries rest on thin or secondary sources; verify before basing a decision on a
competitor detail.
