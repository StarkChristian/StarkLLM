# Roadmap: features compared with other private AI assistants (from 22 November 2026)

The owner agreed (22 November 2026) to build every gap found in a comparison with other local and private AI
assistants: AnythingLLM, GPT4All, LM Studio, Jan, Msty, Open WebUI, Khoj, PrivateGPT and Reor. Each step is its own
pull request with tests and translations. Merging and releasing follow the usual rule: only with the owner's OK
naming the PR number.

## What StarkLLM has already (not built again)

| Gap named in the comparison | In StarkLLM | Where |
| --- | --- | --- |
| Citations that open the source at the right page, with the passage marked | yes: Sources → "Open document at page n", the passage highlighted | `SourcesModal.jsx`, `DocumentViewerModal.jsx` |
| Tools by the Model Context Protocol (MCP) | StarkLLM is an MCP server for other programs; its own model has built-in read-only tools with a yes per call | `api/mcp_server.py`, `api/mcp.py` |
| Mobile companion | the Android app with a private link to the PC (pairing by QR code, TLS, no cloud) | `desktop/phonelink.js`, `docs/android-companion.md` |
| Export | chats as Markdown, JSON and HTML | `utils/chatExport.js` |
| Speech | dictation (Whisper on the PC) and reading aloud (Piper) | `api/voice.py` |
| Images | image files as documents (text recognition, a description by a vision model) | `ocr_service.py`, `vision_service.py` |

## What is missing, in the order it is built

| # | Feature | Why | Who has it | Size | Depends on |
| --- | --- | --- | --- | --- | --- |
| R1 | **Export to Word and PDF** (a chat, an answer, a summary) | answers become documents to send or print | Open WebUI, AnythingLLM | small | none |
| R2 | **An image in the question** (paste, drag or attach; a vision model answers) | screenshots, photos of letters and charts lose their layout as text | LM Studio, Open WebUI, Msty, Jan | medium | none |
| R3 | **Recordings: meetings and voice memos as documents** (mp3, m4a, wav, ogg, webm, mp4 audio → a text with times, then questions and a summary) | the speech model is there already; meetings stay on the PC, with no bot joining a call | AnythingLLM Meeting Assistant | medium | none |
| R4 | **Two models side by side** (the same question, two local models, answers next to each other) | users find the best model for their PC and language | Msty Split Chats, Open WebUI | medium | none |
| R5 | **Scheduled tasks** (a saved web task or question at a time: daily or weekly, looking only; changes go to the inbox) | a price, a deadline or a portal checked without the user | AnythingLLM Scheduled Jobs, Khoj Automations | large | web tasks (#158, #159) |
| R6 | **MCP client: connect other MCP servers** (local programs that offer tools; the user adds each one and allows each tool) | the standard way to plug in tools | AnythingLLM, LM Studio, Jan, Msty, Open WebUI | large | none |

### Rules for all of them

- Privacy first: nothing leaves the PC unless the user turns it on and sees it. New network use gets a row in
  `docs/privacy-network.md` and goes through the network layer, and the offline switch stops it.
- Every text in all app languages, checked by `check-i18n`. Tests for every rule in code.
- Small local models first: each feature is measured with 7B, 14B and 27B models where a model is involved, and the
  card or settings say which size is needed.

### R1 Export to Word and PDF

- Chat menu "Export": add **Word (.docx)** and **PDF** next to Markdown, JSON and HTML. Under each answer: **Save as
  Word/PDF**, for a single answer with its sources.
- Word: the engine writes the file (python-docx is installed already): headings, lists, tables, bold, code, and the
  sources with file and page. PDF: the desktop app prints the same HTML with Electron (`printToPDF`), so there is no
  new library; in the browser version, the browser's own print dialog.
- Tests: Markdown → docx structure (headings, lists, tables), file name, no raw Markdown left in the text.

### R2 An image in the question

- The paper-clip button and drag and drop accept images in the chat. The image goes with the question to a
  **vision model** on the PC (for example qwen2.5vl, gemma3 or llava). If none is installed, the chat offers to
  download one (with the size shown) or to save the image as a document instead (text recognition).
- The image is kept with the chat (on the PC), shown as a thumbnail and resized before sending (at most 1536 px).
- Tests: the engine sends `images` to Ollama only for a vision model; a text model gets a clear message; images are
  not sent to a cloud provider unless the user chose one and sees the cloud badge.

### R3 Recordings

- Upload accepts audio files (and the sound of video files). The engine writes a text with times
  (`[00:12:30] …`) with the Whisper model it has, in the background with progress, then indexes it like a document.
- The document card offers "Summarize the meeting": decisions, open points and tasks with names and dates.
- Long recordings: split into parts so the progress shows; at most 4 hours.
- Tests: the time format, the split, the supported file types; an audio file of a few seconds through the real model
  in the backend tests.

### R4 Two models side by side

- In the model list: "Compare with…". The question goes to both models, one after the other (one model in the
  graphics memory at a time), and the answers appear next to each other, each with its time and words per second.
  "Keep this answer" puts one into the chat.
- Tests: the order (one model at a time), the chat keeps only the chosen answer.

### R5 Scheduled tasks

- A saved web task or a question about the workspace gets a schedule: daily or weekly at a time. Only **looking**
  tasks are allowed: no risky clicks, no form sends, no terminal. A scheduled web task stops where it would need the
  user.
- The result goes into the inbox; a change since the last run is marked. It runs only while StarkLLM is running and
  online; a missed run runs at the next start.
- Tests: the schedule math (time zones, daylight saving time), "looking only" enforced in code, and offline.

### R6 MCP client

- Settings → Tools: add an MCP server (a local program, started by StarkLLM, or an address on this PC). StarkLLM lists
  its tools; each tool is off until the user turns it on, and each call asks for a yes, unless the user allowed that
  tool for good.
- Only local servers (stdio or 127.0.0.1); servers started by StarkLLM get the project folder rules of the terminal
  (no secrets in their environment). The offline switch stops them.
- Tests: the JSON-RPC handshake with a fake server, tool lists, a yes per call, stop on offline.

## Order and state

| Step | State |
| --- | --- |
| R1 Export to Word and PDF | in progress |
| R2 An image in the question | next |
| R3 Recordings | planned |
| R4 Two models side by side | planned |
| R5 Scheduled tasks | planned (after #158 and #159 are merged) |
| R6 MCP client | planned |
