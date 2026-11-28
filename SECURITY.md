# Security

StarkLLM keeps people's private letters and documents. Reports about security problems are welcome and are handled
before other work.

## Reporting a vulnerability

Please report it privately, in one of two ways:

1. **GitHub private vulnerability reporting** (preferred): **Security > Report a vulnerability** in this repository
   (<https://github.com/StarkChristian/StarkLLM/security/advisories/new>). Only the maintainer sees the report.
2. **E-mail** to **info@starkllm.com**, subject starting with `SECURITY`. English or German.

Do not open a public issue, pull request or discussion for it. Include what you found, how to reproduce it, which
version of StarkLLM and of Windows you used, and whether you know of anyone using it in attacks.

We do not take legal action against people who look for vulnerabilities in good faith, report them privately, and
give us the time below to fix them before they publish.

## What happens then (response times)

| Step | When |
|---|---|
| We confirm that we received your report | within **3 working days** |
| First assessment: is it a vulnerability, how severe, which versions | within **7 days** |
| Fix for a vulnerability that is **actively exploited** | as fast as possible, as a signed patch release; we aim for **within 7 days** |
| Fix for a critical or high vulnerability | aim: within **30 days** |
| Fix for a medium or low vulnerability | in the next regular release, at the latest within **90 days** |

We keep you informed while we work on it and agree with you on the day of publication. A fixed vulnerability is
named in the release notes and, where it helps users, in a GitHub security advisory (with a CVE). You are credited
unless you ask us not to.

## Supported versions

| Version | Security fixes |
|---|---|
| Latest release (currently 2.6.x) | yes |
| Older releases | no: please update |

StarkLLM updates itself; please keep updates on. A security fix is always shipped as a new, signed release of the
latest version, also outside the usual release rhythm.

## Reporting to the authorities (EU Cyber Resilience Act)

Since 11 September 2026, the EU Cyber Resilience Act (Regulation (EU) 2024/2847, Article 14) requires manufacturers to
report **actively exploited vulnerabilities** and **severe incidents** affecting the security of their product.
StarkLLM reports them through **ENISA's Single Reporting Platform** to the responsible national CSIRT and to ENISA:
an early warning within **24 hours** of becoming aware, a notification within **72 hours**, and a final report
(14 days after a fix is available for a vulnerability; one month for an incident). Users are informed about the
vulnerability and what to do. The internal steps are in [docs/security-process.md](docs/security-process.md).

> **TODO (owner, legal check before merge):** (1) whether and in which role the CRA applies to StarkLLM (free
> open-source software; "manufacturer" or "open-source software steward"; commercial activity, e.g. donations or
> paid services); (2) the response times promised above; (3) the good-faith sentence ("no legal action") under
> the applicable law. Remove this note when checked.

A machine-readable contact for the website (RFC 9116) is in [docs/security.txt](docs/security.txt).

## What StarkLLM is designed to do

- The engine listens on `127.0.0.1` only; other computers cannot connect to it.
- The phone link (Settings > Phone, off by default; not in 2.3.0) is the one exception: when the user turns it on, the
  desktop app accepts connections from the home network, for paired phones only. TLS with the app's own certificate,
  pinned by the phone from the QR code; a single-use pairing code; a random token per phone, stored as a hash; and an
  allow-list of engine calls per access level. "Fully offline" closes it. Design and limits:
  [docs/android-companion.md](docs/android-companion.md).
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
