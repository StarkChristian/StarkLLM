# Contributing to StarkLLM

Thank you for helping. StarkLLM keeps people's private letters and documents, so a few rules matter more than usual.

## Before you start

- **Security problems:** do not open an issue; see [SECURITY.md](SECURITY.md).
- **Bugs and ideas:** open an issue with what you did, what you expected, what happened, and the version
  (Settings > About). The engine's log is `%APPDATA%\StarkLLM\engine.log`; remove anything private before you attach it.
- **Larger changes:** open an issue first, so we can agree on the approach before you spend time on it.

## Rules for changes

- **Nothing leaves the PC by surprise.** A new network connection needs a reason, a switch, an entry in
  [docs/privacy-network.md](docs/privacy-network.md), and must go through the network guard (`desktop/netguard.js` in
  the app, `backend/app/core/netguard.py` in the engine). The tests fail otherwise.
- **Text in documents is data, never instructions.** Changes to prompts or tools keep the prompt-injection tests
  (`tests/injection/`) passing.
- **Every user-visible text is translated** (English first; German, Spanish, French, Italian, Turkish). How:
  [docs/adding-a-language.md](docs/adding-a-language.md).
- **Plain words** in the interface: no technical terms where an everyday word works.
- Small pull requests with one topic each are reviewed fastest. Describe what changed and how you tested it.

## Running the tests

```bash
cd desktop && npm ci && npm test                # desktop app (Node)
cd frontend && npm ci && npm test               # app window (React)
cd backend && python -m pytest -q               # engine (Python)
```

The Android app (`mobile/android`) is built and tested by GitHub Actions.

## Licence

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE), like the rest of
StarkLLM.
