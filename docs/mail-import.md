# Letters from e-mail

Since 2.8, StarkLLM can take letters that arrive as e-mail attachments (a PDF from the tax office, a photo of a form,
a Word file) and put them into a workspace by itself, so they are read like any uploaded document. This page says
what it does, what it never does, and how it is built. Settings › **Letters from e-mail**.

## What the user sets

| Setting | Meaning | Default |
|---|---|---|
| Server, port | the IMAP server of the mail provider, for example `imap.gmail.com`, `993` | - |
| Encryption | **IMAPS** (TLS from the first byte, usually port 993) or **STARTTLS** (port 143, encrypted before the login). There is no choice without encryption | IMAPS |
| User name | usually the e-mail address | - |
| Password | the password or an **app password** of the mail account (see below) | - |
| Folders | which folders are watched (`INBOX` and, for example, a folder "Letters"); "Show folders" lists them from the server | `INBOX` |
| Workspace | where the letters go | - |
| Only from these senders | optional: full addresses (`post@finanzamt.example`) or domains (`@finanzamt.example`) | empty = all |
| Only with these words in the subject | optional | empty = all |
| Check every … minutes | 5 to 1440 | 15 |
| Mark imported mails as read | sets the flag "seen" on a mail whose attachments were imported | **off** |

With both filters empty every new mail with an attachment is looked at. With one or both filled in, a mail is
imported when the sender **or** the subject matches. A sender address can be forged by anybody: the filter keeps the
workspace tidy, it does not prove who sent a letter. Every imported letter still gets the checks for scams and for
notes to the AI.

## What is imported

* **Only attachments**: PDF, pictures (JPEG, PNG, WebP, TIFF) and Word (`.docx`). Pictures that belong to the text of
  the mail (logos and signatures with a Content-ID) and every other type are left out. A file that does not look like
  its type (a "PDF" that is not one) is listed as skipped.
* **The text of the mail is never stored.** The mail is read into memory, the attachments are taken out, the rest is
  dropped. The import history keeps the sender, the subject, the date, the file name and the content hash.
* **Only new mail**: mails that arrived after the account was added. "Import older messages" asks for a start date and
  then imports the mails from that day until the account was added, once.
* **Duplicates** are skipped by content hash: the same letter in two mails or two folders, or a letter that was already
  uploaded by hand, is kept once. The history lists it as "already there".
* Each attachment goes through the **normal upload pipeline** (`documents.store_document_bytes`): protection at rest
  (encrypted on disk when protection is on), text and OCR, facts and deadlines, the scam check and the check for
  notes to the AI (`app/services/untrusted.py`, `document_checks.py`).

## What it never does on the mail server

* The folder is opened with **EXAMINE** (read-only), and mails are read with **BODY.PEEK**, which does not change the
  "seen" flag. `ReadOnlyMailbox` in `app/services/mail_import.py` is the only way the importer talks to the server; it
  refuses `BODY[]` and `RFC822` (which would mark a mail as read) before they are sent.
* No **STORE, EXPUNGE, MOVE, COPY, APPEND, DELETE**: nothing is moved, deleted or written. The one exception is the
  user's own switch "Mark imported mails as read" (off by default): then the folder is opened with SELECT and the flag
  `\Seen` is set on a mail whose attachments were imported, nothing else.
* **Nothing is ever sent.** StarkLLM has no SMTP code.

## The password

* It is kept **only in the Windows key store of the desktop app**: Electron `safeStorage`, which on Windows is DPAPI
  (only this Windows user on this PC can open it), the same store that holds the data key of protection at rest. File:
  `mail-secrets.json` in the app's profile folder, each password wrapped by DPAPI (`desktop/mail-secrets.js`).
