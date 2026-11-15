# StarkLLM Document Inbox — Design

Status: **proposal** (roadmap phase B: the PC becomes a private archive for letters and documents).
Date: 9 November 2026.

## 1. Goal

A user gives StarkLLM every letter, bill, contract and notice they receive — scanned, photographed on the phone,
or dropped in as a file. StarkLLM reads it, files it, notices deadlines, and can answer questions about all of it
with the exact page as proof. Nothing leaves the PC.

The phone app (phase C/D) only captures and sends; all reading, filing and answering happens here, so this phase
comes first.

## 2. Principles

1. **Local only.** OCR, classification and extraction run on the PC. No cloud OCR, no model calls outside Ollama.
2. **Every fact has a source.** A sender, an amount or a deadline is only shown if its text is found on a page of
   the document; the UI links to that page. Values a model suggests but the text does not contain are dropped.
3. **The user decides.** StarkLLM suggests a name, a folder and deadlines; the user confirms or corrects. Nothing
   is moved, renamed or deleted without that.
4. **The original is kept.** The photo or scan is stored unchanged next to its searchable text.
5. **Works on an ordinary PC** (16 GB RAM, no GPU required): OCR with Tesseract, extraction with rules first and the
   local chat model only where rules are not enough.
6. **English and German** documents and UI.

## 3. Pipeline

```
 file / scan / phone photo
        │
        ▼
 1. Read      PDF text layer, or OCR (Tesseract deu+eng) for photos and scanned pages,
              with orientation fix and image clean-up; per-page text and confidence
        ▼
 2. Index     chunks with page locators into the search index (as today)
        ▼
 3. Understand  document type (bill, tax notice, contract, reminder, medical letter, …),
              sender, date, reference numbers, amounts, IBAN, deadlines — each with its page
        ▼
 4. File      suggested title and folder; link to earlier documents with the same reference number
              or sender ("case"); duplicates detected by content hash and text similarity
        ▼
 5. Act       deadline list and reminders; "what does this letter want from me?" with citations;
              draft reply
```

## 4. Pull requests

| # | Scope |
|---|---|
| B1 | **OCR that reads German.** One OCR service for photos (JPG, PNG, WebP, TIFF incl. multi-page fax) and scanned PDF pages: Tesseract with `deu+eng`, 300 DPI page rendering, orientation detection, clean-up, confidence. Photos of documents are read as text; the vision model is only used when a picture has no readable text. Docker engine gets the German language data; `/health` reports OCR status. |
| B2 | OCR in the engine without Docker (Tesseract bundled in the Windows package). |
| B3 | **Understanding.** Document facts (type, sender, date, references, amounts, IBAN, deadlines) from German and English rules, plus the local model for type and summary; every value checked against the page text. Stored per document; API. |
| B4 | **Inbox and cases.** Inbox view of new documents with suggested title, folder and deadlines to confirm; case view per reference number or sender; duplicate detection. |
| B5 | **Deadlines.** Deadline list, reminders in the app, calendar export (.ics) on request. |
| B6 | **Protection at rest.** Encrypted document store and database, key in the operating system's key store. Design: [encryption-design.md](encryption-design.md). |
| B7 | **Encrypted backup** to a folder, USB drive or NAS, with a restore test. Design: [encryption-design.md](encryption-design.md). |

Each PR has its own tests. B4 and later UI work builds on the German UI (#55).

Done so far: B1 (#60), duplicate upload and calendar export (#72), B3 and B4 by rules (`facts_service.py`, Inbox page):
type, sender, letter date, reference numbers, amounts, IBANs and dates with page and line; inbox with done/new, own
title, cases per sender, same letter as photo and PDF. Not yet: the local model for type and summary when the rules
find nothing, moving a document to another case from the UI (the API takes `case`), reminders (B5).

B6 and B7 (draft, needs the manual test in `encryption-design.md` on a Windows PC): uploaded documents, message text, profile text,
inbox titles and the text of the search index are stored encrypted (AES-256-GCM) with a key that the desktop app keeps in the
Windows key store; migration with dry run and rollback; one-file encrypted backup (Argon2id passphrase) with an automatic restore test.

## 4b. Languages and countries

The inbox does not assume one country. The rules of B3 (`facts_service.py`, `dates_service.py`, `document_checks.py`)
take their words and formats from `locale_rules.py` for English (US and UK), German (also Austria, Switzerland),
French, Spanish, Italian and Turkish: day-first and month-first dates (`15/12/2026`, `12/15/2026`), month names with or
without accents, `1.234,56` and `1,234.56` and `1 234,56` and `1'234.50`, the currency written next to the amount
(EUR, USD, GBP, CHF, TRY and others; the fact carries the number as written and the ISO code), bank accounts (IBAN,
US routing and account number, UK sort code, Australian BSB, BIC/SWIFT), and the signs of a scam in each language.
Photos and scans are read in the languages the user chose (English and German are bundled, other Tesseract languages
are downloaded on request). A value always stands on a page of the document and is shown with its line.
An ambiguous date (`03/04/2026` with nothing in the letter that says which comes first) is not guessed: both readings are
shown, the user chooses, and it is used for no reminder or calendar entry before that.
How to add a language: [adding-a-language.md](adding-a-language.md).

## 5. Out of scope here

Phone capture and transfer (remote access design, #59), handwriting recognition, legal advice. StarkLLM explains
what a document says and where; it does not give legal advice.
