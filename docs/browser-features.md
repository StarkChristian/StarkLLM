# StarkLLM's browser window compared with Chrome, Firefox and Opera

Owner request of 28 November 2026: bring StarkLLM's own browser window (the window of web tasks, [web-tasks.md](web-tasks.md))
closer to Chrome, Firefox and Opera, after a comparison of what it lacks. State before this work: version 2.6.0
(address bar with back, forward, reload/stop, start page). The browsers' columns describe their desktop versions for
Windows as documented by their makers; details change from version to version.

The plan follows StarkLLM's privacy rules ([RULES.md](RULES.md), [privacy-network.md](privacy-network.md)):

- nothing goes online without the user (a web task is the user's request; the user's clicks are the user's);
- every new network use goes through the network layer (`desktop/netguard.js`) and is listed in privacy-network.md;
- the "Fully offline" switch stops it;
- no sync to any cloud;
- StarkLLM stores no passwords, and never types them.

"Build now" is in this change (branch `feat/browser-tabs`). "Later" is a next step that fits the rules.
"Never" does not fit them.

## Everyday browsing

| Feature | Chrome | Firefox | Opera | StarkLLM 2.6.0 | Plan |
|---|---|---|---|---|---|
| Tabs: open, close, switch, reorder | yes | yes | yes | one page only | **Build now.** Each web task gets its own tab; the user opens more (+, Ctrl+T), closes (×, Ctrl+W, middle click), switches (click, Ctrl+Tab, Ctrl+1…9). Reordering by dragging: later. |
| Reopen a closed tab (Ctrl+Shift+T) | yes | yes | yes | no | **Build now** (the last 10 closed tabs of this window, in memory only). |
| Links with `target=_blank` open a new tab | yes | yes | yes | open in the same page (2.5.0 fix for tasks) | **Build now**: a new tab when the user clicks; the same page while a task works in that tab, so the task's checks still apply. |
| Keyboard shortcuts (Ctrl+L, F5, Alt+←/→, Ctrl+T/W/Tab, Ctrl+F, Ctrl+D, Ctrl+H, Ctrl+J, Ctrl± …) | yes | yes | yes | none | **Build now** (the common ones of all three; list in [web-tasks.md](web-tasks.md)). |
| Favourites (bookmarks): star in the address bar | yes | yes | yes (heart/"Bookmarks") | no | **Build now** (Ctrl+D). |
| Favourites bar | yes | yes | yes | no | **Build now** (Ctrl+Shift+B shows or hides it). |
| Favourites manager (rename, delete, folders) | yes | yes (Library) | yes | no | **Build now**: rename, change the address, delete. Folders: later. |
| Import favourites from another browser | yes | yes | yes | no | Later: from an HTML export file the user picks (no reading of other browsers' profiles). |
| Sync of favourites, history, tabs | Google account | Mozilla account | Opera account | no | **Never**: no sync to any cloud. A local export/import file is possible later. |
| History with search and "Clear history" | yes | yes | yes | no | **Build now**: local, per account, protected at rest; search, remove one entry, clear all. |
| Address bar suggestions from history and favourites | yes | yes | yes | no | Later (local only; online suggestions of a search engine: never, they send every keystroke). |
| Search engine suggestions while typing | yes (Google) | yes | yes | no | **Never** (each keystroke would go online). |
| Find in page (Ctrl+F, F3) | yes | yes | yes | no | **Build now** (next, previous, "3 of 12"). |
| Zoom (Ctrl+±, Ctrl+0, Ctrl+wheel) | yes, per site | yes, per site | yes, per site | no | **Build now**, per site like Chrome; the % shows in the address bar and resets with a click. A web task's clicks take the zoom into account. |
| Downloads with a list (where the file went) | yes | yes | yes | downloads are refused | **Build now**: only when the user starts one, with the save dialog (the user picks the place); never during a web task; programs and scripts (.exe, .msi, .bat, .ps1 …) get a warning first; the list shows name, site, size, state and "Show in folder". No "open the file" button. |
| Open the page in the system browser | – | – | – | no | **Build now** (button and menu; it opens the user's own browser, not a connection of StarkLLM, like the links of privacy-network.md D3/D9). |
| Print / save as PDF | yes | yes | yes | no | Later (StarkLLM already writes PDFs: `desktop/export-pdf.js`). |
| Reader view | Reading mode (side panel) | yes | no built-in one | no (the task reader exists in `webtask-page.js`) | Later: the text the window already reads for "Save this page to the workspace", shown as a clean page. |
| Screenshots of a page | yes | yes | yes ("Snap") | no | Later. |
| Picture-in-picture video | yes | yes | yes ("Video pop out") | no | Later (needs a second window; not useful for tasks). |
| Spell check in fields | yes (online "enhanced" optional) | yes | yes | off | Later, with dictionaries on the PC only (the online dictionary download is a new connection). |
| Translate a page | yes (Google) | yes (on the device) | yes (online) | no | Later, with the local model only ("translate this page" as a task). |
| Tab groups, workspaces, vertical tabs | yes | vertical tabs | workspaces, tab islands | no | Later. |
| Built-in AI side panel | Gemini (online) | AI chatbot of your choice (online) | Aria (online) | web tasks with the local model | Already the core of StarkLLM, local only. |

## Privacy and safety

| Feature | Chrome | Firefox | Opera | StarkLLM 2.6.0 | Plan |
|---|---|---|---|---|---|
| Own profile, separate from the user's browser | profiles | profiles | profiles | yes (`persist:starkllm-web`) | Kept. |
| Private window / no cookies kept between tasks | Incognito | Private window | Private window | cookies kept until "Clear the data of StarkLLM's browser" (Settings) | Later: a "private tab" with a storage that ends with the tab. Not the default for all tasks, because sign-ins the user did for a task would be lost each time. |
| Separate cookies per account of StarkLLM | – | containers | – | one storage for all accounts on the PC | Later (one browser storage per account; this change already keeps favourites, history and downloads per account). |
| Tracker blocker | Tracking protection (3rd-party cookies limited) | Enhanced Tracking Protection | built-in ad and tracker blocker | no | Later: a list that ships with StarkLLM (updated with the app, never downloaded by itself), through `webRequest` like the network layer. |
| Permission prompts (camera, microphone, location, notifications) | ask | ask | ask | all refused, no prompt | Kept refused for now: a page of a task must never get the camera or location. Later, maybe: ask for the user's own tabs only, never during a task. |
| Pop-up windows | blocked, ask | blocked, ask | blocked, ask | never a new window | Kept (a new tab instead). |
| Safe Browsing / phishing warnings | online lookups (Google) | online lists (Google) | online | site rules on the PC (banks, health, government ask; adult sites blocked) | Later: an offline list shipped with the app. Online lookups: never by default. |
| HTTPS-only mode | optional | optional | optional | the lock shows HTTPS; http allowed | Later: a warning page before an `http://` page. |
| Password manager | yes, synced | yes, synced | yes, synced | none; passwords are always typed by the user | **Never** a password store in StarkLLM. Hand-off: the user's own password manager can fill the page when the user types (Windows clipboard / its own app); a browser extension of a password manager in this window: later, only with the user's choice. |
| Payment details autofill | yes | yes | yes | none | **Never**. |
| Form autofill (address) | yes | yes | yes | none | Later, maybe; stored like favourites, typed only by the user's click, never by a task. |
| Extensions | Chrome Web Store | add-ons | Opera add-ons and Chrome Web Store | none | Later, only for a few chosen ones (password manager). |
| Built-in VPN | no | Mozilla VPN (paid) | free "VPN" (proxy) | no | **Never** (a third party would see all traffic). |
| Network log of every request | DevTools only | DevTools only | DevTools only | yes, Settings › Privacy & network | Kept; the new features add no new host. |

## What this change adds to the rules

- **No new host.** Tabs, favourites, history, find, zoom and the downloads list make no connection of their own.
  Favicons are not loaded (they would be extra requests); a tab shows the first letter of its site instead.
- **Downloads** are new requests of pages the user already opened; they go through the same network layer
  (`web_task`), are refused while fully offline, and only start after the user's click and the save dialog.
- **Stored on this PC only, per account, encrypted**: favourites, history, downloads list and the "favourites bar
  shown" choice are kept in `browser/<hash of the account>.bin` in StarkLLM's profile folder, encrypted with Windows
  (DPAPI, Electron `safeStorage`, like the sessions of paired phones). Where Windows encryption is not available,
  nothing is written; the lists then last until StarkLLM closes. Signing out or another account closes the window.
- **Scheduled web tasks** (the hidden window) keep no history and cannot download.
