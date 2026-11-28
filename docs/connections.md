# Connections: StarkLLM and other apps through MCP

Settings › **Connections** lets a non-technical user connect StarkLLM to popular apps (Blender, ComfyUI, Obsidian,
Zotero, Home Assistant ...) with a few clicks. Each connection is an MCP server (Model Context Protocol). StarkLLM
installs it with runtimes it brings itself, so the user installs nothing, and runs it with the same rules as Settings ›
Local Tools: every tool starts switched off, every call asks the user first.

| Part | File |
|---|---|
| The catalog (data) | `desktop/connections/catalog.json` |
| Validation, forms, risk tiers, pins, the 0.0.0.0 rule | `desktop/connections-core.js` |
| The per-call rules and the audit log | `desktop/tool-policy.js` |
| Install commands (bundled uv and Node) | `desktop/runtimes.js`, `desktop/build/fetch-runtimes.js` |
| Secrets in Windows Credential Manager | `desktop/secret-store.js` |
| `.mcpb` bundles | `desktop/mcpb.js` |
| Obsidian's own certificate, pinned | `desktop/pinned-https.js` |
| StarkLLM's own OBS connector | `desktop/connectors/obs-mcp.js` |
| Electron glue (IPC, dialogs, installation) | `desktop/connections.js`, `desktop/mcp.js` |
| Settings page, tool card | `frontend/src/components/ConnectionsPanel.jsx`, `McpServers.jsx`, `ToolCallCard.jsx` |
| Tests | `desktop/test/connections.test.js`, `frontend/tests/connections.test.mjs` |

## What happens on "Install"

1. The page shows the card (what it does, publisher, licence, last update, "works offline" / "home network"), the
   steps the user does in the other app, and a form generated from the entry's fields (folder picker, secret, address,
   number, checkbox). An "advanced" entry (Windows control) shows its warning and needs a tick first.
2. The desktop app checks the answers (`applyForm`): required fields, absolute folders, addresses on this PC (or, for
   Home Assistant only, on the home network), never `0.0.0.0`.
3. It runs the pinned package through the bundled runtime, every step announced to netguard as `connection_install`
   (refused while "Fully offline" is on):
   * Python servers: `uv python install <3.x>` then `uv tool install --force --python <3.x> <package>==<version>`, all in
     `<profile>/connections/uv/` (`UV_NO_CONFIG=1`, `UV_PYTHON_PREFERENCE=only-managed`: the user's own uv or Python are
     not used or changed);
   * Node servers: the bundled `node.exe` with npm: `npm install --prefix <profile>/connections/npm/<id> --ignore-scripts
     <package>@<version>`;
   * StarkLLM's own connectors (OBS) need no download: Electron runs them as Node.
4. Setup commands of the entry run once (Blender: `install-addon`; GIMP: `install-plugin`; DaVinci Resolve:
   `setup --clients manual`, which prepares its helper and does not touch other AI apps).
5. Secrets go to Windows Credential Manager (Web credentials, resource "StarkLLM Connections", user
   `<connection>/<field>`). `mcp-servers.json` holds only that name. They are read when the server starts and passed in
   its environment (or as an HTTP header); never on a command line, never in a file.
6. The server starts, its tools are listed, **all switched off**, and their name, description and input schema are pinned
   (SHA-256 of a canonical JSON).

Uninstall (Remove) stops the server, deletes its secrets, its npm, data or bundle folder, and `uv tool uninstall` when
no other connection uses the same package (Excel and Word share `mcp-office`).

## The runtimes in the installer

