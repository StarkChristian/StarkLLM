# StarkLLM Packaging Guide

This document describes how to create a clean, distributable zip package of StarkLLM for the Windows Research Beta release. 

## Building the Windows Setup Installer (.exe)

To generate the single-file setup wizard installer (`StarkLLM-v1.0.0-beta-Setup.exe`):

1. Run **`.\build-installer.ps1`** with PowerShell.
2. The script will:
   - Generate the application icon from `Logo.png`.
   - Recompile the Go launcher (`start.exe`).
   - Stage clean files (excluding caches, `data/`, `venv`, `node_modules`).
   - Compile the Inno Setup script ([installer/starkllm.iss](file:///c:/Users/chris/Documents/anti%20gravity/StarkLLM/installer/starkllm.iss)).
   - Output the installer `.exe` into `dist/` and sync to `website/downloads/StarkLLM-Setup.exe`.

---

## Automated Packaging (Portable Zip)

To build the portable zip archive (`StarkLLM-v1.0.0-beta.zip`), run the helper script:

1. Run **`.\package-release.ps1`** in PowerShell.
2. Enter the version number when prompted (e.g., `1.0.0-beta`).
3. The script will automatically create the clean zip file in the project root, safely excluding sensitive local data, caches, and `node_modules`.

---

## Manual Packaging (Reference)

If you prefer to zip the package manually, adhere strictly to the following Inclusion and Exclusion lists to avoid leaking private data.

### 1. Inclusion List
The release zip **must include** these files and directories:
- `backend/` (source code)
- `frontend/` (source code)
- `docker-compose.yml`
- `start.bat`
- `start.cmd`
- `unblock.bat`
- `README.md`
- `RELEASE_CHECKLIST.md`
- `PACKAGING.md`
- `.env.example`

### 2. Exclusion List
The release zip **must NOT include**:
- `data/` directory (contains SQLite database, Vector DB chunks, and uploaded documents)
- `knowledge_base_data/` directory (user's personal mapped KB files)
- `.env` file (contains your local environment configuration or secrets)
- `node_modules/` or `dist/` inside frontend
- `venv/`, `.venv/`, `.pytest_cache/`, or `__pycache__/` inside backend
- `.git/` or `.gitignore`
- Any temporary IDE files (`.vscode`, `.gemini`, `scratch`, screenshots, test scripts)

---

## Sanity Notes for Distribution

When distributing the package or writing release notes on GitHub/starkllm.com, always add these explicit notes:

- **Requirements**: Users must install **Docker Desktop** and **Ollama** independently before running `start.bat`.
- **Status**: This is a **Research Beta**.
- **License/Cost**: StarkLLM is **completely free** and **open source**.
- **Liability**: The software is provided "as is", with no warranty and no liability for data loss.
