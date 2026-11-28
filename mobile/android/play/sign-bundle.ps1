# Signs the release bundle (AAB) from GitHub Actions with the owner's upload key, on the owner's PC, for Google Play.
# The key stays on this PC: nothing here sends it anywhere, and jarsigner asks for its password (it is not stored).
#
#   powershell -ExecutionPolicy Bypass -File sign-bundle.ps1 -Bundle .\app-release.aab -Keystore C:\Keys\starkllm-upload.jks
#
# Writes app-release-signed.aab next to the bundle and checks the signature. Upload that file in the Play Console.
param(
    [Parameter(Mandatory = $true)][string]$Bundle,
    [Parameter(Mandatory = $true)][string]$Keystore,
    [string]$Alias = "upload"
)
$ErrorActionPreference = "Stop"

$jarsigner = Get-Command jarsigner -ErrorAction SilentlyContinue
if (-not $jarsigner -and $env:JAVA_HOME) { $jarsigner = Get-Command (Join-Path $env:JAVA_HOME "bin\jarsigner.exe") -ErrorAction SilentlyContinue }
if (-not $jarsigner) { throw "jarsigner was not found. Install a JDK (17 or newer) or set JAVA_HOME." }
if (-not (Test-Path $Bundle)) { throw "Bundle not found: $Bundle" }
if (-not (Test-Path $Keystore)) { throw "Keystore not found: $Keystore" }

$signed = [System.IO.Path]::ChangeExtension((Resolve-Path $Bundle).Path, $null).TrimEnd('.') + "-signed.aab"
& $jarsigner.Source -sigalg SHA256withRSA -digestalg SHA-256 -keystore $Keystore -signedjar $signed $Bundle $Alias
if ($LASTEXITCODE -ne 0) { throw "Signing failed." }
& $jarsigner.Source -verify -strict $signed
if ($LASTEXITCODE -ne 0) { throw "The signature could not be verified." }
Write-Host "Signed: $signed"