`npm run dist` runs `build/fetch-runtimes.js` first (`predist`): it downloads **uv 0.13.10** and **Node.js 24.22.3**
(Windows x64), checks each against the SHA-256 written in the script, and unpacks them to `build/runtime/` (not in
git). `package.json` copies that folder to `resources/runtime/`. To update a runtime: change version, URL and SHA-256
in the script (the SHA-256 from the publisher's release page: uv's `.sha256` asset, Node's `SHASUMS256.txt`), run
`npm run fetch-runtimes`, test an installation. In a run from source without the runtimes, Settings › Connections says
"runtime missing" for uv and npm entries; the OBS connector still works (Electron as Node).

## Adding a catalog entry

Add an object to `entries` in `desktop/connections/catalog.json`; `node --test test/connections.test.js` checks it.

| Field | Meaning |
|---|---|
| `id` | lower-case id, `[a-z0-9-]` |
| `status` | `ready` (can be installed) or `planned` (shown, not installable) |
| `name` | a brand name (string) or `{ en, de, es, fr, it, tr }` |
| `description`, `needsApp`, `steps[]`, `advancedWarning` | six languages each, formal address (Sie, usted, vous, Lei, siz) |
| `category` | `files`, `notes`, `research`, `home`, `3d`, `images`, `video`, `developer`, `office`, `system` |
| `publisher`, `license`, `lastUpdate` (YYYY-MM-DD of the pinned release), `homepage` | shown on the card |
| `network` | `offline` (this PC only), `lan` (needs a row in privacy-network.md and `allowLan`), `cloud` |
| `package` | `{ runtime: "uv" \| "npm" \| "builtin" \| "none", name, version, bin, python, setup: [[args]], setupDownloads, pythonEnv }`; `version` must be **exact** (`2.4.1`, `2026.11.27`; never `^`, `~`, `latest`) |
| `transport` | `stdio` (a program) or `http` (Streamable HTTP; `url` on this PC, or on the LAN with `allowLan`) |
| `args`, `env` | arguments and environment; `{field}` is replaced with the form's value. A secret is never an argument |
| `fields[]` | `{ id, kind: folder \| secret \| url \| text \| number \| checkbox, label, hint, required, default, env, header, format, unlocks, lan }`; `label: "@folder"` uses a shared text from `texts` |
| `readOnlyByDefault` | write and exec tools stay locked until a checkbox with `"unlocks": "write"` is ticked |
| `tiers` | `{ read: [...], write: [...], exec: [...] }`, names or `*` patterns. An exact name wins; among patterns the most dangerous tier wins |
| `defaultTier` | the tier of a tool no rule names (`exec` when unsure) |
| `blockedTools` | tools that can never be turned on (cloud, paid, raw API, shell) |
| `untrustedOutput` | tools whose result is content from outside (notes, files, mail, web): see the chain rule below |

Before adding: read the server's code (tools, what it connects to, telemetry and how to switch it off, whether it
listens on a port), pin the version, write the tiers from the real tool names, block what goes to the cloud. Test with
a mock where the app is not at hand and say so in the PR.

## Safety model

On top of the yes in the chat (the tool card), the desktop app enforces (`tool-policy.js`, `mcp.js`):

* **Off by default.** Every tool of every connection starts off. Tools in `blockedTools` cannot be turned on; with
  `readOnly`, only read tools can.
* **Risk tiers.** *Read* tools may be "allowed for this session" (until StarkLLM closes or "Stop all connections"):
  then they run without asking. *Write* tools ask every time. *Exec / send / delete* tools ask every time, show the full
  arguments in red and **never** offer "allow for the session". Tools of `.mcpb` bundles and of servers added by hand
  are tiered by their name (`guessTier`: delete/send/run/... = exec; get/list/read/... = read; else write); the server's
  own hints are not trusted for this.
* **Pins.** Name, description and input schema of each tool are hashed at the first start. If a later start finds a
  changed or new tool (an update, or a server that swaps its description to inject instructions), that tool is switched
  off and marked "changed"; it can only be turned on again after "I have reviewed the changes".
* **No 0.0.0.0.** A configuration with `0.0.0.0` or `::` in an argument, a variable or an address is refused (catalog,
  form, Local Tools, bundles), and HTTP connections must be on this PC. The only exception is Home Assistant on the
  home network, which shows "home network" and has its own row in privacy-network.md.
* **Chain rule.** When a tool marked `untrustedOutput` (or any tool of a bundle or a hand-added server) returned a
  result in a chat, an exec/send/delete tool in that chat needs a second tick ("I have checked the arguments") and shows
  where the content came from. The model never runs such a tool by itself after reading a note, a file or a web page.
