# Adding a language

StarkLLM is not tied to one country. English is the source language and the fallback everywhere; German is the
second interface language. A language has up to five separate parts, and each one can be added alone. Nothing needs to
be wired together by hand.

| Part | What it does | What to add |
|---|---|---|
| 1. Interface | texts of the app, dates and numbers in the language | one file `frontend/src/i18n/<code>.json` |
| 2. Letters | dates, amounts, reference numbers, deadlines, kinds of letters, signs of a scam | fragments in `backend/app/services/locale_rules.py`, plus a fixture letter and a test |
| 3. Photos and scans (OCR) | the Tesseract language | nothing in the code; the user downloads it in Settings (see below) |
| 4. Speech | voice for reading answers aloud; speech recognition | a Piper voice file; recognition already knows about 100 languages |
| 5. Studio | headings of generated documents in the language | optional: a block in `HEADINGS` in `backend/app/api/studio.py` |

The owner decides which interface languages are offered (docs/RULES.md, R2). Parts 2 to 5 do not change the
interface; they make the app useful with letters and documents from other countries.

## 1. Interface language

The English text is the key: `t('Knowledge Base')` returns the translation when the interface language has one, and
the English text otherwise. So a missing translation shows English, never a key.

1. Copy `frontend/src/i18n/de.json` to `frontend/src/i18n/<code>.json` (the code is the ISO 639-1 letter code: `fr`,
   `es`, `it`, `tr`, ...). The key stays English, the value is the translation. `{name}` placeholders must stay the same.
2. Run `cd frontend && npm run i18n:check`. It checks every file in `src/i18n` against every `t('...')` in the code:
   missing translations, texts that are not used any more, placeholders that differ.
3. That is all. The language appears in Settings > Language & Locale with its name in English and in itself (the
   browser knows the names), and it is chosen automatically when the system language is that language. Right-to-left
   languages (`ar`, `fa`, `he`, `ur`) set the page direction by themselves.

Dates, times and numbers follow the language and the region of the system (`frontend/src/i18n/locales.js`): an English
interface on a US system shows `12/15/2026`, on a British one `15/12/2026`, a German interface on an Austrian system
uses Austrian formats. Money is written by `Intl.NumberFormat` with the currency of the amount (`utils/locale.js`).

Tests: `cd frontend && npm test` (choice of language, formats, speech language) and `npm run i18n:check`.

## 2. Letters (rule-based reading)

Everything a letter shows (type, sender, date, reference numbers, amounts, bank accounts, deadlines, warnings) is found
by fixed rules in the document text and carries the page and line it was read from. No language model is involved,
so adding a language cannot make the app invent a value.

All words are in `backend/app/services/locale_rules.py`, one fragment (a regular expression) per language code:

* `MONTH_NAMES[<code>]`: the twelve months. Names without accents are added by themselves (scans lose accents).
* `RULES[<name>][<code>]`: `deadline`, `payment`, `by_date` (the words in front of a date: "avant le", "hasta el"),
  `by_date_after` (for languages that put the word behind the date), `appointment`, `letter_date_label`,
  `document_date_ref` ("facture du"), `fee`, `old_amount`, `from_date`, `replaces`.
* `TYPES`: the words of each kind of letter (reminder, fine, invoice, contract, ...), per language.
* `REFERENCE_LABELS`: "Numéro de client", "Número de póliza", "Müşteri numarası", ...
* `SCAM`: authorities by country, words for vouchers and crypto, urgency, arrest threats, prizes and advance fees,
  secrecy, announcements of a new bank account, and text that gives instructions to an AI.
* `CURRENCY_WORDS`: what is written next to an amount and the ISO code it means.
* `LANGUAGE_NAMES`: the English name of the language, used in prompts ("Write your answer in French").

A date format that is not day-month-year or month-day-year, a number format that is not covered by
`dates_service.parse_number`, or a bank format that is not an IBAN (`document_checks.bank_accounts`) needs a change in
the code, not only in the words.

To prove a language works, add:

1. a fixture letter `backend/tests/fixtures/letters/<code>_<kind>.txt` (a realistic letter: letterhead, address,
   place and date, numbers, amounts, a deadline, an appointment, a bank account);
2. its expected facts in `EXPECTED` in `backend/tests/test_international_letters.py` (type, sender, date, references,
   amounts with number and currency, accounts, dates), and a line for the language in the parametrised tests there
   (deadline sentences, kinds of letters, reference labels);
3. a fake letter and a genuine letter of an authority in `backend/tests/test_international_scams.py`;
4. optionally a block in `backend/scenarios/letters.py` (the generated benchmark; `python3 -m scenarios.letters 300`
   from `backend/` prints recall, precision and amount accuracy).

Run the tests as for every change:

```
docker run --rm -v $PWD:/repo -w /repo/backend <backend image> sh -c "pip install -q pytest; python -m pytest -q tests --ignore=tests/run_rigorous_e2e.py"
```

Known limits: a slash date such as `03/04/2026` is read day first unless the letter itself shows month first (another
date such as `12/15/2026`, or a dollar sign without euro or pound); the currency symbol `$` means US dollars; a
two-digit year is read as 20xx; the Turkish "replaces the letter of ..." has no rule yet.

## 3. Photos and scans (OCR languages)

The program brings Tesseract with English and German. In Settings > Reading photos and scans the administrator picks up
to four languages. A language that is not installed has a Download button: it fetches that one language file (a few MB,
from the official `tessdata_fast` data of the Tesseract project; `OCR_PACK_URL` can point to a mirror) into
`data/tessdata`. Only the language file is requested, nothing about the user or the documents is sent. The bundled
English and German data are never replaced: when a downloaded language is used, Tesseract reads from the data folder,
which also holds links to the bundled files.

The choice is stored in `data/ocr_settings.json`. Without a choice, `OCR_LANGUAGES` (default `eng+deu`) applies. A
page is read again only when it is added again; documents that were read before keep their text. The list of offered
languages is `CATALOG` in `backend/app/services/ocr_languages.py` (Tesseract codes such as `fra`, `spa`, `chi_sim`).

Tests: `backend/tests/test_ocr_languages.py`.

## 4. Speech

* **Speech recognition** (the microphone): Whisper finds the language of the recording itself. The API takes an
  optional `language` hint (`POST /api/v1/voice/transcribe`, form field `language`) for short recordings.
* **Reading aloud**: the voice follows the language of the text (`frontend/src/utils/speech.js` finds it by words and
  letters). English and German voices are built in. For another language put a Piper voice into the folder named by
  `STARKLLM_VOICES_DIR`: the files `fr_FR-siwis-medium.onnx` and `fr_FR-siwis-medium.onnx.json` (voice names are
  `<language>_<REGION>-<name>-<quality>`). `GET /api/v1/voice/voices` lists what is installed. A text in a language
  without a voice is read with the default voice.
* **Studio podcast** uses the voices of the browser; the language of each line is set from the text.

To make the language detector know another language add its word list to `WORDS` in `speech.js` (and letters to
`LETTERS`) and a test in `frontend/tests/speech.test.mjs`.

## 5. Studio and answers

* The answer language follows the question (`language_of` in `backend/app/api/chat.py`); when the question is too short
  to tell, the interface language is used (the app sends it with every message). Names, amounts, dates and reference
  numbers from a document stay as written there.
* Studio texts are written in the interface language. Any ISO code works (`LANGUAGE_NAMES`). Headings the prompts
  name are translated by the model; for a language where the model keeps English headings, add a block to `HEADINGS`
  in `backend/app/api/studio.py` as for `de`.
