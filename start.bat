@echo off
setlocal enabledelayedexpansion
title StarkLLM Control Panel (Windows Research Beta)
cd /d "%~dp0"

:menu
cls
echo ==================================================
echo              StarkLLM Control Panel               
echo           Windows Research Beta - Phase 1         
echo ==================================================
echo.
echo  1.  Start StarkLLM
echo  2.  Stop  StarkLLM
echo  3.  Run Preflight Diagnostic Check
echo  4.  Exit
echo.
echo ==================================================
echo  Requires: Docker Desktop (WSL2) + Ollama
echo  Default:  qwen2.5:7b + nomic-embed-text
echo ==================================================
echo.
set "choice="
set /p choice="Enter choice [1/2/3/4]: "

if "%choice%"=="1" goto start_app
if "%choice%"=="2" goto stop_app
if "%choice%"=="3" goto diag_app
if "%choice%"=="4" goto exit_app

echo.
echo  Invalid choice. Please enter 1, 2, 3, or 4.
timeout /t 2 >nul
goto menu

:diag_app
cls
echo ==================================================
echo           Running Preflight Diagnostics           
echo ==================================================
echo.
echo [1/4] Checking Docker status...
docker info >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   [FAIL] Docker Desktop is NOT running.
) else (
    echo   [PASS] Docker Desktop is running.
)

echo [2/4] Checking Ollama service...
curl.exe -sf --max-time 3 http://localhost:11434/api/tags >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   [WARN] Ollama service not reachable on http://localhost:11434.
) else (
    echo   [PASS] Ollama service detected.
)

echo [3/4] Checking Ports (8000, 5173)...
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) { Write-Host '  Port 8000 (Backend):  IN USE (conflict)' } else { Write-Host '  Port 8000 (Backend):  FREE' }; if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) { Write-Host '  Port 5173 (Frontend): IN USE (conflict)' } else { Write-Host '  Port 5173 (Frontend): FREE' }"

echo [4/4] Checking compose file...
if exist "docker-compose.yml" (
    echo   [PASS] docker-compose.yml found.
) else (
    echo   [FAIL] docker-compose.yml NOT found in current directory.
)
echo.
echo Diagnostic complete.
pause
goto menu

:start_app
cls
echo ==================================================
echo                 Starting StarkLLM                 
echo ==================================================
echo.

rem Check Docker
echo  [1/5] Checking Docker Desktop status...
docker info >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  [ERROR] Docker Desktop is not running or not responsive.
    echo  Please start Docker Desktop and wait until the whale icon is steady.
    echo.
    pause
    goto menu
)
echo    -^> Docker Desktop is running.

rem Check Ollama
echo  [2/5] Checking Ollama service...
curl.exe -sf --max-time 3 http://localhost:11434/api/tags >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  [WARNING] Ollama is not running on http://localhost:11434.
    echo            Inference requires Ollama. Please start Ollama when possible.
    echo.
) else (
    echo    -^> Ollama detected.
)

rem Container cleanup
echo  [3/5] Cleaning previous StarkLLM containers...
docker rm -f starkllm-backend starkllm-frontend >nul 2>&1
docker compose down --remove-orphans >nul 2>&1
echo    -^> Cleanup complete.

rem Port check
echo  [4/5] Checking local ports (8000, 5173)...
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue) { 'PORT_8000_BUSY' }; if (Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue) { 'PORT_5173_BUSY' }" > "%TEMP%\starkllm_ports.tmp" 2>&1
findstr "PORT_8000_BUSY" "%TEMP%\starkllm_ports.tmp" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo  [ERROR] Port 8000 is occupied by another application.
    echo         Please close the conflicting process or change BACKEND_PORT in .env.
    del "%TEMP%\starkllm_ports.tmp" >nul 2>&1
    pause
    goto menu
)
findstr "PORT_5173_BUSY" "%TEMP%\starkllm_ports.tmp" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo  [ERROR] Port 5173 is occupied by another application.
    echo         Please close the conflicting process or change FRONTEND_PORT in .env.
    del "%TEMP%\starkllm_ports.tmp" >nul 2>&1
    pause
    goto menu
)
del "%TEMP%\starkllm_ports.tmp" >nul 2>&1
echo    -^> Ports 8000 and 5173 are available.

rem Compose up
echo.
echo  [5/5] Building and launching containers...
docker compose up --build -d
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  [ERROR] Docker Compose failed to launch.
    echo  Make sure Docker Desktop has sufficient RAM and disk space allocated.
    echo.
    pause
    goto menu
)

echo.
echo  Waiting for backend to be ready (http://localhost:8000/health)...
set HEALTH_URL=http://localhost:8000/health
set MAX_TRIES=90
set TRY=0

:poll_loop_bat
set /a TRY+=1
if %TRY% GTR %MAX_TRIES% (
    echo  [WARNING] Backend did not respond within 90 seconds. Opening browser anyway...
    goto open_browser_bat
)
curl.exe -sf --max-time 2 %HEALTH_URL% >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo    -^> Backend is ready! (attempt %TRY%)
    goto open_browser_bat
)
set /a MOD=%TRY% %% 5
if %MOD% EQU 0 (
    echo  Waiting for backend... [%TRY%/%MAX_TRIES%]
)
timeout /t 1 /nobreak >nul
goto poll_loop_bat

:open_browser_bat
echo.
echo  Opening StarkLLM in your browser...
start http://localhost:5173
echo.
echo ==================================================
echo  StarkLLM is running!
echo  Access: http://localhost:5173
echo ==================================================
echo.
pause
goto menu

:stop_app
cls
echo ==================================================
echo                 Stopping StarkLLM                 
echo ==================================================
echo.
docker compose down
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  [ERROR] Failed to stop StarkLLM containers.
    echo.
    pause
    goto menu
)
echo.
echo ==================================================
echo  StarkLLM stopped successfully.
echo ==================================================
echo.
pause
goto menu

:exit_app
endlocal
exit /b 0
