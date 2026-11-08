# StarkLLM Release Notes

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
