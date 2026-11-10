# Rules

The rules StarkLLM's development follows, why each one exists, how it is checked, and when it is looked at again.
How changes are made is in [CHANGES.md](CHANGES.md).

## How a rule gets here, and how it leaves

Rules have a cost: every rule slows work down a little, and rules nobody checks are forgotten or followed blindly. So:

1. **One mistake is fixed, not ruled.** When something goes wrong, fix the cause and add a test that would have caught
   it. A new rule is added only when the harm is severe (data loss, security, privacy, legal) or the same kind of
   mistake happened again.
2. **Remove the cause before writing a rule.** If a file can be committed by mistake, ignore it in `.gitignore`
   instead of asking everyone to remember not to commit it.
3. **A check beats a rule.** Prefer a test or a CI check that runs by itself over a rule people must remember. A
   rule that cannot be checked says how it is reviewed instead.
4. **Narrow, not blanket.** A rule names the files, situations or releases it applies to. "Never" and "always" need
   a reason that holds in every case.
5. **Every rule has a reason and a review.** Each entry below says why it exists (with the incident or decision) and
   when it is looked at again. Rules are reviewed with every release (see the release checklist); a rule that no
   longer pays off is changed or removed, and the change is recorded under *Changed or removed* below.

## Rules in force

| | Rule | Why | Checked by | Review |
|---|---|---|---|---|
| R1 | Every merge into `main` and every release is approved by the owner, per pull request. | The owner decides what users get. | GitHub (no direct pushes to `main`). | When a second maintainer joins. |
| R2 | Repository and website contain English and German only; no Persian or Arabic text. | Decision by the owner (2026-11-08): the project's languages are English and German. | `scripts/check-languages.py` in CI. | When a new UI language is planned. |
| R3 | Every pull request passes **Checks**: backend tests, German UI check, frontend build, language check. | The tests existed but ran only on one developer's machine; a crash in 2.0.10 (toasts, theme list) would have been caught by a check. | `.github/workflows/checks.yml`. | Each release: is a check slow or flaky? Fix or drop it. |
| R4 | A change to how answers are made (prompt, retrieval, document checks) is measured with `backend/scenarios` before and after, with the same model, and the numbers go into the pull request. | Answer quality cannot be judged from one or two tries; the first scenario run found that prompts were cut off without anyone noticing. | The pull request template; the deterministic part (dates, warnings) also runs in **Checks**. | When a faster or larger model is available for the runs. |
| R5 | A change to the installer, the updater, the engine start or stored data is tested by the Windows CI and once on a real Windows PC (fresh install and update from the last release) before it is released. | Installer and update problems reach users who cannot fix them (2.0.8 update, installer crash in 2.0.9). | Desktop (Windows) workflow; release checklist. | Each release. |
| R6 | **Code signing, in two steps.** Until StarkLLM has a code-signing certificate, releases are unsigned and the *Windows trust* workflow reports which files Smart App Control would block. Once there is a certificate, every Windows executable file is signed, and the workflow must find none. | Smart App Control blocks unsigned files (seen with 2.0.8 and 2.0.10). Requiring signatures before a certificate exists would stop all releases. | `windows-trust.yml` (audit report now, a hard gate with the certificate). | When the certificate arrives. |
| R7 | The engine listens on `127.0.0.1` only, and StarkLLM opens no internet connection the user did not choose (model and engine downloads, update check, web search, Telegram, other apps are each the user's choice). | The product promise: nothing leaves the PC unless the user decides so. | `test_privacy_defaults.py`, review of every new network call (pull request template). | Each release. |
| R8 | What StarkLLM shows as facts from a document (dates, amounts, bank accounts, warnings) is found by rules and stands word for word in the document. The language model's answers are measured, not trusted. | A small model invents numbers; rules do not. | `test_document_home.py`, `test_document_checks.py`, the scenario set. | When the facts extraction (B3) changes. |
| R9 | Warnings about letters are judged both ways: a missed scam and a false alarm on a genuine letter are both regressions. | An assistant that warns about everything is ignored as surely as one that warns about nothing. | The scenario set (`warn` and `warn_none`), `test_document_checks.py`. | With every new kind of warning. |
| R10 | In a file that uses the translator `t`, no callback parameter is named `t`. | It hid the translator and crashed toasts, templates and the theme list in 2.0.10. | `frontend/scripts/check-i18n.mjs` in CI. | Keep while the translator is called `t`. |
| R11 | Secrets (keys, tokens, passwords) are never logged, printed or committed; keys for other apps are stored as hashes. | Logs and screenshots are shared when asking for help. | Review (pull request template). | Each release. |

## Changed or removed

| Date | Rule | Change | Why |
|---|---|---|---|
| 2026-11-11 | Roadmap: "No file is published without a signature, every release passes enforced App Control." | Replaced by R6 (two steps). | Without a certificate it would block every release. |
| 2026-11-11 | `RELEASE_CHECKLIST.md`: start with `start.bat`, create an account. | Rewritten for the desktop app. | The desktop app starts the engine itself and needs no account. |
| 2026-11-11 | Working note: "never `git add -A` in the website deploy checkout". | To be replaced by a `.gitignore` in the deploy branch for the local files (`downloads/`, `*.bak`, `server.log`). | Remove the cause instead of remembering a rule (principle 2). |
| 2026-11-11 | Chat prompt: English trigger words ("file", "report", "page", ...) switch on a strict "documents only" mode. | Under review with the scenario set. | A general request such as "write a short report about the Rhine" may be refused as "not in your documents". |
