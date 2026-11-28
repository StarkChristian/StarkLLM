# Accessibility of the desktop interface (2.7)

Goal: the Windows app's interface (the React frontend in `frontend/`) meets **WCAG 2.1 level AA**, which is what
**EN 301 549** (the standard behind the European Accessibility Act) asks of software. This page says how it is checked,
what the audit found, what was changed, and what is still open.

## How it is checked

`frontend/scripts/a11y-check.mjs` (`npm run a11y`, CI job `accessibility` in `.github/workflows/checks.yml`):

- serves the built interface (`dist/`) with made-up answers for the `/api` calls (no engine, no model; the same
  idea as the theme screenshots of 2.6.1), in Chromium through Playwright;
- runs **axe-core** (rules tagged `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`) on
  - the five pages (dashboard, inbox, chat, knowledge base, settings) in **all 13 themes**,
  - the inbox tabs, every settings section, the dialogs (search, model hub, studio, new workspace, sources of an
    answer) and the first-start page in one dark and one light theme;
- then checks what axe cannot see: the first Tab reaches "Skip to content" and it moves the focus to the page; a
  button reached with Tab shows a focus ring; every page has one `h1`, no skipped heading level, one `main` and a
  named `nav`; the search and model hub dialogs take the focus, keep Tab and Shift+Tab inside, close with Escape and
  give the focus back to the button that opened them; the chat is a `role="log"` that is not read aloud token by
  token, with a polite status line; at **200 % zoom** (640 × 450 CSS pixels) and at **Windows text size 150 %**
  (853 × 600) no page scrolls sideways and the page keeps at least 320 px next to the sidebar.

It fails on any axe violation, any view that could not be opened, and any keyboard, heading or zoom problem.

```
cd frontend
npx vite build
NODE_PATH=<folder with playwright and axe-core> node scripts/a11y-check.mjs
#   THEMES=dark,light …              only these themes
#   A11Y_OUT=/tmp/a11y.json …        every finding with its elements
#   A11Y_VERBOSE=1 …                 print every element
#   A11Y_CONTRAST_PENDING=light,doodle,flowers …   contrast of these themes reported, not failing (see below)
```

Playwright and axe-core are not in `package.json` (so `npm ci` and the app stay as small as before); CI installs
`playwright@1.64.1` and `axe-core@4.14.0` for this step only.

## Audit before the changes (main at 65b5cc5, axe-core 4.14.0)

115 views checked (5 pages × 13 themes, 25 sections and dialogs × 2 themes).

| Rule | Elements | Views | What it was |
|---|---|---|---|
| color-contrast | 327 | 66 | light themes 267 (fixed on `fix261/theme`), dark themes 60: muted text on cards and table heads, the inbox facts of done letters (opacity 0.72), "possible scam" badges, the chat times in the sidebar (opacity 0.7), white text on bright accent buttons |
| button-name | 22 | 10 | the on/off switches in Settings and "Allow other apps" had no name |
| nested-interactive | 19 | 19 | the System Status header was a button with the refresh button inside it |
| label | 8 | 4 | temperature and Top P sliders, the backup file fields |
| select-name | 2 | 2 | the local model list in Settings |
| aria-required-attr | 2 | 2 | the "Allow other apps" switch had no `aria-checked` |
| **total** | **380** | **86** | 6 rules |

Not found by axe, found by reading the code and by the keyboard checks: no skip link, no `main` landmark, dialogs
without `role="dialog"`, without focus trap and without returning the focus (only two had Escape), the chat rows'
buttons and the folder actions only appeared on mouse hover, the folder headers (sidebar, knowledge base) and the
prompt template cards could only be clicked, focus rings removed by `outline: none` in many fields and buttons, the
streamed answer was not announced at all (and a plain live region would have read every token), toasts vanished
after 5 s even while being read, the dashboard's moving network and all CSS animations ignored "reduce motion",
heading levels jumped from `h1` to `h3` on the dashboard and the knowledge base.

## After the changes

| | Before | After |
|---|---|---|
| axe violations, all themes | 380 elements, 6 rules, 86 views | 260 elements, 1 rule (colour contrast), only in the light themes Daylight Minimal, Doodle Chat and Flower Meadow |
| axe violations, the 10 dark themes | 90 elements | **0** |
| keyboard, headings, zoom checks | (not checked) | 0 problems |

The 260 light-theme elements are the colours that `fix261/theme` (2.6.1 theme fix) changes; they were left alone here
as agreed. Until it is merged, CI runs with `A11Y_CONTRAST_PENDING=light,doodle,flowers`; remove that line in
`checks.yml` after the merge, then the light themes are held to the same rule.

## What was changed

