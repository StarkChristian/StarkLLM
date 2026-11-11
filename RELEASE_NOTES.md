# StarkLLM Release Notes

## Version 2.0.14 — Your letters at a glance: deadlines, photos of letters, sources you can check

- **Document home.** The start page shows your newest documents and the deadlines, appointments and payments found in them, with amount and the page they come from. "Add to calendar" saves them as a calendar file.
- **Photos and scans of letters are read on this PC.** A photo or a scanned page is read as German or English text (OCR), turned upright if needed, and can be searched and cited like any other document. No extra model download.
- **Sources you can check.** Click a source under an answer to see the passages it was based on, word for word, and open the document at that page.
- **Warnings for fake letters.** If a letter asks for payment to a foreign account, by voucher or through a link, contains text addressed to AI assistants, or a sender suddenly names a different account, a red box above the answer says so. Answers also know today's date, use the corrected letter instead of the old one, and answer in your language.
- **A plain first start.** StarkLLM creates "My documents" and opens the chat with suggestions for letters. No account screen, no technical terms.
- **Documents window:** upload several files at once, see when a file is ready, open it. Escape closes the top window. The dashboard clock has one colour.
- **Use StarkLLM from other programs (off by default).** Settings → Other apps turns on an MCP server and the OpenAI-compatible API, both only on this PC and only with a key. **If you used the `/v1` API before:** it now needs a key from that page.
- **Safer app window.** Links open in your browser, never inside StarkLLM; the window grants only the microphone; the engine answers only requests addressed to this PC. The knowledge base says when your Documents folder is synced to OneDrive, Dropbox, Google Drive or iCloud.
- **Installing Ollama for you** checks its signature without a command that security programs flag.
- **The engine download is larger** (text recognition for German and English is included).

**From 2.0.7 or later:** Settings → About → "Check for updates" → "Download and install".

Pull requests: #57, #60, #62, #63, #64, #65, #66, #67, #72, #75, #77, #87.

---

## Version 2.0.13 — Safer answers, AI labels, update progress

- **Answers cannot load images from other servers.** A hidden line in a document could make the AI write an image link that sends data to a stranger's server as soon as the answer is shown. Images in answers now load only from StarkLLM itself; any other image appears as a short note. The app page also has a strict Content Security Policy.
- **AI-made content is labelled.** Every spoken answer carries a machine-readable "AI-generated" mark inside the audio file, Studio says above every result that it was made by AI on this PC, and saved Studio files say so too (EU AI Act, Art. 50).
- **Warning for an old Ollama.** If the Ollama on your PC is older than 0.17.1, StarkLLM asks you to update it (security flaw "Bleeding Llama", CVE-2026-7482).
- **Updates show their progress.** Settings → About shows "Update wird geladen: N %" instead of "Checking..." for the whole download.
- **Studio headings in German** when the interface is German.
- **Fixed:** the buttons on code blocks showed `{t('Copy')}` instead of "Copy".
- **No more Portable version.** It unpacked itself to a temporary folder, which Windows Smart App Control and antivirus programs treat with suspicion, and it could not update itself. Please use the installer; your data stays in the same place.

**From 2.0.7 or later:** Settings → About → "Check for updates" → "Download and install".

Pull requests: #81, #82, #83, #84, #85.

---

## Version 2.0.12 — Studio reads your documents, the right model in Settings, light themes light everywhere

- **Studio works with images and Word or Excel files.** The briefing, podcast, quiz and comparison read every file as plain text, so images and Office files reached the AI as unreadable bytes, and the briefing could say the data was corrupt. Studio now uses the text StarkLLM read when the file was added (including the text of images and scans), gives every document a fair share, writes in the language of the interface and does not invent dates.
- **Settings → Model shows the model the chat uses.** It showed the first installed model, which could be an image model such as llava; saving the page would have switched the chat to it.
- **Knowledge Base:** a closed folder no longer says "No documents yet" when it has documents.
- **Light themes are light everywhere:** the message box, Settings, the documents window and its search box (typed text was white), buttons and cards follow the theme.
- **Windows no longer show the chat through them:** the documents, memory and template windows are solid.
- **More of the interface in German:** the About page, Studio, Knowledge Base and dates such as "Heute" and "vor 2 Tagen".

**From 2.0.7 or later:** Settings → About → "Check for updates" → "Download and install".

Pull request: #79.

---

## Version 2.0.11 — No more crashes in toasts and themes, long letters read in full, five new themes

