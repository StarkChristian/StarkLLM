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
- No internet connection is made without the user's choice (model downloads, update check, web search, Telegram).
- Text inside documents is treated as data, never as instructions; letters that try to instruct an AI assistant are
  flagged.

A way around any of these is a vulnerability.
