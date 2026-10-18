# StarkLLM Desktop (v2.0.0)

**Version:** StarkLLM Desktop v2.0.0  
**License:** Apache 2.0 (Open Source)  
**Package:** `StarkLLM-v2.0.0-Setup.exe` (SHA-256: `e6b29e6b77788dfd85eaa1e3e96634f38c97f1d4ed993b6ff6057340d4a457b5`)  
**Portable:** `StarkLLM-v2.0.0-Portable.exe` (SHA-256: `a0c8b569d554ee345802f832ece80fad01f4db378c126576ac6685be78aaeda9`)  
**Official Website:** [https://www.starkllm.com](https://www.starkllm.com)  
**Documentation & Manual:** [https://www.starkllm.com/manual.html](https://www.starkllm.com/manual.html)

**StarkLLM Desktop** is a private, local-first native desktop AI assistant designed for Windows developers, researchers, and technical professionals. It runs in its own **standalone native desktop application window** (similar to Cursor and Claude Desktop—no web browser tabs or address bar needed).

StarkLLM is **completely free** and **open source** under Apache 2.0. It features an integrated Retrieval-Augmented Generation (RAG) engine, in-process local tool calling (MCP Host), folder chat organization, 8 handcrafted visual themes, universal conversation export, and real-time hardware VRAM monitoring—all running 100% on your own PC.

By leveraging Docker Desktop and Ollama on localhost, StarkLLM enforces a strict zero-cloud architecture. Your files, documents, and chats never leave your machine.

---

## What's New in v2.0.0

- 🖥️ **Standalone Native Desktop App**: Runs as an independent desktop window with dark theme framing, tray menu, and launch splash screen—not as a browser tab.
- 📁 **Chat Folders & Organization**: Organize sessions into custom collapsible folders (e.g., "Research", "Legal Briefs", "Code Reviews").
- 💾 **Universal 4-Format Export**: Export any conversation into Markdown (`.md`), clean JSON (`.json`), standalone styled HTML (`.html`), or plain text (`.txt`) with preserved citations and timestamps.
- 🎨 **8 Curated Visual Themes**: Instant hot-swapping between Midnight Indigo, OLED Pitch Black, Liquid Glass, Cyberpunk Rose, Matrix Emerald, Sunset Amber, Arctic Frost, and Daylight Minimal.
- 🌐 **Demographic Language Roadmap**: 4-tier internationalization engine prioritized strictly by global internet demographics (Tier 0: English, Tier 1: Chinese & Spanish, Tier 2: French & German, Tier 3: Arabic & Persian/Farsi, Tier 4: Portuguese, Russian, Japanese) with zero regional script clutter.
- 📊 **Hardware Telemetry & Live VRAM Dashboard**: Real-time GPU video memory tracking, container status monitor, indexed chunk counters, and recent chats quick jump list.
- 🛡️ **Safe In-Process Local Tools (MCP Host)**: Read-only local tools (`list_workspace_files`, `search_local_kb`, `fetch_cited_chunk`) with human confirmation cards, single-use invocation tokens, and prompt injection defense.

---

## Requirements

To run StarkLLM smoothly, you need:
- **OS**: Windows 10 or 11 (with WSL2 enabled)
- **Software**: 
  - **Docker Desktop** (running and configured with WSL2 integration)
  - **Ollama** (installed natively on your Windows host from [ollama.com](https://ollama.com))
- **Hardware**:
  - **Minimum**: 8 GB RAM (for 3B models such as `qwen2.5:3b`)
  - **Recommended**: 16 GB+ System RAM, NVIDIA GPU with 8GB+ VRAM (for 7B models such as `qwen2.5:7b`)
  - **Storage**: Fast SSD with at least 30GB free space for containers and model weights.

---

## Recommended Models

Before launching StarkLLM, pull the recommended local models via terminal:

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

### Option A: Windows Installer (Recommended)
1. Download `StarkLLM-v2.0.0-Setup.exe` from [starkllm.com/download.html](https://www.starkllm.com/download.html).
2. Run the setup wizard to install StarkLLM and create desktop shortcuts.
3. Click the **StarkLLM** desktop shortcut. Local services start automatically and the native desktop application window appears.

### Option B: Portable Zero-Install Executable
1. Download `StarkLLM-v2.0.0-Portable.exe` and double-click to launch directly.

### Option C: Developer / Source Launch
1. Ensure Docker Desktop and Ollama are running.
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
Get-FileHash -Algorithm SHA256 StarkLLM-v2.0.0-Setup.exe
# Target: e6b29e6b77788dfd85eaa1e3e96634f38c97f1d4ed993b6ff6057340d4a457b5
```

---

## License

StarkLLM is licensed under the [Apache License, Version 2.0](LICENSE).  
Copyright &copy; 2026 Christian Stark.