- **Fixed crashes.** In 2.0.10 some messages (toasts), the prompt templates and the theme list in Settings could stop the window with an error. Fixed, and a check now stops this kind of mistake before a release.
- **Long letters are read in full.** Questions about long documents were cut off before they reached the AI model, without any message, so answers could miss what was at the end. StarkLLM now asks Ollama for a context window that holds the whole question.
- **A clear message when Ollama is not running.** A document no longer stays at "embedding" for hours; it fails at once and says that Ollama cannot be reached.
- **Search works offline.** The model that sorts search results is now part of the engine and is no longer downloaded from the internet on first use.
- **The right "today".** The engine uses the time zone of your PC, so dates near midnight are correct.
- **Five new themes with patterns:** Doodle Chat, Doodle Night, Flower Meadow, Matrix Code and Starry Night (Settings → Appearance). Light themes are now light everywhere, including the sidebar and cards.
- **A list of all components (SBOM)** is attached to every release from now on.

**From 2.0.7 or later:** Settings → About → "Check for updates" → "Download and install".

Pull requests: #71, #73, #74, #76.

---

## Version 2.0.10 — The installer no longer stops at the start, German interface

- **The installer no longer stops at the start.** About one first installation in five ended after two seconds without a message and without installing anything: the installer crashed (exit code -1073741819) while reading the per-user Programs folder. The fix comes with electron-builder 26.18.1; 20 first installations on fresh Windows machines ran without a fault (before: 2 crashes in 10).
- **StarkLLM speaks German.** The whole interface is available in German: Settings → Language. Without a choice, StarkLLM follows the language of Windows. Answers of the AI follow the language of your question.

Pull requests: #55, #68.

---

## Version 2.0.9 — Updates that do not stop, honest prices, safer engine updates

- **Updates no longer stop at "The old application files could not be uninstalled".** On Windows 11 with Smart App Control, the update from 2.0.7 to 2.0.8 stopped there and StarkLLM stayed on the old version. The installer now closes StarkLLM itself and installs over the old files when the old version's uninstaller fails. Your chats and documents are not touched.
- **Back to the previous engine if a new one does not start.** Before an engine update StarkLLM keeps the running engine. If the new engine does not start or does not answer within three minutes, StarkLLM starts the previous one again and says so. It tries the new engine again a day later, or at once with Retry.
- **Market prices are real or not shown.** Before the first update, and whenever CoinGecko or Yahoo Finance did not answer, the dashboard showed built-in example prices from 2024 with small random changes. It now shows only real prices: the last loaded price with its time, or "not available".
- **One date and number format.** Dates and numbers followed the Windows language and mixed with the English interface ("Montag, 9. November 2026", "$74.114"); they now match the interface.
- **Dashboard:** the header is no longer cut off, the three widgets have the same height, and the system status shows the full model name.
- **winget:** `packaging/winget` holds the manifest for `winget install StarkChristian.StarkLLM` (not yet published in the winget catalogue).

Pull requests: #47, #48, #49, #50.

---

## Version 2.0.8 — Install Ollama from inside the app, real download progress

- **Ollama is installed for you.** If Ollama is missing, the start window offers "Install Ollama for me". StarkLLM downloads the official installer from ollama.com, runs it only if Windows confirms a valid signature by Ollama Inc., and installs it for the current user without further questions. Then it starts as usual.
- **Real download progress.** While the engine and the AI models are downloaded, the start window shows a real progress bar with percent and size (for example "37 % (712 MB of 1.1 GB)") instead of a number that jumped around. The taskbar button shows the same progress.
- **Update from 2.0.6 or 2.0.7:** Settings → About → "Check for updates" → "Download and install".

Pull requests: #43, #44, #45.

---

## Version 2.0.7 — Faster first start, no sign-up

- **The engine is downloaded instead of built.** For each release, GitHub builds the engine images; StarkLLM downloads the ones of its version instead of building them on your PC (which took 10-20 minutes on the first start and after each update). If the download is not possible, it builds them as before.
- **No sign-up on your own PC.** A new installation opens directly in the app. StarkLLM signs you in as the local user of this PC; you can set a password later in Settings → Account. If accounts already exist, the login stays as before; after a logout, "Continue on this PC" signs the local user in again.
- **First update from inside the app.** Users of 2.0.6 get this version with "Download and install", without the website.

Pull requests: #39, #40, #41.

---

## Version 2.0.6 — Updates from inside the app, and the models you already have

