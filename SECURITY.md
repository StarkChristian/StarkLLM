# Security

StarkLLM keeps people's private letters and documents. Reports about security problems are welcome and are handled
before other work.

## Reporting

Please report a vulnerability privately through GitHub: **Security > Report a vulnerability** in this repository.
Do not open a public issue for it. Include what you found, how to reproduce it, and which version you used.

You get an answer within 7 days. A confirmed problem is fixed in the next release, or sooner with a patch release;
the release notes name it once users can update.

## Supported versions

Only the latest release gets security fixes. StarkLLM updates itself; please keep updates on.

## What StarkLLM is designed to do

- The engine listens on `127.0.0.1` only; other computers cannot connect.
- Other programs on the same PC can use StarkLLM only after the user turns this on and creates a key
  (Settings > Other apps); keys are stored as hashes.
- No internet connection is made without the user's choice (model downloads, update check, web search).
- Every connection the app and its engine make is listed in Settings > Privacy & network, and the "Fully offline"
  switch there refuses all of them (see [docs/privacy-network.md](docs/privacy-network.md); how to check it yourself:
  [docs/verify-privacy.md](docs/verify-privacy.md)).
- Uploaded documents, chat messages and the text of the search index can be stored encrypted (Settings > Protection); the key
  lives in the Windows key store of the user's account and never in the data folder. What this does and does not protect is
  written down in [docs/encryption-design.md](docs/encryption-design.md).
- Backups (Settings > Backup & Restore) are one file encrypted with a passphrase, tested by restoring them into a temporary folder.
- Text inside documents is treated as data, never as instructions; letters that try to instruct an AI assistant are
  flagged, text hidden in a file is left out, and a tool runs only after the user's click. A public set of 73 documents
  in 14 languages (`tests/injection/`) is part of the tests.

A way around any of these is a vulnerability.