* **Secrets** only in Windows Credential Manager; servers get the user's environment without secrets
  (`serverEnv`), plus their own.
* **Audit log** `connections-audit.jsonl` in the profile: time, connection, tool, tier, arguments (cut at 4000
  characters), size of the result, outcome (ok, refused, error), duration, and whether it ran by a session allowance.
  Shown under Settings › Connections › Call log.
* **Stop all connections** ends every server and forgets the session's allowances. "Fully offline" does the same.
* **Advanced entries** (Windows control) need an explicit "I understand the risk"; the PowerShell, Registry and
  FileSystem tools of Windows-MCP are excluded on its command line and blocked in StarkLLM.

## .mcpb bundles

Opening a `.mcpb` file with StarkLLM (file association), choosing it in Settings › Connections or dropping it there
shows the manifest first: name, author, version, licence, how it runs, the tools with their guessed tier, the number of
files and the unpacked size. Nothing is unpacked before "Install bundle". The ZIP is read by StarkLLM's own reader
(`mcpb.js`): no ZIP64, no encryption, nothing outside the bundle's folder (`../`, drive letters), at most 256 MB packed
and 1 GB unpacked. `user_config` becomes the form (sensitive values go to Credential Manager); `node` runs with the
bundled Node, `python` with the uv-managed Python 3.12, a `binary` must be inside the bundle.

## Entries of v1