- **Updates from inside the app.** When a new version is published, StarkLLM offers "Download and install". It downloads only the changed parts of the installer in the background (progress on the taskbar button), backs up the database, and installs on restart or when you quit. "Check for updates" is now also in Settings → About. As before, nothing is checked before you agree once, and nothing is downloaded without your click. The portable version still opens the download page. The first update from inside the app is possible from 2.0.6 to the next version.
- **The models you already have are used.** On the first start StarkLLM looks at the models installed in Ollama and at your RAM and graphics memory, and uses the best ones that fit instead of downloading its defaults. Only what is missing is downloaded. Ollama cloud models are never chosen. If documents were indexed before, their search model stays.
- **New start screen** with the StarkLLM logo in its real proportions.
- **Times are shown in your local time.** Upload times, chat times and "Last synced" were one hour early in Germany.
- **Sources list only the files an answer cites.** Before, every retrieved passage was listed, even when the answer did not use it.

Pull requests: #34, #35, #36, #37.

---

## Version 2.0.5 — The engine starts with current Docker Desktop on Windows

Found in the first full test on a real Windows PC:

- **The first start no longer stops at "failed to execute bake".** With current Docker Desktop, the engine build stopped after a few seconds when the app started it (the same build worked in PowerShell). The app now starts Docker the way a console does and, if Docker's "Bake" step still fails, builds the two engine images one by one without it.
- **Images can be added to a workspace.** The app installed only the chat and search models, so every PNG or JPG failed with "model 'llava' not found". The image model is now downloaded the first time an image (or a scanned PDF page) needs it; if that download fails, the document says which command to run.
- **Re-index works for a document that failed.** The file of a failed document was deleted, so Re-index always said the file was missing. The file now stays until you delete the entry, and a failed re-index says why.

- **Installing a new version also updates the engine.** Until now the engine of the previous version kept running after an update, so fixes in the engine and the web UI did not arrive. The app now notices when its engine files changed and rebuilds the engine (a few minutes, once).

- **Settings → About shows the installed version** instead of "v1.0.0-beta".

- **Interface languages:** English, with German next.

Pull requests: #27, #28, #29, #30, #32.

---

## Version 2.0.4 — You see what goes online; updates reach you

- **The chat shows when a question leaves your PC.** With a cloud model provider selected in Settings (DeepSeek, OpenRouter, Groq or any non-local address) the input bar says "Cloud: <host> receives your question and document passages", and each such answer says "Answered by <host> (cloud)", also after reopening the chat. With web search on, the chat says the question goes to DuckDuckGo. LM Studio and other servers on your PC or local network count as local.
- **New versions reach you.** On the first start StarkLLM asks once whether it may check for new versions. If you agree, it asks GitHub for the newest version number on each start (nothing else is sent) and offers the download page. Nothing is installed automatically. The tray menu has "Check for Updates..." and an on/off switch.
- **Model downloads are retried.** An interrupted download is tried again after 5 and 15 seconds. A dropped connection to Ollama during a download no longer leaves the start screen waiting forever.
- **Docker in Windows-containers mode** is now explained on the start page, with how to switch to Linux containers, instead of a raw build log.
- **All supported files can be added from the chat:** the paperclip now offers Word, Excel, CSV, Markdown, JSON, XML, HTML and log files (it offered only PDF, text and images) and takes several files at once. Files can also be dropped on the window.
- File names in answers (such as "card.md") are no longer turned into web links; a question naming an uploaded file finds that file more reliably.
- The splash screen says "Private, local-first AI" instead of "100% Private".
- First runs on real Windows: the installer, the start and the start page are now built, installed and started on a GitHub Windows machine for every change.

Pull requests: #20, #21, #22, #23, #24, #26.

---

## Version 2.0.3 — Answers from thinking models, CSV files, sources

Fixes for problems reported from a real PC:

- **Thinking models (qwen3, deepseek-r1 and similar) answer again.** They spent the whole token limit on hidden thinking and returned an empty answer, so the chat kept showing the "thinking" dots. StarkLLM now asks Ollama to answer without the thinking step (`OLLAMA_THINK=true` turns it back on). An empty answer is now a clear error and is never saved.
- **CSV and text files from Excel/Windows** (UTF-8 with BOM) are read correctly; the first column name no longer starts with an invisible character.
- **Dashboard:** "Indexed Documents" counts workspace files and Knowledge Base files and shows the split.
- **Sources:** the source chips show the uploaded file name (`Project card.md`, not `529bb309_Project card.md`) and are still there when a chat is reopened. Existing databases get the new column automatically.

