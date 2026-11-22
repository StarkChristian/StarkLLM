# Localization plan: the next seven languages, translations and screenshots

Status: plan of 22 November 2026, for the owner's decisions. Nothing here is translated yet: the owner's order of work
(docs/RULES.md and the decision of 16 November 2026) is "English first, technically at launch level, then the
translations, then per-language tests and screenshots, then launch".

## 1. Which languages

The owner decided on 16 November 2026: grow to the **ten most spoken languages of the world, Arabic explicitly
included, Persian excluded**. By total speakers (Ethnologue 2025, as reported by secondary sources; exact figures differ
between editions):

| Rank | Language | Speakers (approx.) | In StarkLLM |
|---|---|---|---|
| 1 | English | 1.5 billion | yes |
| 2 | Chinese (Mandarin) | 1.2 billion | **new**: Simplified Chinese (`zh-Hans`) |
| 3 | Hindi | 609 million | **new** (`hi`) |
| 4 | Spanish | 558 million | yes |
| 5 | Arabic (Modern Standard) | 335 million | **new** (`ar`, right to left) |
| 6 | French | 312 million | yes |
| 7 | Bengali | 284 million | **new** (`bn`) |
| 8 | Portuguese | 267 million | **new**: Brazilian Portuguese (`pt-BR`) |
| 9 | Russian | 253 million | **new** (`ru`) |
| 10 | Indonesian | 252 million | **new** (`id`) |
| – | German, Italian, Turkish | – | yes (kept) |

So **seven new languages**, thirteen in all. Urdu (rank 11) and Japanese (a large Windows market, rank ~13) are the
natural next candidates after these, but they are outside the owner's decision and are only noted here.

### Recommended order (value for a free Windows desktop app × effort)

| Wave | Languages | Why |
|---|---|---|
| A | **Portuguese (Brazil), Russian, Indonesian** | Latin or Cyrillic script, no new fonts, no right-to-left; large Windows desktop markets; the AI models (Qwen) answer well in them |
| B | **Simplified Chinese, Arabic** | very large reach; Chinese needs CJK fonts and line breaking checks; Arabic needs right-to-left layout everywhere (app, website, Android, installer) |
| C | **Hindi, Bengali** | many speakers, but many PC users there use English interfaces; Devanagari and Bengali fonts; the local 7B–14B models are weaker in them, so answer quality must be measured first |

Before each wave: measure answer quality of the recommended local model in that language with the per-language
scenario (section 4). If a language's answers are not good enough, ship the interface with a clear note, not a
promise.

## 2. What has to be translated (per language)

Measured on the current main branch (German as reference):

| Part | Where | Size |
|---|---|---|
| App interface | `frontend/src/i18n/<code>.json` | 1,277 texts, ~7,500 words |
| Desktop dialogs, tray, start screen | `desktop/locales/<code>.json` + `LANGUAGES` in `desktop/i18n.js` | 131 texts, ~1,300 words |
| Android app | `mobile/android/app/src/main/res/values-<code>/strings.xml` | 199 strings, ~1,600 words |
| Google Play listing | `mobile/android/play/<code>/` | ~500 words + 5 screenshots + feature graphic |
| Website | `src/i18n/langs/<code>/*.ts`, `src/content-html/*.<code>.html`, Lucy's FAQ `src/data/lucy-faq/<code>.json` | ~24,000 words |
| Letter rules | `backend/app/services/locale_rules.py` (+ fixture letters and tests) | months, deadline/payment words, letter types, reference labels, scam signs, currency words |
| Studio headings | `HEADINGS` in `backend/app/api/studio.py` | ~30 headings |
| Installer | electron-builder NSIS language list | built-in translations of NSIS; our own texts are in the desktop file |
| Release notes, README section | `RELEASE_NOTES.md`, website download page | per release, short |

About **35,000 words per language**, ~245,000 words for seven. Docs for developers stay English.

Not text, but per language too:

- **OCR**: Tesseract packs `por`, `rus`, `ind`, `chi_sim`, `ara`, `hin`, `ben` exist; the download list in Settings must
  offer them (`ocr_languages.py`).
- **Speech**: recognition (Whisper) knows all seven; reading aloud needs a Piper voice: available for pt-BR, ru, zh,
  ar (check quality), not reliably for hi, bn, id → the read-aloud button is hidden when there is no voice.
- **Fonts**: the website uses Geist (Latin only, self-hosted). Add self-hosted Noto Sans subsets for Arabic,
  Devanagari, Bengali and Simplified Chinese (no Google Fonts CDN: privacy rule); the app uses the system fonts of
  Windows, which cover all seven.
- **Right to left (Arabic)**: the app sets `dir="rtl"` by itself (docs/adding-a-language.md); every screen needs a
  visual check (icons that point, chat bubbles, tables, the web-task card); the website needs `dir="rtl"` and
  mirrored layout; Android needs `supportsRtl` (check) and mirrored icons; the Electron menus and dialogs follow the
  system.
- **Dates, numbers, currencies**: already by `Intl` from the language and region; add the currency words of BRL, RUB,
  IDR, CNY, SAR/AED/EGP, INR, BDT to `CURRENCY_WORDS`.

## 3. How the translations are made (quality first)

