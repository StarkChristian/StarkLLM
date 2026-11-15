// Stands in for `electron-builder --win nsis --prepackaged <app> --publish never` in the dry run on Linux, where
// electron-builder cannot build an NSIS installer: the installer is a real Windows program file, signed through the
// same hook electron-builder calls (build/sign.js), plus latest.yml in the shape electron-builder writes.
//   node fake-pack.js <app folder> <output folder>
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sign = require('./sign');
const [app, out] = process.argv.slice(2);
const version = require('../package.json').version;
const name = `StarkLLM-v${version}-Setup.exe`;
const installer = path.join(out, name);
const source = process.env.FAKE_INSTALLER_SOURCE; // an unsigned Windows program file
fs.copyFileSync(source, installer);
(async () => {
  // electron-builder signs the uninstaller it writes mid-build, then the installer
  const uninstaller = path.join(out, '__uninstaller.exe');
  fs.copyFileSync(source, uninstaller);
  await sign({ path: uninstaller, hash: 'sha256' });
  await sign({ path: installer, hash: 'sha256' });
  fs.rmSync(uninstaller);
  // like electron-builder: the checksum is of the installer before the last signing step in the worst case, so refresh-update-info must fix it
  const stale = crypto.createHash('sha512').update('stale').digest('base64');
  fs.writeFileSync(path.join(out, 'latest.yml'),
    `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${stale}\n    size: 1\npath: ${name}\nsha512: ${stale}\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`);
})().catch((e) => { console.error(e.message); process.exit(1); });