* The page hands it to the desktop app once (`window.starkllmDesktop.mail.setPassword`), and never gets it back.
* The engine gets it **in memory** from the desktop app after the start (`POST /api/v1/mail/internal/passwords`,
  which only the desktop app can call: its token is derived from the engine's secret). The engine never writes it to
  the database, a file or a log; the account endpoints have no password field at all, and an unknown field is
  refused. When the app quits, it asks the engine to forget the passwords.
* In a plain browser (engine without the desktop app) there is no safe place for a password: Settings says so and
  does not offer to add an account.
* Test: `backend/tests/test_mail_import.py::test_the_password_is_never_written_to_the_database_files_or_logs` searches
  the database file, the network log, the uploads and the log records for the password; `desktop/test/mail-secrets.test.js`
  checks the file of the desktop app.

## Network and privacy

* A new network use, feature **`mail_import`**: through `app/core/netguard.py` (`netguard.imap`), recorded in the
  network log (host and port, never a folder, a sender or a subject), listed in
  [privacy-network.md](privacy-network.md) (E13).
* **TLS is required**: IMAPS or STARTTLS, with the certificate and the host name checked and at least TLS 1.2. A server
  without STARTTLS never gets the login; a certificate Windows does not trust is an error, never a fallback.
* **"Fully offline" stops it**: no check runs and "Check now" says why.
* The check runs every N minutes **only while StarkLLM runs** (a thread of the engine; it starts 90 seconds after the
  engine, so the first answers and the unlock come first). `STARKLLM_MAIL_IMPORT=off` turns the schedule off.

## Prompt injection

E-mail is one of the main ways text written for an AI reaches a user. So:

* the imported attachments get the same checks as every upload (red box for notes to the AI, scam check);
* **sender and subject are untrusted text**: invisible and control characters are removed before they are stored, a
  subject or sender that is written to an AI assistant is marked in the history, and they are **never given to a
  model**. They are stored only in the import history (`mail_imports`), which only the importer and the Settings page
  read (a test checks that no other code uses it). The document is named after the attachment, not after the subject.

## Gmail, Outlook and OAuth2

OAuth2 sign-in ("Sign in with Google / Microsoft") is **not built in this version**. The engine has `oauthlib`, but
OAuth2 for mail also needs an OAuth client registered by StarkLLM with Google and Microsoft, a browser sign-in flow in
the desktop app and a safe place for the refresh token. Google treats full mail access (`https://mail.google.com/`) as
a restricted scope that needs a verification and a yearly security assessment. That is a project of its own.

What works today:

* **Gmail**: turn on 2-Step Verification, create an **app password** (Google account › Security › App passwords) and
  use it as the password, server `imap.gmail.com`, port 993, IMAPS. IMAP access must be on in Gmail's settings.
* **Other providers** (GMX, WEB.DE, Posteo, mailbox.org, T-Online, iCloud, Yahoo, your own server): IMAP with the
  password or an app password, as the provider describes it.
* **Outlook.com, Hotmail and Microsoft 365**: Microsoft no longer accepts a password for IMAP (only OAuth2), so these
  accounts cannot be used yet. A forwarding rule to another mailbox is a way around it.

The plan for OAuth2 (not decided): a public OAuth client per provider, the sign-in in the user's own browser with PKCE
and a loopback redirect to the desktop app, the refresh token wrapped by `safeStorage` like the password, the engine
gets a short-lived access token in memory and logs in with `AUTHENTICATE XOAUTH2` (part of Python's `imaplib`, no new
dependency); the Google verification has to be done before it can ship.

## Where it is

| Part | File |
|---|---|
| Import, schedule, read-only mailbox | `backend/app/services/mail_import.py` |
| API (Settings) and the internal password endpoint | `backend/app/api/mail.py` |
| IMAP with TLS, network log, offline rule | `backend/app/core/netguard.py` (`imap`) |
| Database | `mail_accounts`, `mail_imports` in `backend/app/db/models.py` |
| Upload pipeline for the attachments | `backend/app/api/documents.py` (`store_document_bytes`) |
| Password store of the desktop app | `desktop/mail-secrets.js`, IPC `mail:*` in `desktop/main.js` |
| Settings page | `frontend/src/components/MailImportSettings.jsx` |
| Tests | `backend/tests/test_mail_import.py` (fake IMAP server), `desktop/test/mail-secrets.test.js`, `frontend/tests/mailImport.test.mjs` |
