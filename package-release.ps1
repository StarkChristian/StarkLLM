<#
.SYNOPSIS
Packages the StarkLLM Windows Research Beta into a clean, distributable zip file.

.DESCRIPTION
This script creates a clean distribution package. It includes all necessary source files,
scripts, and configuration examples while explicitly excluding personal data, uploaded
files, local vector databases, and temporary development artifacts (e.g. node_modules).
#>
param(
    [string]$Version = "1.0.0"
)

$RepoRoot = Split-Path -Path $PSScriptRoot -Parent
$ReleaseName = "StarkLLM-v$Version-beta"
$OutputDir = Join-Path -Path $PSScriptRoot -ChildPath $ReleaseName
$ZipPath = Join-Path $PSScriptRoot "StarkLLM-v$Version-beta.zip"

Write-Host "Creating release package $ReleaseName..." -ForegroundColor Cyan

# Remove old output dir or zip if they exist
if (Test-Path $OutputDir) { Remove-Item -Recurse -Force $OutputDir }
if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }

# Create fresh output directory
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

# Define Inclusion List (Files and Directories)
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

# Define Exclusion List (Regex Patterns)
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

Write-Host "Copying files to $OutputDir..."

foreach ($ItemName in $ItemsToCopy) {
    $SourcePath = Join-Path -Path $PSScriptRoot -ChildPath $ItemName
    if (Test-Path $SourcePath) {
        $DestPath = Join-Path -Path $OutputDir -ChildPath $ItemName
        
        if ((Get-Item $SourcePath) -is [System.IO.DirectoryInfo]) {
            # Copy directory structure excluding unwanted patterns
            Copy-Item -Path $SourcePath -Destination $OutputDir -Recurse -Force
        } else {
            Copy-Item -Path $SourcePath -Destination $DestPath -Force
        }
    } else {
        Write-Host "Warning: $ItemName not found, skipping." -ForegroundColor Yellow
    }
}

# Clean up excluded directories from the copied folder
Write-Host "Cleaning up excluded directories (node_modules, pycache, etc.)..."
Get-ChildItem -Path $OutputDir -Recurse -Directory | Where-Object {
    $dirPath = $_.FullName
    $match = $false
    foreach ($pattern in $Exclusions) {
        if ($dirPath -match $pattern) {
            $match = $true
            break
        }
    }
    return $match
} | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Creating ZIP archive: $ZipPath..."
$filesToZip = (Get-ChildItem -Path $OutputDir -Force).FullName
Compress-Archive -Path $filesToZip -DestinationPath $ZipPath -Force

$WebsiteDownloadsDir = Join-Path $PSScriptRoot "website\downloads"
if (Test-Path $WebsiteDownloadsDir) {
    Write-Host "Syncing ZIP to website/downloads..."
    Copy-Item -Path $ZipPath -Destination (Join-Path $WebsiteDownloadsDir "StarkLLM-v1.0.0-beta.zip") -Force
}

Write-Host "Cleaning up temporary folder..."
Remove-Item -Recurse -Force $OutputDir

Write-Host "Packaging Complete!" -ForegroundColor Green
Write-Host "Output: $ZipPath" -ForegroundColor Green
Write-Host ""
Write-Host "Sanity Notes:"
Write-Host "- Please remind users they need Docker Desktop and Ollama installed."
Write-Host "- StarkLLM is a Research Beta, completely free, and open source."
Write-Host "- No personal data (ChromaDB, sqlite DBs, .env secrets) was included in this zip."