1. **Glossary first** (`docs/glossary/<code>.md`): about 60 terms decided once per language — workspace, knowledge
   base, letter, deadline, fully offline, web task, take over, model, engine, inbox, scam … — taken from how Windows
   and well-known apps name them in that language. Every later translation follows it.
2. **Draft by AI** (Claude), file by file, with the glossary and the style rules of the English source (short
   sentences, polite but direct form: *você* in pt-BR, *вы* in Russian, *Anda* in Indonesian, *您* in Chinese,
   *आप* in Hindi, *আপনি* in Bengali, MSA in Arabic).
3. **Automatic checks** (in CI, extending `npm run i18n:check`): every text present, placeholders equal, no English
   left where it should not be, length limits for buttons (the German file is the longest reference), no Latin
   letters in Arabic texts except names and codes, Android XML escaping, website build per language.
4. **Native-speaker review** — the only way to "flawless": per language one reviewer reads the app texts, the website
   and the store listing in context (screenshots), and fixes wording. Options for the owner:
   - paid reviewers (for example on a freelance platform; about 35k words per language at review rates, a few days
     each), or
   - a community review on GitHub (issues "Review: Portuguese texts" with a checklist; slower, free), or
   - a translation platform for open-source projects (Weblate offers free hosting for libre projects; contributors
     then need an account there — the owner decides, because texts would then also live on that platform).
5. **In-context check**: the screenshot pass (section 5) is also the reviewers' material: they see each text where it
   appears.

## 4. Per-language tests (before the screenshots)

As done for the six current languages in the tour (scenario-tour.md):

- **Letters of that country**: five invented letters per language for an invented person — a utility bill, a local
  tax or property tax, a service charge, an insurance letter and a parcel-fee scam (Brazil: IPTU, conta de luz,
  condomínio; Russia: ЖКУ, налог на имущество; Indonesia: PBB, tagihan PLN; China: 物业费, 电费; Arabic: per country
  of the reviewer, e.g. Egypt or the UAE; India: property tax, electricity bill; Bangladesh: holding tax, DESCO bill).
- **Questions in that language**: "What do I have to pay by the end of the year?", "Is the parcel letter genuine?",
  a source check, a web task in that language.
- **Measured**: right amounts and dates, answer in the language, scam named, sources open on the right line.
- **Phone**: the same with the Android app in that language (per-app language of the app; the phone's own settings
  are not changed).

## 5. Screenshots per language (owner rule of 17 November 2026: Windows itself in that language)

What is needed per language:

| Use | Pictures |
|---|---|
| Website product page and help | ~8 app screens (home, inbox, chat with sources, source view, scam warning, deadlines, privacy, phone) |
| Website tour | 8 PC + 5 phone pictures (the existing tour pipeline) |
| Google Play | 5 phone pictures + feature graphic (`mobile/android/play/make-images.js`) |
| Download / install help | installer, first start, "fully offline" question, Smart App Control note (Windows dialogs in that language) |

**Where the Windows pictures are taken** — options for the owner's decision (his PCs stay as they are):

| Option | How | For | Against |
|---|---|---|---|
| **A. Hyper-V on GEEKOM** (recommended) | one Windows 11 virtual machine (Hyper-V is already installed on GEEKOM); per language a snapshot with that display language; the app is installed in it; a script takes the pictures | Windows really in that language, repeatable, nothing changes on the owner's own Windows | needs a Windows 11 image: the 90-day evaluation from Microsoft asks for a short form (owner's step) |
| B. Separate Windows users on the MSI | one local user per language, each with its display language | real hardware, GPU for the AI answers | creating accounts is the owner's step; language packs download per user |
| C. GitHub Windows runner | install a language pack in a CI job | automatic | Windows needs a sign-out to change the display language; runners cannot do that reliably → only app screens, not real Windows dialogs |

**How the pictures are made** (the same for every language, so they match):

1. Same invented data in every language (the letters of section 4, the same workspace names translated).
2. A script drives the installed app with Playwright's Electron support (`_electron.launch`) for the app screens, and
   Windows' own screen capture for installer and system dialogs; the AI answers come from the same model with a fixed
   seed, and each picture is checked by a person before it is used.
3. Phone pictures: the existing tour runner on the Samsung phone, with the app's own language set per run and set
   back afterwards.
4. File names `<code>-<screen>.webp` (as on the website today), Play pictures by `make-images.js`.
5. Review: every picture is looked at for cut-off texts, English left over, right-to-left mistakes (Arabic) and
   wrong dates or currencies.

## 6. Timeline proposal

| Step | Work | Who |
|---|---|---|
| 0 | Decide wave A/B/C, review option (paid, community, platform), screenshot option (A, B or C) | owner |
| 1 | Glossaries for wave A; AI drafts of app, desktop, Android, Play, website | Claude |
| 2 | Automatic checks green; letters and tests per language; model quality measured | Claude |
| 3 | Native review of wave A | reviewers |
| 4 | Screenshots of wave A on Windows in that language; website and Play listing updated | Claude + owner's OK for publishing |
| 5 | Waves B and C the same way; Arabic with a right-to-left review of every screen | Claude + reviewers |

Effort for Claude per language, without waiting for reviewers: about one working session for the drafts and checks,
one for letters and tests, one for screenshots.