Pull requests: #16, #17, #18.

---

## Version 2.0.2 — First start fixes

Found by starting the app on a fresh profile in every situation (no Docker, Docker stopped, no Ollama, missing models, a failing model download, a busy port):

- **Chat works right after installation.** The interface sent the model `llama3.2:3b` with every chat until a model was picked by hand, so on a new PC every chat failed with "Model 'llama3.2:3b' not found". It now uses the default model (the one the app downloads). AI Studio no longer falls back to a fixed model either.
- **Clearer start page when a model is missing:** it names the missing model and the reason instead of "running without its AI runtime".
- Error messages in the chat no longer show a tokens-per-second badge.
- `engine.log` records why Docker could not be used.

---

## Version 2.0.1 — The desktop app starts its own engine; reliability, privacy and security fixes

- **The installer and the portable exe now work on a new PC.** v2.0.0 only opened a window on `localhost:5173` and contained no engine, so it always ended on an error page unless the engine had been started from a source checkout. The app now ships the engine and on every start: finds Docker (also right after Docker Desktop was installed), starts Docker Desktop if needed, starts Ollama if installed, downloads missing AI models with progress on the splash screen, builds and starts the engine (`docker compose up --build`; the first start takes 10-20 minutes and needs internet), and opens StarkLLM. Data lives in `%APPDATA%\StarkLLM`, the Knowledge Base folder is `Documents\StarkLLM Knowledge Base`, and every installation gets its own secret key. When something is missing the window says what and how to fix it, with the engine log.
- **Code runner:** numpy and pandas work under the memory limit.
- **Clear messages:** a document that cannot be embedded because Ollama is missing says what to do instead of showing a connection error.

Found by running a pre-registered scenario suite (S01-S13) against v2.0.0: 52 of 213 checks failed; after these fixes 10 remain, each analysed (watcher architecture, a missing export feature, test assumptions, or deliberate behaviour).

- **Security:** registration is validated (username/password rules, case-insensitive unique names); backup and restore are administrator-only, restore rejects unsafe or broken archives before touching anything; model and voice routes need a login; memory deletion is scoped to its workspace.
- **Privacy:** live market prices are off until you turn them on; the Google Fonts import is gone; the price proxy needs login and consent.
- **Code runner:** the chat's Python runner checks the code first and runs it in a clean environment with memory, time and output limits (a convenience limit, not a security boundary).
- **Errors you can act on:** Ollama out-of-memory, timeout and "not reachable" now say what to do; errors are never saved as the assistant's answer; `/health` shows the real version.
- **Data hygiene:** deleting a workspace removes its files, vectors, chats and memories; `%` and `_` in search are literal; invalid prompt templates and truncate values are rejected; dashboard counts only indexed documents; model status no longer matches by prefix; Python requirements are pinned.
- **Knowledge Base:** folders must be inside the KB directory; selecting folders for a workspace works; csv, json, xlsx, xml, log and markdown files are indexed; sync reports failed documents honestly.

Pull requests: #4, #5, #6, #7, #8, #9.

---

**Current Version:** StarkLLM Desktop v2.0.0  
**Release Date:** 2026-10-18  
**Status:** Official Windows Desktop Release (v2.0.0)

---

## Version 2.0.0 — Standalone Native Desktop Application *(v2.0.0)*

StarkLLM transitions from a browser-hosted interface to a **dedicated native desktop application** (Electron Desktop Shell), identical in behavior and experience to modern desktop AI applications like Cursor and Claude Desktop.

### Major Additions & Enhancements:

1. **Standalone Native Desktop App Window**:
   - Packaged as a true Windows application (`StarkLLM.exe`).
   - Opens in its own frameless/native styled window (1440x920) with midnight indigo theme framing.
   - Includes custom launch splash screen (`splash.html`), system tray icon with quick actions, and single-instance process lock.
   - Distributed as both an installer (`StarkLLM-v2.0.0-Setup.exe`) and portable executable (`StarkLLM-v2.0.0-Portable.exe`).

2. **Chat Folders & Sidebar Organization**:
   - Custom folders allow categorizing research, client projects, and coding sessions.
   - Folders support collapse/expand, renaming, drag/assignment, and real-time session filtering.

3. **Universal 4-Format Conversation Export**:
   - One-click export into Markdown (`.md`), clean JSON (`.json`), standalone HTML (`.html`), and Plain Text (`.txt`).
   - Timestamps, citation locators, word counts, and speed stats are fully preserved in exported documents.

