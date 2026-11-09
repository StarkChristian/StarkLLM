# winget

Manifests for `winget install StarkChristian.StarkLLM`, in the folder layout of
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) (`manifests/s/StarkChristian/StarkLLM/<version>/`).

## Check

The workflow `.github/workflows/winget.yml` runs on every change here: on a clean Windows machine winget validates the
manifest and installs StarkLLM from it (download from the GitHub release, SHA-256 check, silent per-user install).

To try it on a PC:

```powershell
winget settings --enable LocalManifestFiles   # once, as administrator
winget install --manifest packaging\winget\manifests\s\StarkChristian\StarkLLM\2.0.8
```

## Publish

winget installs only what is in microsoft/winget-pkgs. To publish a version, copy its folder there as a pull request
(the first one asks to sign the Microsoft CLA). After the first version, new versions can be submitted with
`wingetcreate update StarkChristian.StarkLLM --version <v> --urls <Setup.exe URL> --submit`.

## New version

Copy the folder of the last version, change `PackageVersion`, `InstallerUrl`, `InstallerSha256` (upper case) and
`ReleaseDate`, and `ReleaseNotesUrl` in the locale file.

The installer is not code-signed yet; winget accepts it, Windows SmartScreen may still warn on the first start.
