# Signing a release on the owner's PC (Certum Open Source Code Signing in the Cloud)

The private key stays in Certum's cloud, so signing cannot run unattended in GitHub Actions. It runs on the owner's
Windows PC, once per release, while SimplySign Desktop is logged in. Everything else (sign, pack, update info, checks)
is one script: [`desktop/build/release-sign.js`](../desktop/build/release-sign.js). The SignPath route in
[code-signing.md](code-signing.md) is the alternative; both use the same `resources/app-update.yml` rules.

## One-time setup

1. **Windows SDK** (for `signtool.exe`): `winget install Microsoft.WindowsSDK.10.0.26100` (any 10.0.x SDK works, the
   script finds the newest `signtool.exe`; or set `SIGNTOOL_PATH`). Node.js 20 and Git are needed as for any build.
2. **SimplySign Desktop** from Certum (certum.eu, "SimplySign Desktop") and the **SimplySign** app on the phone.
3. Log in to SimplySign Desktop with the Certum account name, and as the password the **one-time code** the phone app
   shows. Never write that code, or any PIN, into a file, a script, an environment variable or a chat.
4. Find the certificate (it appears in the Windows certificate store only while SimplySign Desktop is logged in):

   ```powershell
   Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Format-List Subject, Thumbprint, NotAfter
   ```

   Write down the **Thumbprint** (40 hex digits). It is not a secret. The scripts take it from the environment:

   ```powershell
   $env:STARKLLM_SIGN = 'certum'
   $env:STARKLLM_CERT_SHA1 = '<thumbprint>'          # or: $env:STARKLLM_CERT_SUBJECT = '<name from Subject>'
   ```

   Timestamps come from `http://time.certum.pl` (RFC 3161, SHA-256). Without a timestamp a signature would stop being
   valid on the day the certificate expires, so the checks fail on a missing timestamp.

## The publisher name (first signed release, once)

electron-updater refuses an update that is not signed by the name in `publisherName` (written into
`resources/app-update.yml`). A wrong name locks every installed copy out of updates, so it is a checked step:

```powershell
cd desktop
node build/check-publisher.js --from-store <thumbprint>
```

It prints the certificate subject and the line to put into `desktop/package.json`, under `build.win.signtoolOptions`. The
decision of the owner is the **common name (CN) of the certificate only**, not the full distinguished name, so a
change of address or country in a later certificate does not lock users out (electron-updater logs a harmless hint to use the full name):

```json
"publisherName": ["Open Source Developer, Christian Stark"]
```

(the real value is what the command prints). Commit it with the release. From then on `release-sign.js` fails if
(a) `app-update.yml` of the app folder does not carry that name (the folder was built before the change), or
(b) the signed installer's signer does not match it, exactly as electron-updater compares (`check-publisher.js`).

**Before a later certificate change** (renewal under another subject, another issuer): one release first lists both
names, `"publisherName": ["Old name", "New name"]`, and is signed with the old certificate. Only after users have
received that release, the next one may be signed with the new certificate.

## Per release

Run in PowerShell, SimplySign Desktop logged in. `<tag>` is the release commit.

```powershell
git checkout <tag>; cd desktop; npm ci

# 1. Unsigned build of exactly this commit: gives dist\win-unpacked with resources\app-update.yml
Remove-Item Env:STARKLLM_SIGN -ErrorAction SilentlyContinue
npx electron-builder --win nsis --x64 --publish never

# 2. Sign every file of the app folder, pack with --prepackaged (electron-builder signs the uninstaller it writes in
#    the middle of the build, and the installer), recompute latest.yml + .blockmap, check, install, check, uninstall
$env:STARKLLM_SIGN = 'certum'; $env:STARKLLM_CERT_SHA1 = '<thumbprint>'
node build/release-sign.js --install-check
```

