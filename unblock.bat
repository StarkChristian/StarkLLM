@echo off
rem ============================================================
rem  unblock.bat - Run this ONCE after extracting the ZIP.
rem
rem  Windows marks files downloaded from the internet with a
rem  "Zone.Identifier" alternate data stream (the Mark of the Web).
rem  This causes SmartScreen to block .bat files on first run.
rem
rem  This script uses the built-in "unblock-file" logic via
rem  PowerShell (single command, no policy change required)
rem  to strip the Zone.Identifier from every file in this folder,
rem  then launches start.bat automatically.
rem ============================================================

echo.
echo  StarkLLM Unblock Utility
echo  ========================
echo  Removing Windows security marks from extracted files...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-ChildItem -Path '%~dp0' -Recurse -File | Unblock-File; Write-Host '  Done.' -ForegroundColor Green"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo  [WARN] PowerShell unblock failed. Try right-clicking start.bat,
    echo  selecting Properties, and ticking the Unblock checkbox manually.
    echo.
    pause
    exit /b 1
)

echo.
echo  All files unblocked. Launching StarkLLM...
echo.
timeout /t 2 >nul
call "%~dp0start.bat"
