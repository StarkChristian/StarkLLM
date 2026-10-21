<#
.SYNOPSIS
Builds the complete StarkLLM Windows Installer (.exe) using Go and Inno Setup.
#>
param(
    [string]$Version = "1.0.0-beta"
)

$ErrorActionPreference = "Stop"
$ScriptDir = $PSScriptRoot
$StagingDir = Join-Path $ScriptDir "staging"
$DistDir = Join-Path $ScriptDir "dist"
$InstallerDir = Join-Path $ScriptDir "installer"
$LogoPath = Join-Path $ScriptDir "Logo.png"
$IcoPath = Join-Path $InstallerDir "app_icon.ico"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host " Building StarkLLM Setup Installer v$Version" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# Step 1: Verify ICO
if (Test-Path $IcoPath) {
    Write-Host "[1/5] Application icon exists ($IcoPath)." -ForegroundColor Green
} else {
    Write-Host "[1/5] Generating application icon (.ico) maintaining aspect ratio..." -ForegroundColor Yellow
    python -c "
from PIL import Image
img = Image.open(r'$LogoPath').convert('RGBA')
tight = img.crop(img.getbbox())
tw, th = tight.size
max_dim = int(256 * 0.90)
scale = min(max_dim / tw, max_dim / th)
nw, nh = max(1, int(tw * scale)), max(1, int(th * scale))
resized = tight.resize((nw, nh), Image.Resampling.LANCZOS)
canvas = Image.new('RGBA', (256, 256), (0, 0, 0, 0))
canvas.paste(resized, ((256 - nw)//2, (256 - nh)//2), resized)
sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
canvas.save(r'$IcoPath', format='ICO', sizes=sizes)
"
    Write-Host "Icon created at $IcoPath" -ForegroundColor Green
}

# Step 2: Build Launcher start.exe
Write-Host "[2/5] Compiling native launcher (start.exe)..." -ForegroundColor Yellow
$LauncherDir = Join-Path $ScriptDir "launcher_src"
if (Test-Path $LauncherDir) {
    Push-Location $LauncherDir
    try {
        & go build -ldflags="-s -w" -o (Join-Path $ScriptDir "start.exe") main.go
        Write-Host "start.exe compiled successfully." -ForegroundColor Green
    } finally {
        Pop-Location
    }
}

# Step 3: Stage clean release files
Write-Host "[3/5] Staging clean release files..." -ForegroundColor Yellow
if (Test-Path $StagingDir) { Remove-Item -Recurse -Force $StagingDir }
New-Item -ItemType Directory -Force -Path $StagingDir | Out-Null

$ItemsToCopy = @(
    "backend",
    "frontend",
    "docker-compose.yml",
    "start.exe",
    "start.bat",
    "start.cmd",
    "unblock.bat",
    "unblock.ps1",
    "start-here.txt",
    "README.md",
    "RELEASE_NOTES.md",
    "RELEASE_CHECKLIST.md",
    "PACKAGING.md",
    ".env.example"
)

$Exclusions = @(
    "\\node_modules\\",
    "\\__pycache__\\",
    "\\venv\\",
    "\\.venv\\",
    "\\.pytest_cache\\",
    "\\dist\\",
    "\\.git\\",
    "\\data\\",
    "\\knowledge_base_data\\"
)

foreach ($Item in $ItemsToCopy) {
    $src = Join-Path $ScriptDir $Item
    if (Test-Path $src) {
        $dest = Join-Path $StagingDir $Item
        if ((Get-Item $src) -is [System.IO.DirectoryInfo]) {
            Copy-Item -Path $src -Destination $StagingDir -Recurse -Force
        } else {
            Copy-Item -Path $src -Destination $dest -Force
        }
    }
}

# Copy icon into staging root as well
Copy-Item -Path $IcoPath -Destination (Join-Path $StagingDir "app_icon.ico") -Force

# Clean up unwanted directories
Get-ChildItem -Path $StagingDir -Recurse -Directory | Where-Object {
    $dirPath = $_.FullName
    foreach ($pat in $Exclusions) {
        if ($dirPath -match $pat) { return $true }
    }
    return $false
} | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Staging ready with clean files." -ForegroundColor Green

# Step 4: Locate ISCC (Inno Setup Compiler)
Write-Host "[4/5] Locating Inno Setup Compiler (ISCC)..." -ForegroundColor Yellow
$IsccPaths = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"),
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe",
    "C:\ProgramData\chocolatey\bin\ISCC.exe",
    "C:\ProgramData\chocolatey\lib\InnoSetup\tools\ISCC.exe"
)

$IsccCmd = $null
foreach ($path in $IsccPaths) {
    if (Test-Path $path) {
        $IsccCmd = $path
        break
    }
}

if (-not $IsccCmd) {
    $isccInPath = Get-Command iscc.exe -ErrorAction SilentlyContinue
    if ($isccInPath) {
        $IsccCmd = $isccInPath.Source
    }
}

if (-not $IsccCmd) {
    Write-Error "ISCC.exe not found! Please install Inno Setup or ensure it is in PATH."
    exit 1
}

Write-Host "Found ISCC at: $IsccCmd" -ForegroundColor Green

# Step 5: Compile Installer
Write-Host "[5/5] Compiling installer..." -ForegroundColor Yellow
if (-not (Test-Path $DistDir)) { New-Item -ItemType Directory -Force -Path $DistDir | Out-Null }

$IssFile = Join-Path $InstallerDir "starkllm.iss"
& "$IsccCmd" "$IssFile"

$SetupExe = Join-Path $DistDir "StarkLLM-v$Version-Setup.exe"
if (Test-Path $SetupExe) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host " SUCCESS: Installer created successfully!" -ForegroundColor Green
    Write-Host " Output: $SetupExe" -ForegroundColor Green
    Write-Host " Size: $((Get-Item $SetupExe).Length / 1MB | ForEach-Object { '{0:N2} MB' -f $_ })" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green

    # Sync to website downloads if available
    $WebsiteDownloadsDir = Join-Path $ScriptDir "website\downloads"
    if (Test-Path $WebsiteDownloadsDir) {
        Copy-Item -Path $SetupExe -Destination (Join-Path $WebsiteDownloadsDir "StarkLLM-Setup.exe") -Force
        Write-Host "Copied to website/downloads/StarkLLM-Setup.exe" -ForegroundColor Cyan
    }
} else {
    Write-Error "Installer compilation finished but output exe was not found."
}

# Cleanup staging
Write-Host "Cleaning up staging directory..." -ForegroundColor Gray
Remove-Item -Recurse -Force $StagingDir -ErrorAction SilentlyContinue
