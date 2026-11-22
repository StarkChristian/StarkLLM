# Every outgoing connection of StarkLLM

StarkLLM's promise: nothing leaves the PC unless the user turns on an optional online feature. This page lists **every
way the app, its engine and the programs it starts can reach the network** (state of this branch, roadmap phase 3), and
how each one is recorded and switched off. Settings > Privacy & network shows the same connections live, and the
"Fully offline" switch there refuses all of them. How to check all this yourself: [verify-privacy.md](verify-privacy.md).

Two layers do the work, and a test fails when code goes around them:

| Layer | Where | Test |
|---|---|---|
| **Desktop app** (Electron main process and the app window) | `desktop/netguard.js`: every request of the main process is announced to it; `webRequest` hook on the window's session | `desktop/test/netguard.test.js`: reads all desktop sources, fails on a new way to connect and on a web address that is not listed here |
| **Engine** (Python backend; since 2.2.1 it runs directly on Windows with its own Python, in Docker Desktop only when the user chooses that in the tray menu) | `backend/app/core/netguard.py`: the only module that may use an HTTP client; a check in `socket` as second line of defence | `backend/tests/test_network_layer.py`: greps the backend for `requests`, `httpx`, `urllib`, raw sockets, and for libraries with their own client that run outside the guard |

The log (`network-log.jsonl` in the app's profile folder, `data/network_log.jsonl` in the engine's data folder) holds
**time, host, port, purpose (feature), bytes sent and received, result**. It never holds a path, a query, a search
term, a file name or a body. It stays on the PC and is exported only by the user (CSV or JSON, Settings > Privacy &
network).

## The table

"User-controlled": can the user prevent it? "Default": is it on in a fresh install? "Offline": what the "Fully
offline" switch does to it. Feature = the key shown in the list.

### Desktop app (Electron main process)

