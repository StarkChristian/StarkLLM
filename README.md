# StarkLLM Desktop (v2.3.0)

**Version:** StarkLLM Desktop v2.3.0  
**License:** Apache 2.0 (Open Source)  
**Package:** `StarkLLM-v2.3.0-Setup.exe`, signed by "Open Source Developer Christian Stark" (SHA-256: published with the release)  
**Official Website:** [https://www.starkllm.com](https://www.starkllm.com)  
**Documentation & Manual:** [https://www.starkllm.com/manual.html](https://www.starkllm.com/manual.html)

**StarkLLM** is a free, open source assistant for your own documents and letters on Windows. It runs in its own desktop
window, reads your PDFs, Word files, e-books, presentations, photos and scans on your PC, answers questions about them
with the page it found the answer on, and lists the deadlines and amounts in your letters. The AI models run on your PC
through Ollama.

Your files, documents and chats stay on your machine. A few optional features go online only when you turn them on or
start them: web search (DuckDuckGo), a cloud model provider in Settings (DeepSeek, OpenRouter, Groq, ...), YouTube and
GitHub import, market prices, and the update check. The chat shows when a question leaves your PC, Settings > Privacy &
network lists every connection, and the "Fully offline" switch refuses all of them.

---

## What it does

- 📄 **Questions about your documents** with the page and line each answer comes from; quotations that are not in your documents are flagged.
- 📚 **Whole documents and books:** summaries per chapter are built in the background, so "Summarize the book" works too. EPUB e-books by chapter, PowerPoint by slide.
- 📬 **Inbox:** kind of letter, sender, reference numbers, amounts and deadlines of every letter, found word for word; warnings for possible scam letters.
- 📅 **Deadlines** with reminders and calendar export (.ics).
- 🔒 **Protection at rest (optional)** for documents, chats and the search index, and an **encrypted backup** you can keep anywhere.
- 🛡️ **Safe local tools (MCP host)** that run only after your click; text inside documents is treated as data, never as instructions.
- 🎨 **13 themes**, among them five with drawn patterns, and **Lucy**, a helper robot you can switch off.
- 🌐 **Languages:** the app speaks English, German, Spanish, French, Italian and Turkish (a new language is one translation file, see [docs/adding-a-language.md](docs/adding-a-language.md)). Answers follow the language of your question.
- ⚡ Runs on NVIDIA graphics cards and on integrated AMD Radeon / Intel Arc graphics; no Docker needed.

What changed in each version: [RELEASE_NOTES.md](RELEASE_NOTES.md).

---

## Requirements

To run StarkLLM smoothly, you need:
- **OS**: Windows 10 or 11 (64-bit)
- **Software**:
  - **Ollama** for the AI models: StarkLLM offers "Install Ollama for me" and installs the official, signed version itself (or get it from [ollama.com](https://ollama.com))
  - Nothing else. Since v2.2 the engine is part of the installer; **Docker Desktop is no longer needed**. People who already run Docker Desktop can still choose it in the tray menu ("Use Docker Desktop for the engine (advanced)").
- **Hardware**:
  - **Minimum**: 8 GB RAM (for 3B models such as `qwen2.5:3b`)
  - **Recommended**: 16 GB+ System RAM, NVIDIA GPU with 8GB+ VRAM (for 7B models such as `qwen2.5:7b`)
  - **Storage**: Fast SSD with at least 15 GB free space for the app, the engine and the model weights.

---

## Recommended Models

StarkLLM picks and downloads models that fit your PC on the first start; you do not need a terminal. To choose
yourself, Settings has a model list, or pull them with Ollama:

```bash
# Recommended default model pair:
ollama pull qwen2.5:7b
ollama pull nomic-embed-text
```

*Hardware tiers & alternatives:*
- **Standard (16GB RAM / 8GB+ VRAM):** `ollama pull qwen2.5:7b` + `ollama pull nomic-embed-text`
- **Lightweight (8GB RAM laptops):** `ollama pull qwen2.5:3b` + `ollama pull nomic-embed-text`
- **Power Workstations (32GB+ RAM / 16GB+ VRAM):** `ollama pull qwen2.5:14b`
- **Multimodal / Vision:** `ollama pull llava`

---

## Installation & Launch

### Before the first start
Nothing to install beforehand. If Ollama is missing, StarkLLM offers "Install Ollama for me" and installs the official, signed version itself. You do not need to open a terminal: StarkLLM starts its engine and Ollama and downloads the AI models itself.

### Option A: Windows Installer (Recommended)
1. Download `StarkLLM-v2.3.0-Setup.exe` from [starkllm.com/download](https://www.starkllm.com/download) or the GitHub release. It is signed by "Open Source Developer Christian Stark".
2. Run the setup wizard and start StarkLLM from the desktop shortcut.
3. **The first start downloads the AI models** (about 5 GB, depending on your graphics card; the splash screen shows the progress). The engine itself comes with the installer. Later starts take seconds.
4. If something is missing (Ollama, a busy port, ...), the window says what and how to fix it; the log is in `%APPDATA%\StarkLLM\engine.log`.

### Option B: Developer / Source Launch
1. Ensure Docker Desktop and Ollama are running (the source launch builds the engine with Docker; the installer is the way without Docker).
2. In the repository folder, execute:
   ```cmd
   start.exe
   ```
   *(or `start.cmd`)*
3. The launcher coordinates container startup and launches the native Electron application window.

---

## Verification & Checksums

To verify file integrity before running, compare the SHA-256 hash in PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 StarkLLM-v2.3.0-Setup.exe
# compare with the SHA-256 listed on the GitHub release page
```

---

## Code signing policy

Releases are signed with a Certum Open Source Code Signing certificate issued to "Open Source Developer Christian Stark" (the key is in Certum's cloud, SimplySign; every signing session is confirmed on the owner's phone).

- **What is signed:** `StarkLLM.exe`, its uninstaller and the Windows installer. The app is built by GitHub Actions ([desktop-release.yml](.github/workflows/desktop-release.yml)) from a tagged commit of the `main` branch; the signatures are added on the owner's PC ([docs/signing-on-owner-pc.md](docs/signing-on-owner-pc.md)), and the app checks that every update carries the same publisher name. Files of other open source projects that the app ships unchanged (Electron and Chromium libraries, NSIS installer plugins) keep their authors' signature, or none.
- **Committers and reviewers:** [Christian Stark (StarkChristian)](https://github.com/StarkChristian). Changes from other contributors are reviewed by a committer before they are merged.
- **Approvers:** [Christian Stark (StarkChristian)](https://github.com/StarkChristian). Every release is approved by hand before it is signed.
- Everyone in these roles uses multi-factor authentication for GitHub and Certum SimplySign.
- **Privacy:** This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it. The optional online features and the one-time downloads on the first start are listed on the [privacy page](https://www.starkllm.com/tech-privacy). The program has no telemetry.

Details: [www.starkllm.com/code-signing](https://www.starkllm.com/code-signing) and [docs/code-signing.md](docs/code-signing.md).

---

## License

StarkLLM is licensed under the [Apache License, Version 2.0](LICENSE).  
Copyright &copy; 2026 Christian Stark.