Result: `desktop\release-work\out\` with `StarkLLM-v<version>-Setup.exe`, `.blockmap`, `latest.yml`, and the SHA-256 of
each printed at the end. The script stops with `FAILED:` on the first problem.

Alternative to step 1 when the build should come from GitHub: run the workflow "Desktop release (signed)" with
`sign` off, download its `app-unsigned` artifact into `desktop\dist\win-unpacked`, continue with step 2. The
installer from CI cannot be signed afterwards on its own: the app folder inside it must be signed before it is packed.

Independent check (by hand, not by our script):

```powershell
$s = Get-Item release-work\out\StarkLLM-v*-Setup.exe
Get-AuthenticodeSignature $s | Format-List Status, SignerCertificate, TimeStamperCertificate
& "${env:ProgramFiles(x86)}\Windows Kits\10\bin\<sdk version>\x64\signtool.exe" verify /pa /v $s
Get-FileHash $s, "$s.blockmap", release-work\out\latest.yml -Algorithm SHA256
```

Upload to the **draft** GitHub release (do not publish before the test below):

```powershell
gh release upload v<version> release-work\out\StarkLLM-v<version>-Setup.exe release-work\out\StarkLLM-v<version>-Setup.exe.blockmap release-work\out\latest.yml --repo StarkChristian/StarkLLM --clobber
```

Then put the SHA-256 values into the release notes / checksum file as for every release.

### The engine without Docker: always signed

The program files of the engine without Docker (`resources\engine-native`: Python packages from PyPI, Tesseract) are
signed by us in every release, without `STARKLLM_SIGN_THIRD_PARTY`. On the 2.2.0 test (17 Nov 2026) Smart App Control
blocked the unsigned `ctranslate2\_ext.cp311-win_amd64.pyd`, so the engine could not start. That is about 230
signatures per release (the cloud certificate allows 5000 a month). Files signed by the Python Software Foundation keep
their signature; Tesseract's expired signature (Universitaet Mannheim, 2023) is replaced by ours.

### Only if the Windows 11 test shows a block: third-party files and NSIS plugins

Decision of the owner: **only our own files are signed by default.** The third-party files (Electron/Chromium libraries,
`elevate.exe`) and the NSIS plugin DLLs stay as they are unless the test at the end of this page shows that Smart App
Control blocked them. Then, and only then:

1. Electron/Chromium libraries and `elevate.exe`: set the switch for step 2 and run it again (files that are signed are
   kept):

   ```powershell
   $env:STARKLLM_SIGN_THIRD_PARTY = '1'
   node build/release-sign.js --install-check
   ```

2. NSIS plugin DLLs (`System.dll`, `StdUtils.dll`, `UAC.dll`, `WinShell.dll`, `nsis7z.dll`, ...; the installer unpacks
   them to `%TEMP%` and loads them; [`windows-trust.yml`](../.github/workflows/windows-trust.yml) shows they are flagged
   when unsigned). Before step 1, in the same PowerShell window (roughly one signature per DLL):

   ```powershell
   $t = "$env:TEMP\nsis-toolset"; $out = node build/copy-nsis-plugins.js $t
   $dlls = @($out | Select-Object -Skip (($out | Select-String -SimpleMatch 'DLLS').LineNumber)); node build/sign.js @dlls
   $env:ELECTRON_BUILDER_NSIS_DIR = "$t\nsis"; $env:ELECTRON_BUILDER_NSIS_RESOURCES_DIR = "$t\resources"
   ```

## Signature budget and an expired session

The certificate allows **5000 signatures a month**. One release needs about **4 to 5**: our own files (`StarkLLM.exe`, our `.node` files), the
uninstaller and the installer. With `STARKLLM_SIGN_THIRD_PARTY=1` about 10 (Electron's DLLs and `elevate.exe` are added;
Microsoft's `d3dcompiler_47.dll` keeps its own signature), plus one per NSIS plugin DLL if those are signed. The script prints "signatures made in this run". Files that already carry a valid
signature are never signed again, and all files of the app folder go to `signtool` in one call, so a repeated run costs
only what is missing.

If SimplySign Desktop logs out in the middle (the error mentions the certificate or key not found, or the signing
dialog is dismissed): log in again with a **new** one-time code and start the same `release-sign.js` command again. It
starts from the unsigned app folder, keeps the signatures that exist and signs the rest. Whether SimplySign asks for a
confirmation per signature or per session is a setting of the Certum account; if it asks per signature, keep the phone
at hand during step 2 (about 5 prompts). Retries (3 attempts, 5 s apart) cover a busy timestamp server only.

## Files that may stay unsigned

[`desktop/build/unsigned-allowlist.json`](../desktop/build/unsigned-allowlist.json) is the single list, with a reason
per entry; `check-signed.js` fails the release for every other unsigned file, for a broken signature, for a file signed
by another publisher and for a signature without timestamp.

| File | Why it may stay unsigned |
|---|---|
| `ffmpeg.dll`, `libEGL.dll`, `libGLESv2.dll`, `vk_swiftshader.dll`, `vulkan-1.dll` | Electron/Chromium libraries of another project, shipped unchanged. Not signed unless `STARKLLM_SIGN_THIRD_PARTY=1` (see above) |
| `resources\elevate.exe` | electron-builder's helper, shipped unchanged. Same switch |
| `d3dcompiler_47.dll` | signed by Microsoft (allowed as a foreign signature) |
| NSIS plugin DLLs | inside the installer, not on disk in a build folder; signed only by the optional step above |

Our own files are never on the list: `StarkLLM.exe`, the uninstaller, the installer, our `.node` files. The same check
runs in CI: after a signed release in [`desktop-release.yml`](../.github/workflows/desktop-release.yml) (SignPath, which
cannot sign the uninstaller: passed as `--allow` there) and in the dry run below.

## What was tested without the certificate, and what was not

[`signing-dry-run.yml`](../.github/workflows/signing-dry-run.yml) runs the whole chain with a self-signed test
certificate made at run time (`STARKLLM_SIGN=test`): on Linux with `osslsigncode` and a stand-in for the NSIS build
(`desktop/test/signing-chain.test.js`), on Windows with `signtool`, electron-builder's real NSIS build,
`publisherName` set, silent install, check of every installed file including the uninstaller, uninstall.

Only possible with the real certificate: logging in with SimplySign; `signtool /sha1` against the cloud key; the
timestamp from `time.certum.pl`; Windows showing the certificate chain as trusted (Certum root); the signature count
and prompts per run; electron-updater accepting the update on a PC with the real name; Smart App Control's verdict.

## Test on a clean Windows 11 PC (Smart App Control on)

1. Settings, Privacy & security, Windows Security, App & browser control, Smart App Control: **On**. (Once turned off it
   cannot be turned on again without resetting Windows, so use a PC or VM where it is on from the start.)
2. Download `Setup.exe` from the draft release with a browser (so it carries the "from the internet" mark). Properties,
   Digital Signatures: the name matches `publisherName`, "This digital signature is OK", a timestamp is shown.
3. Run it: no "blocked" or "unknown publisher" page; SmartScreen may still show the publisher name; install for the
   current user and for all users (elevate.exe).
4. Start StarkLLM: it opens, no Smart App Control message in Windows Security, Protection history.
5. Open Event Viewer, Microsoft-Windows-CodeIntegrity/Operational: no event 3033/3077 for StarkLLM files.
6. Update path: install the previous release, then update to this one from inside the app. It must download, verify the
   signature (log: `Verifying signature`) and restart into the new version.
7. Uninstall from Settings, Apps: the uninstaller runs without a block.
8. If Smart App Control blocked a third-party file or an NSIS plugin (file name in the event), sign them as described under
   "Only if the Windows 11 test shows a block", build the release again and repeat this test. Note which files it was.