| Entry | How | Tested |
|---|---|---|
| Files | `@modelcontextprotocol/server-filesystem@2.4.1` (npm), folder picker, read-only by default | installed for real through the bundled-runtime path in Electron on Linux (`tools/connections-try.js`): 16 tools all off, write tools locked, a call without a yes refused, read with a yes, session allowance, a path outside the folder refused by the server, audit log, pins, network log; not yet on Windows |
| Obsidian | the Local REST API plugin's MCP endpoint `https://127.0.0.1:27124/mcp/`, API key, certificate pinned on first use | pinned HTTPS against a local test server; not yet with the real app |
| Zotero | `zotero-mcp-server==0.17.4` (uv), `ZOTERO_LOCAL=true`, scite tools blocked | installed for real with uv and started (35 tools listed) on Linux; not yet with the real app |
| Home Assistant | built-in MCP Server at `http://<ha>:8123/api/mcp`, long-lived access token as Bearer, LAN only, read-only by default | form and LAN rule; not yet with the real app. OAuth 2.1 + PKCE is still to do |
| Blender | `mcp-for-blender==2.3.3` (uv), `install-addon`, telemetry off, safe mode, `execute_blender_code` = exec, online tools blocked | `install-addon` needs Blender on the PC (without it the installation stops with Blender's "addons directory not found"); not yet with the real app |
| ComfyUI | `comfy-mcp==0.11.0` (uv), `COMFYUI_URL`, partner and account tools blocked | installed for real with uv and started (41 tools listed, partner tools shown as always off) on Linux; not yet with the real app |
| Git | `mcp-server-git==2026.11.27` (uv), `--repository <folder>` | installed for real with uv (managed Python 3.12) in Electron on Linux, `git_status` on a test repository; not yet on Windows |
| DaVinci Resolve | `davinci-resolve-mcp@5.7.2` (npm) with uv's Python 3.12, `setup --clients manual`, its files in StarkLLM's folder (`DAVINCI_RESOLVE_MCP_INSTALL_ROOT`); "Studio required" | installed for real on Linux; its setup's last check needs Resolve and is reported as a warning; not yet with the real app |
| GIMP 3.2 | `gimp-mcp-plugin==0.6.0` (uv), `install-plugin`, `call_api` blocked | `install-plugin` needs GIMP's config folder (start GIMP once); not yet with the real app |
| OBS Studio | StarkLLM's own connector (obs-websocket v5, port 4455, password in Credential Manager), seven tools | against a mock obs-websocket server (password handshake, all tools); started in Electron as Node; not yet with the real app |
| Excel, Word | `mcp-office[com]==0.7.0` (uv), `excelmcp` / `wordmcp`, read-only unless allowed, `run_macro` blocked, `EXCEL_ENABLE_MACROS=false` | Windows only (COM); not yet tried |
| Windows control (advanced) | `windows-mcp==0.9.0` (uv, Python 3.14), `serve --exclude-tools PowerShell,Registry,FileSystem`, `ANONYMIZED_TELEMETRY=false` | Windows only; not yet tried |

Windows Credential Manager: the PowerShell script was run on Windows 11 for a read of a missing entry (loads the
PasswordVault, reads the request, answers "none"); storing and removing were tested with the store mocked only.

For OBS no third-party server was taken for v1: none was reviewed in enough depth to trust it with the stream key's
account, and the job is small. StarkLLM's connector has only the seven tools it needs (no generic "send any request"),
listens on no port and talks only to `127.0.0.1`.

## The iPhone app (plan, no code yet)

The future StarkLLM app for iPhone will not run MCP servers itself (iOS does not allow starting other programs, and
the apps it would control - Blender, Resolve, OBS, Zotero - run on the PC). It uses the connections **through the PC**:

1. **StarkLLM on the PC as MCP server for the phone.** The phone already reaches the PC over the encrypted phone link
   ([android-companion.md](android-companion.md), [phone-away.md](phone-away.md): TLS with the PC's own certificate,
   pinned when pairing; away from home through the relay, which sees only encrypted bytes). A new allow-listed route on
   that link, `POST /phone/mcp`, speaks MCP (Streamable HTTP, JSON-RPC) and offers **only the tools the user turned on
   for the phone**: a second switch per tool ("also from the phone"), off by default. The desktop app proxies each call
   to the connection with exactly the rules above (tiers, pins, blocked tools, audit log with "from: iPhone").
2. **Approval stays with a person.** A read tool allowed for the session on the PC is not automatically allowed from the
   phone. Write and exec tools ask on the phone (the card shows the full arguments) and, for exec/send/delete, can be
   set to need a confirmation on the PC as well. The chain rule applies per phone chat.
3. **Secrets never leave the PC.** The phone gets tool names, descriptions and results, never an API key, token or
   password from Credential Manager.
4. **App Intents.** The iPhone app exposes a few App Intents ("Ask StarkLLM", "Run a connection tool", "Start
   recording in OBS", "Find in my Zotero library"), so Siri, Shortcuts and the Action button can use them. An intent
   sends the request over the phone link; iOS shows its own confirmation for intents that change something
   (`requestConfirmation`), and the PC still applies the tier rules. Intents are generated from the tools the user
   allowed for the phone (parameter types from the input schema; only simple types; others are not offered).
5. **Offline and privacy.** At home the link is direct (LAN); "Fully offline" on the PC closes it as today. The
   privacy table gets a row for "phone uses connections" (feature `phone_link`, no new host).

Order of work: the `/phone/mcp` route and the per-tool phone switch on the PC (testable with the Android app first),
then the iPhone app with the same pairing, then App Intents.

## Tests

`desktop/test/connections.test.js` (run with the desktop tests): catalog validation, form generation and answers,
secret storage with Credential Manager mocked (secret on standard input, base64, never on the command line or in the
stored entry), risk tiers and the per-call rules (session allowance only for read, second tick after untrusted content,
"Stop all"), the audit log, schema pins (also against a mock MCP server whose description changes), the 0.0.0.0
refusal, `.mcpb` manifest parsing and bad bundles, install commands, netguard refusing downloads while offline, pinned
HTTPS, and the OBS connector against a mock obs-websocket server. `frontend/tests/connections.test.mjs`: the page's
helpers.

`desktop/tools/connections-try.js` installs real packages in Electron (Files, Git, a `.mcpb` bundle; more with
`MORE=zotero,comfyui,...`) from a runtime folder laid out like the installer's, and checks the rules end to end. It
downloads packages, so it is a manual check, not part of `node --test`.