4. **8 Curated Visual Themes**:
   - 8 bespoke palettes with frosted glassmorphism: Midnight Indigo (default), OLED Pitch Black, Liquid Glass, Cyberpunk Rose, Matrix Emerald, Sunset Amber, Arctic Frost, and Daylight Minimal.
   - Instant quick-switch popover in sidebar footer.

5. **Interface Languages**:
   - Localization engine: English is the active default; German is next.

6. **Hardware Telemetry & Live VRAM Dashboard**:
   - Real-time GPU video memory tracking, container status monitor, indexed chunk counters, and recent chats quick jump list.

---

## Phase 2 — Local Tools (Local MCP Host) *(branch: phase-2-mcp-host)*

StarkLLM provides in-process local read-only tool calling for the running FastAPI backend and React frontend. (Note: this is an in-process local host, not a third-party JSON-RPC network client; no third-party MCP servers are supported).

### A. Scope & Built-in Read-Only Tools

1. **`list_workspace_files`**:
   - Inspects and lists document metadata (filename, size, type, chunk count, timestamp) in the active workspace only (tenant-isolated).
   - Read-only; no modifications.

2. **`search_local_kb`**:
   - Performs hybrid vector & BM25 retrieval over the user's personal Knowledge Base index.
   - Returns passage snippets with canonical, honest citations and locators (`Page N`, `Section: ... Chunk N`, `Chunk N`).

3. **`fetch_cited_chunk`**:
   - Fetches the exact text passage for a specific document citation locator from Chroma vector collections.
   - Strict vector boundary; rejects raw filesystem traversal.

### B. Security, Execution Gate & User Confirmation

- **Server-Side Execution Gate**: `POST /api/v1/mcp/execute` requires a valid single-use `call_id` registered server-side from parsed assistant output. Direct invocation without an authorized pending ID is rejected with HTTP 403 Forbidden.
- **Explicit UI Confirmation**: Every tool call requires manual user confirmation in the UI before execution.
- **Visible & Editable Arguments**: Users can review and edit arguments directly in the confirmation card before running.
- **Non-Destructive Cancellation**: Rejecting or cancelling a tool call drops the pending call ID and leaves the chat session intact.
- **Stream Resilience**: Malformed or broken JSON tool calls emitted by the model render an Error Chip (`⚠️ Malformed Tool Call JSON`) without killing the chat stream or crashing the UI.
- **Local Persistence Only**: Tool toggles, host enablement, and local server configs persist exclusively in `data/mcp_config.json`. No cloud or external registry is contacted.
- **RAG Prompt Injection Defence**: Fenced ` ```tool_call ``` ` blocks found inside retrieved document chunks are stripped before the context reaches the LLM prompt, so adversarial document content cannot trigger interactive tool cards.

### C. Explicit Non-Goals (Out of Scope for Phase 2)
- No write tools (`write_file`, shell execution, system commands).
- No internet access or web search tool execution in MCP host.
- No third-party external MCP server installer or marketplace.
- No OS-wide overlays or window injections.
- No changes to Docker localhost 127.0.0.1 port bindings.

---

## Phase 1.5 — Honest Citations + Live KB Folder Watcher *(branch: phase-1.5-citations-and-gkb-sync)*

### A. Citations — page / section locators

- **PDF**: Source headers now show `filename (Page N)` using the 1-indexed PDF page number stored in Chroma metadata.
- **DOCX**: Parser groups paragraphs by heading style (Heading 1/2, Title). Each group emits a `Section: 'Title' ChunkN` locator — no invented paragraph numbers.
- **TXT / MD / HTML / CSV / JSON**: Each semantic chunk carries a `Chunk N` locator.
- **Images**: Vision-described images carry an `Image` locator.
- All locators flow from `rag_service.py` (workspace RAG) and `kb_service.py` (personal KB indexer) into Chroma metadata, then through `_build_citation_label()` in `chat.py` into the LLM context window and the `X-WS-Sources` / `X-KB-Sources` response headers.
- Source headers in the UI now display `filename (Page 4)` instead of bare filenames.
- WS and KB source labels are delimited with `|` (not `,`) in HTTP headers to avoid ambiguity with locator text that may itself contain commas.

### B. Global Knowledge Base — Real Windows folder mapping & interval-poll sync

