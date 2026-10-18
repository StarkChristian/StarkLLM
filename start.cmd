@echo off
setlocal enabledelayedexpansion
title StarkLLM Launcher (Windows Research Beta)
cd /d "%~dp0"

echo ==================================================
echo              StarkLLM Windows Launcher            
echo           Windows Research Beta — Phase 1         
echo ==================================================
echo.

rem 1. Check docker-compose.yml exists
if not exist "docker-compose.yml" (
    echo [ERROR] docker-compose.yml not found in "%~dp0".
    echo Please make sure all extracted files are in the same folder.
    echo.
    pause
    exit /b 1
)

rem 2. Check Docker Desktop & WSL2 status
echo [1/5] Checking Docker Desktop status...
docker info >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Docker Desktop is not running or not responsive.
    echo.
    echo Remediation steps:
    echo  1. Open Docker Desktop from the Start Menu.
    echo  2. Ensure the WSL2 backend is enabled (Settings -^> General).
    echo  3. Wait until the whale icon in the taskbar is steady, then run start.cmd again.
    echo.
    pause
    exit /b 1
)
echo   -^> Docker Desktop is running.

rem 3. Check Ollama reachability
echo [2/5] Checking Ollama service (http://localhost:11434)...
curl.exe -sf --max-time 3 http://localhost:11434/api/tags >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [WARNING] Ollama is not running or unreachable on http://localhost:11434.
    echo           StarkLLM requires Ollama for local LLM inference and embeddings.
    echo           Please ensure Ollama is installed from https://ollama.com and running.
    echo           Recommended models:
    echo             ollama pull qwen3.8:27b
    echo             ollama pull qwen3-embedding:0.6b
    echo.
) else (
    echo   -^> Ollama service detected.
)

rem 4. Clean previous containers to release ports
echo [3/5] Cleaning previous StarkLLM containers...
docker rm -f starkllm-backend starkllm-frontend >nul 2>&1
docker compose down --remove-orphans >nul 2>&1
echo   -^> Container cleanup complete.

rem 5. Check Port Availability (8000 and 5173)
echo [4/5] Checking local ports (8000, 5173)...
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) { 'PORT_8000_BUSY' }; if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) { 'PORT_5173_BUSY' }" > "%TEMP%\starkllm_ports.tmp" 2>&1
findstr "PORT_8000_BUSY" "%TEMP%\starkllm_ports.tmp" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [ERROR] Port 8000 is occupied by another application on your PC.
    echo         Please close the conflicting application or edit BACKEND_PORT in .env.
    del "%TEMP%\starkllm_ports.tmp" >nul 2>&1
    pause
    exit /b 1
)
findstr "PORT_5173_BUSY" "%TEMP%\starkllm_ports.tmp" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [ERROR] Port 5173 is occupied by another application on your PC.
    echo         Please close the conflicting application or edit FRONTEND_PORT in .env.
    del "%TEMP%\starkllm_ports.tmp" >nul 2>&1
    pause
    exit /b 1
)
del "%TEMP%\starkllm_ports.tmp" >nul 2>&1
echo   -^> Ports 8000 and 5173 are free.

rem 6. Build and launch containers
echo.
echo [5/5] Building and launching StarkLLM containers...
docker compose up --build -d
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] Docker Compose failed to launch containers.
    echo Check Docker Desktop dashboard and disk space.
    echo.
    pause
    exit /b 1
)

rem 7. Health Polling
echo.
echo Waiting for backend API to be ready (http://localhost:8000/health)...
echo (First launch can take 1-2 minutes while dependencies initialize)
echo.

set HEALTH_URL=http://localhost:8000/health
set MAX_TRIES=90
set TRY=0

:poll_loop
set /a TRY+=1
if %TRY% GTR %MAX_TRIES% (
    echo.
    echo [WARNING] Backend did not respond within 90 seconds.
    echo It may still be starting. Opening browser anyway...
    goto open_browser
)
curl.exe -sf --max-time 2 %HEALTH_URL% >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo   -^> Backend is ready! (attempt %TRY%)
    goto open_browser
)
set /a MOD=%TRY% %% 5
if %MOD% EQU 0 (
    echo Waiting for backend... [%TRY%/%MAX_TRIES%]
)
timeout /t 1 /nobreak >nul
goto poll_loop

:open_browser
echo.
echo Launching StarkLLM Desktop Application Window...
if exist "%~dp0desktop\dist\win-unpacked\StarkLLM.exe" (
    start "" "%~dp0desktop\dist\win-unpacked\StarkLLM.exe"
) else if exist "%~dp0StarkLLM.exe" (
    start "" "%~dp0StarkLLM.exe"
) else if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
    start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:5173 --window-size=1440,900 --user-data-dir="%LOCALAPPDATA%\StarkLLM\AppProfile"
) else (
    start http://localhost:5173
)
echo.
echo ==================================================
echo  StarkLLM Desktop v2.0.0 is running!
echo  Standalone Desktop Window Active
echo ==================================================
echo.
pause
