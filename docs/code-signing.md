# Code signing with the SignPath Foundation

Windows Smart App Control blocks new unsigned programs, and it blocked StarkLLM updates on a real PC
(2.0.8, 2.0.14, 2.0.15). The SignPath Foundation signs open source projects for free. The certificate is
issued to SignPath Foundation, so Windows shows "SignPath Foundation" as the publisher.

The public policy is on [www.starkllm.com/code-signing](https://www.starkllm.com/code-signing) and in the
[README](../README.md#code-signing-policy).

## How a release is signed

[`.github/workflows/desktop-release.yml`](../.github/workflows/desktop-release.yml), started by hand on `main`
(Actions, "Desktop release (signed)", Run workflow):

1. Build the installer once, unsigned, to get the finished app folder `win-unpacked` (with `app-update.yml`).
2. SignPath signs `StarkLLM.exe` in that folder (artifact configuration [`app`](signing/app.xml)).
3. electron-builder builds the installer again from the signed folder (`--prepackaged` packs it unchanged).
4. SignPath signs the installer (artifact configuration [`installer`](signing/installer.xml)).
5. [`refresh-update-info.js`](../desktop/build/refresh-update-info.js) computes `latest.yml` (sha512, size) and the
   `.blockmap` again, because signing changed the installer's bytes. Without this the in-app update would refuse
   the download.
6. The signed installer is installed on the runner; the installed `StarkLLM.exe` must be the signed one.

Steps 2 and 4 each wait until the request is approved in SignPath (up to 2 hours). The artifact
`starkllm-windows-release` holds `Setup.exe`, `.blockmap` and `latest.yml` for the GitHub release.

With "sign" off (and on every pull request that changes the pipeline) the same steps run without SignPath, as a
dry run.

## Not signed

- Files of other open source projects that ship unchanged: Electron and Chromium libraries (`ffmpeg.dll`,
  `libEGL.dll`, `libGLESv2.dll`, `vk_swiftshader.dll`, `vulkan-1.dll`, ...), Microsoft's `d3dcompiler_47.dll`
  (signed by Microsoft) and the NSIS plugins. SignPath only signs files built from our own source code.
- The uninstaller (`Uninstall StarkLLM.exe`). NSIS writes it in the middle of the installer build, and a SignPath
  request cannot run there. It runs when StarkLLM is removed and during an update. If Windows blocks it during an
  update, the update still installs (tested in `desktop-windows.yml`, "Update still installs when the old
  uninstaller fails").

Smart App Control decides about unsigned files of other projects by their reputation. The same Electron files ship
in thousands of apps. Whether this is enough is checked on a real PC with the first signed release.

## Setting up SignPath (once, after the project is accepted)

1. Turn on two-factor authentication for GitHub (Settings, Password and authentication) and for SignPath.
2. In SignPath, organization settings, Trusted build systems: add **GitHub.com** and link it to the project.
3. Project `StarkLLM` (slug `StarkLLM`), repository `https://github.com/StarkChristian/StarkLLM`.
4. Artifact configurations: `app` with the content of [`signing/app.xml`](signing/app.xml), `installer` with
   [`signing/installer.xml`](signing/installer.xml).
5. Signing policy `release-signing`: certificate from the SignPath Foundation, **Verify origin** on, allowed branch
   `main`, approver: StarkChristian.
6. A CI user with submitter rights on the policy; its API token goes into the repository secret
   `SIGNPATH_API_TOKEN` (GitHub, Settings, Secrets and variables, Actions).
7. Repository variable `SIGNPATH_ORGANIZATION_ID` (same page, Variables). `SIGNPATH_PROJECT_SLUG` and
   `SIGNPATH_SIGNING_POLICY_SLUG` are only needed if the slugs differ from `StarkLLM` and `release-signing`.

## The update check and the publisher name

electron-updater can refuse an update whose publisher is not the expected one (`publisherName` in
`app-update.yml`). Until now it is not set, because releases were unsigned, so every installed version accepts
the first signed release.

After the first signed release, the exact name shown in the signature (expected: `SignPath Foundation`) goes
into `build.win.signtoolOptions.publisherName`. From then on, an update that is not signed by that publisher is
refused.

If the certificate changes later (for example the company's own certificate), one release must list both names
first, so that installed versions accept the next one:

```json
"publisherName": ["SignPath Foundation", "New publisher name"]
```

## Rules we accepted (signpath.org/terms)

- The whole project stays under an OSI license (Apache 2.0), with no commercial dual license and no closed parts.
- Only files built from this repository by GitHub Actions are signed. Every release is approved by hand.
- Everyone with commit or approval rights uses multi-factor authentication.
- The code signing policy stays on the website and in the README.
- SignPath may revoke the certificate, also for releases that are already out, if these rules are broken or a
  signed file turns out to be malware.