**Keyboard (2.1.1, 2.1.2, 2.4.3, 2.4.7)**
- "Skip to content" link as the first Tab stop; the pages sit in `<main id="main-content">`.
- `useDialog` / `DialogBox`: every dialog (search, documents, document viewer, sources, memory, model hub, prompt
  templates, studio, summary, knowledge base settings, add folder, preview, new workspace) has `role="dialog"`,
  `aria-modal` and a name from its heading; the focus moves in, Tab stays inside, Escape closes, the focus goes back
  to the opener. Dialogs opened from a dialog are stacked.
- Focus ring on every control reached by keyboard (`:focus-visible`, 2 px in the theme's accent, at least 3:1 in all
  themes; system colour in Windows high contrast).
- Chat row actions and folder actions also show while the keyboard is on the row; the folder headers in the sidebar
  and the knowledge base and the prompt template cards have real buttons.
- Menus (export chat, save answer): `role="menu"`, arrow keys, Escape back to the button. Workspace, theme and "move
  to folder" pop-ups close with Escape and say whether they are open (`aria-expanded`). Inbox tabs: arrow keys.

**Screen readers (1.1.1, 1.3.1, 2.4.2, 2.4.6, 3.3.2, 4.1.2, 4.1.3)**
- Landmarks: sidebar `aside`, named main navigation (`aria-current` on the page shown), `main`.
- Names for icon buttons (send, stop, attach, image, templates, page back/forward, refresh), labels for every field
  (settings fields are bound to their labels, message box, rename fields, document search, backup files, switches).
- On/off buttons say their state (`aria-pressed`: knowledge base, web search, web task, theme; `aria-checked`).
- Chat: the message list is `role="log"` with `aria-live="off"` and a name; each message starts with "You wrote:" /
  "StarkLLM answered:" for screen readers. A separate polite status line says "StarkLLM is writing the answer…" when
  an answer starts and reads the finished answer once, as plain text without Markdown, code or tool calls
  (`utils/announce.js`, tested in `tests/announce.test.mjs`). Errors are read the same way.
- Web-task and terminal cards: the state line is a status (working, paused, done), errors and questions are alerts,
  the answer field has a name. Toasts: errors are alerts; a toast stays while the mouse or keyboard is on it (2.2.1).
- Headings in order (one `h1` per page, the dashboard and knowledge base cards are `h2`); decorative images and the
  avatar initials are hidden from screen readers.

**Contrast (1.4.3, 1.4.11)**, dark themes only (`src/a11y.css`)
- `--text-muted` raised in Midnight Indigo (default), Doodle Night, Starry Night and Liquid Glass.
- Text on solid accent backgrounds (`--on-accent`): dark ink where white was below 4.5:1 (Cyberpunk Rose, OLED Pitch Black, Liquid Glass,
  Matrix Emerald, Sunset Volcano, Arctic Frost, Doodle Night, Matrix Code, Starry Night); the gradient buttons too, with a slightly adjusted
  gradient in Midnight Indigo, Liquid Glass and Starry Night so that both ends reach 4.5:1.
- Red warning text `#f87171` on dark badges; done letters keep full contrast (the icon and title show "done").

**Motion (2.3.3, 2.2.2)**: with "Show animations" off in Windows (`prefers-reduced-motion`), CSS animations and
transitions stop (stars, doodles, pulsing dots, spinners, Lucy) and the dashboard's network is drawn once.

**Zoom (1.4.4, 1.4.10)**: checked at 200 % and at Windows text size 150 % (see above); nothing needed changing.

**Translations**: 17 new texts in German, Spanish, French, Italian and Turkish; "StarkLLM logo" is no longer used
(the logo next to the name is decorative).

## What is left

- **Light themes' contrast**: merge `fix261/theme`, then run the check without `A11Y_CONTRAST_PENDING`. The gradient
  buttons of the light themes (white on #6366f1…#8b5cf6, 4.2–4.5:1) should be looked at in the same go.
- **Real screen readers**: NVDA and Narrator on Windows were not run here (no Windows desktop in this setup). To do
  on the GEEKOM: one question with streaming answer (one "writing" line, then the answer once), a web task card, the
  inbox, a dialog (Tab, Escape), the settings switches.
- **Colours axe cannot measure**: text on images and gradients (the starry and doodle backgrounds behind
  transparent cards) is reported by axe as "needs review", not as a violation. The cards are opaque enough in the
  screenshots, but this was not measured.
- **Not every state is reached by the mocked API**: running web tasks and terminal steps, model downloads, the
  phone pairing (desktop app only), error states. Their markup was fixed by reading the code, not checked by axe.
- **Lucy's speech bubble and the guide** were checked by axe only on the pages, not step by step through the guide.
- **Target size, text spacing (1.4.12)** and **reflow at 320 px** were not part of this pass; the desktop window has
  a minimum size.
- The settings sections are a list of buttons with `aria-current`; a proper tab pattern could follow.