| # | What | Host | When | Why | User-controlled | Default | Offline | Feature |
|---|---|---|---|---|---|---|---|---|
| D1 | Update check | `api.github.com` (releases/latest) | at start, tray menu "Check for Updates", Settings > About | tell about a newer version (sends no data except what any HTTPS request carries) | yes: asked once at the first start; tray switch | **off until the user agrees** | not done, a manual check says why | `update_check` |
| D2 | Update download | `github.com` and the release file host it redirects to | only after "Download and install" | replace the app | yes, every time | off | refused | `update_download` |
| D3 | Link "download page" | `www.starkllm.com` | only when the user clicks it | open in the user's own browser | yes | - | opens the browser (not a connection of the app) | - |
| D4 | Ollama installer | `ollama.com`, then the release file host it redirects to | only after "Install Ollama for me" | install the local AI runtime | yes | off | refused | `ollama_install` |
| D5 | Engine images (only when the engine runs in Docker Desktop) | `ghcr.io` (token, manifests: by the app; layers: by Docker) | start of an installed app when the engine is missing or older than the app | get the engine of this version | not optional for a first start (the app cannot run without the engine); one time per version | on, when needed | skipped: the engine files already on the PC are used; without them the app says what to do | `engine_download` |
| D5b | Engine package (without Docker) | `github.com` (release of the app's version) and the release file host it redirects to | start of an installed app when the engine package of this version is neither inside the installer nor on the PC yet (installers since 2.2.1 bring it, so this happens only with builds without it) | get the engine of this version with its own Python (about 380 MB download, 870 MB unpacked) | not optional for a first start without Docker; one time per version | on, when needed | refused before anything is sent; the app says to start once online | `engine_download` |
| D6 | Engine build | `registry-1.docker.io`, `pypi.org`, `deb.debian.org` (by Docker) | only when D5 fails, or in a run from source | build the engine on this PC | no (fallback) | on, when needed | skipped | `engine_build` |
| D7 | AI model download | `registry.ollama.ai` (by the local Ollama, on the app's request) | first start for models that are missing (`qwen2.5:7b`, `nomic-embed-text`, `llava`, or ones that fit the PC) | the models StarkLLM needs | not for the first start (chat needs a model); later yes (Model Hub is a click) | on, when needed | refused; the start continues with what is installed and says which model is missing | `model_download` |
| D8 | App window requests | any host the page asks for | none by StarkLLM's own page (no CDN, no web fonts, no analytics; images of other sites are blocked in answers) | - | - | none | cancelled | `ui` |
| D9 | Links in answers and documents, and on the "what is missing" page (`www.docker.com`, `ollama.com`, `www.starkllm.com`) | the linked site | only when the user clicks | open in the user's own browser | yes | - | opens the browser (not a connection of the app) | - |
| D10 | Local calls | `127.0.0.1` (engine, Ollama, UI) | always | the app talks to its own engine | - | on | allowed (counted, not listed) | - |
| D11 | Phone link (incoming) | a paired phone on the home network connects to the app (port 47615 or the next free one, TLS with the app's own certificate) | only after the user turned it on in Settings > Phone and paired a phone with the QR code | the StarkLLM app for Android asks about the documents on this PC ([android-companion.md](android-companion.md)); only an allow-list of engine calls, never settings, backup, online providers, web search or cloud models | yes: off by default, "Turn off" closes the port, "Remove" revokes a phone | **off** | the port is closed and every connection refused | `phone_link` |
| D12 | Web tasks ([web-tasks.md](web-tasks.md)) | the sites of the task the user typed (search: `duckduckgo.com`), and the local Ollama for each step | only after the user switched on "Web task" in the chat and sent a task | StarkLLM does the task on websites in its own browser window (own storage; no permissions, no downloads; web pages cannot reach this PC or the home network) | yes: per task, Stop, closing the window; a yes before every risky click | **off** | cannot start; a running task ends | `web_task` |
| D13 | Terminal of tasks ([web-tasks.md](web-tasks.md#terminal-help-with-code-in-a-project-folder)) | none by StarkLLM itself; a command the user allowed may connect (for example `npm install`, `git push`) | only with a project folder the user chose and a yes for each command (a few looking commands run without asking) | commands run as programs of the user, **not** through StarkLLM's network layer, so they are not in the network log | yes: per command; Stop | **off** | commands that use the internet are refused; the folder can still be used | (not recorded) |
| D14 | Tool servers (MCP) the user added (Settings › Tools; `desktop/mcp.js`, docs/roadmap-2026-12.md R6) | a server on this PC only: a program StarkLLM starts, or `127.0.0.1` / `localhost` (calls to an address are in the network log as `mcp`) | only servers the user added; each tool off until turned on; each call after a yes in the chat | the program is the user's own choice and runs with the user's rights: what it connects to itself is **not** controlled by StarkLLM (the Settings page says so); it gets no secrets from StarkLLM's environment | yes: per tool and per call; Stop; Remove | **off** | servers are stopped and do not start | `mcp` |

Not present: crash reports, telemetry, usage statistics, advertising or feature flags. Electron's `crashReporter` is
not started; the code has no analytics library.

### Engine (backend)

| # | What | Host | When | Why | User-controlled | Default | Offline | Feature |
|---|---|---|---|---|---|---|---|---|
| E1 | Web search | `duckduckgo.com` (`html.duckduckgo.com`; one engine only, the library default would ask several) | per question, only with the "Web Search" button on | add search results to the answer; the question is sent | yes, per question | **off** | button disabled, request refused | `web_search` |
| E2 | Web page import | the address the user typed | only after "+ Web URL" | read a page into the workspace | yes | off | refused | `web_import` |
| E3 | YouTube import | `www.youtube.com` | only after "+ YouTube Video" | title and transcript | yes | off | refused | `youtube_import` |
| E4 | GitHub import | `api.github.com`, `raw.githubusercontent.com` | only after "+ GitHub Repo" | read a repository | yes | off | refused | `github_import` |
| E5 | Online AI provider | the base URL the user entered (presets: `api.openai.com`, `api.deepseek.com`, `openrouter.ai`, `api.groq.com`) | every chat while such a provider is selected in Settings; the question, the retrieved passages and the API key are sent | use an online model | yes (choose a local model) | **off** (provider "ollama") | refused with a message that says why; the chat page shows a badge while one is used | `cloud_llm` |
| E6 | Live prices widget | `query1.finance.yahoo.com`, `api.coingecko.com` | only after the user switches the widget on (the browser used to ask CoinGecko directly: now it goes through the engine) | prices on the home page | yes | **off** | refused | `market_prices` |
| E7 | Speech models | `huggingface.co` | the first time voice input is used (Whisper base, about 140 MB), and the first time a recording is uploaded (Whisper large-v3-turbo, about 1.6 GB), if the model is not on the PC | speech to text | yes (do not use voice input or recordings) | off until used | refused (recordings then use the smaller model if it is on the PC) | `speech_model_download` |
| E7b | OCR language pack | `github.com` (`raw.githubusercontent.com`, the Tesseract project's `tessdata_fast`; `OCR_PACK_URL` can point to a mirror) | only after "Download" in Settings > Reading photos and scans | one language file (a few MB) so photos and scans can be read in that language | yes | off | refused (the button shows the error) | `ocr_language_pack` |
| E8 | Ollama cloud models | `ollama.com` (through the local Ollama) | only when the user picks a model whose name ends in `:cloud` or `-cloud` | run a model on Ollama's servers | yes | off | refused (`models.js` never picks one automatically) | `ollama_cloud_model` |
| E9 | Library telemetry | - | `ANONYMIZED_TELEMETRY=False`, `HF_HUB_DISABLE_TELEMETRY=1`, `DO_NOT_TRACK=1`, `RAGAS_DO_NOT_TRACK=true` are set in `docker-compose.yml` and in `app/core/config.py` | chromadb, Hugging Face, ragas | - | off | - | - |
| E10 | Local calls | the local Ollama (`host.docker.internal:11434`), the engine itself | always | embeddings, chat, health | - | on | allowed (counted, not listed) | `ollama` |
| E11 | Code runner | none | "Run" on a code block | run a snippet on the PC | - | the child process cannot open a socket (`_NO_NETWORK`) | same | - |
| E12 | Tools (MCP), Studio, memory, search | none | - | all of them read the PC's own data and use the model of E5/E10; a tool runs only after the user's click | - | - | - | - |

Any new online feature must use `app/core/netguard.py` (the backend test then covers it) and be added to this table.

### Programs StarkLLM starts or needs, which are not StarkLLM

| What | Connections it makes by itself | What StarkLLM does |
|---|---|---|
| **Ollama** (local AI runtime) | its own update check and model downloads (`ollama.com`, `registry.ollama.ai`) | StarkLLM does not control the Ollama program. It refuses to ask Ollama for downloads or cloud models while offline. To stop Ollama's own update check, turn it off in Ollama's settings or block it in the firewall (see verify-privacy.md). |
| **Docker Desktop** (only when the user chose it for the engine) | updates, telemetry of Docker, image pulls | Same: not controlled by StarkLLM. The "Fully offline" start uses `docker compose up --no-build` and pulls nothing. |
| **Chromium inside Electron** | system proxy auto-detection (WPAD), certificate revocation checks, spell-check dictionary download | The app window's spell-check dictionary download is off while the switch is on. Proxy detection and revocation checks go to your own network or certificate servers when a page is HTTPS; StarkLLM's own page is `http://localhost` and needs none. |
| **Windows** | its own services | out of scope |

## What "Fully offline" does

1. **Engine**: `netguard` refuses every HTTP request except to this PC (`localhost`, `host.docker.internal`, the Ollama
   address). Libraries with their own client (web search, YouTube, speech model download) run only inside
   `netguard.external()`, which refuses first. Underneath, a check in `socket` refuses `connect` and name lookups
   (DNS) for any other address, which also stops libraries that do not know about the guard. Models whose name ends in `cloud` are
   refused.
2. **App**: no update check, no update download, no Ollama installer, no engine or model download; the engine starts
   from the files that are already on the PC (`--no-build`); the window's `webRequest` hook cancels any request that is
   not to this PC; the spell-check dictionary download is off.
3. **UI**: a banner on the chat page, the switch in Settings > Privacy & network, the tray menu shows the state, web
   search is disabled.
4. At the first start the app asks once (stay online, the default, or go fully offline; administrators can skip the question with the environment variable `STARKLLM_ASK_OFFLINE=0`). The switch is saved (`privacy.json`) and survives restarts. The desktop app starts the engine with
   `STARKLLM_OFFLINE=1`. If the two ever differ, offline wins: the settings page makes both offline.
5. Who may switch it: any signed-in account may turn it on, and the engine keeps which account did (`set_by` in
   `privacy.json`). Turning it off lets the engine reach the internet again for every account, so in a browser only
   the administrator (the first account) and the account that turned it on may do that; anyone else gets "Only the
   administrator of this StarkLLM, or the account that turned "Fully offline" on, can turn it off." When it came from
   `STARKLLM_OFFLINE=1` or the desktop app (no account), only the administrator or the desktop app turn it off. The
   switch of the desktop app (Settings in the app, tray menu) always sets both the app and the engine
   (`PUT /api/v1/privacy/offline/desktop` with the same `X-Desktop-Key` as the desktop session): the person at the app
   owns the PC. If the engine cannot be reached, the app says so; turning it on still takes effect in the app at once,
   and turning it off is allowed in the app so that a first start that chose "offline" can still download the engine.

Limits, honestly: the guard cannot stop a client that is written in another language and does not go through
`socket` (the search library's own client is wrapped by `netguard.external()`, so it is stopped before it starts), and
it cannot control other programs (Ollama, Docker, Windows). The proof that the engine itself makes no connection is the
run without a network in [verify-privacy.md](verify-privacy.md): for the installed engine a firewall rule for its own
`python.exe`, for the source code `docker run --network none`, which the test suite also does.