- **Windows folder mapping (Phase 1.5B)**:
  - The native Windows launcher (`start.exe`) allows mapping local Windows folders via `start.exe --add-folder` or the `[A]` command.
  - When a folder is mapped, the launcher copies files into `./knowledge_base_data/<slug>/` using a one-way `robocopy /E` background process (`/MON:1 /MOT:1`).
  - The initial copy pass completes synchronously before indexing begins.
  - Changes in a mapped Windows folder appear within about one minute (robocopy `/MOT:1` plus KB poll interval). Not a live, continuous, or kernel watcher.
  - Raw user files on Windows are never deleted or modified. Existing files in destination outside the source tree are preserved.
- **Explicit rejection of Windows paths in UI**:
  - The web UI detects Windows paths (e.g. `C:\...`) and prevents submission, explaining the launcher mirror workflow.
  - The backend returns HTTP 422 if a Windows path is sent directly, preventing un-indexable configurations.
  - Inaccessible paths log a `WARNING` in the watcher (no silent skipping at DEBUG level).
- **Supported KB file formats**:
  - Knowledge Base indexes: **PDF**, **DOCX**, **PNG**, **JPG**, **JPEG**, **TXT**, **MD**, **HTML**.
  - **CSV** and **JSON** are intentionally excluded from KB indexing until dedicated tabular chunkers are implemented (they remain supported in Workspace uploads).
- **Sync & Polling details**:
  - `KBService` background thread (`KB-Folder-Sync-Watcher`) polls active folders every `KB_AUTO_SYNC_INTERVAL_SECONDS` (default **30 s**, env-tunable).
  - **Detection mechanism**: `os.walk` + `os.path.getmtime` — **not** a kernel filesystem watcher. Changes are detected within the poll interval.
  - File-system changes are debounced for `KB_SYNC_DEBOUNCE_SECONDS` (default **3 s**) before triggering `sync_folder()`.
  - Overlap-safe via `_acquire_sync_lock()` — duplicate in-flight syncs are skipped.

---

## Overview

This is an official frozen research-beta snapshot of StarkLLM, designed for local-first privacy, document RAG, and personal knowledge base exploration using Docker and native Ollama on Windows.

---

## What Works

- **Clean Docker Startup**: Automatic database initialization on clean volume creation without Alembic schema collision.
- **Pre-Configured Environment**: Ready-to-run `.env` shipped directly in the distribution archive with secure research defaults.
- **Default Models**:
  - Chat / Completion: `qwen2.5:7b` (default; `qwen2.5:3b` for lightweight setups)
  - Document Embeddings: `nomic-embed-text` (default)
  - Vision (optional): `llava`
- **Robust Launchers (Phase 1 Hardened)**:
  - `start.exe`, `start.cmd`, and `start.bat` perform automated container cleanup before launch to prevent naming and port conflicts.
  - Preflight checks verify Docker Desktop engine status, WSL2 kernel availability, Ollama reachable on host, required local models, and free local ports (8000/5173).
  - Generates `preflight_report.txt` for instant diagnostic and support triage.
  - Launchers poll backend `/health` before launching the browser to eliminate HTTP 502 Bad Gateway race conditions.
- **Onboarding Wizard Resilience**: Exponential backoff and automated retry handling during backend container initialization.
- **Verified Packaging**: Complete standalone distribution ZIP with all frontend/backend source assets, launchers, and offline TTS models included.

---

## Required Host Software & Prerequisites

1. **Operating System**: Windows 10 / 11 with WSL2 enabled.
2. **Docker Desktop**: Installed and running in the system tray.
3. **Ollama**: Installed natively on Windows host from [ollama.com](https://ollama.com).
4. **Recommended Models**:
   ```bash
   ollama pull qwen2.5:7b
   ollama pull nomic-embed-text
   ```

---

## Known Limitations

- **Backup / Restore UI**: Full automated database and vector backup/restore UI is not yet implemented (manual volume backups supported).
- **TTS Languages**: High-quality local Piper TTS models are included for English and German.
- **Web Search**: Optional live external web search toggle is not integrated; all queries operate exclusively on local documents and knowledge base.
- **Indexing Progress**: Real-time per-chunk indexing progress indicators in the Knowledge Base UI are basic.
- **Authentication Key**: The `SECRET_KEY` included in the default `.env` is a research default intended for local single-user research installations. Change it in `.env` if exposing on local network.

---

## Disclaimer

StarkLLM is provided "as is" as an open-source Research Beta without commercial warranty or SLA.
