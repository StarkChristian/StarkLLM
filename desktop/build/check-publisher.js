// The publisher name step for the first signed release (and every later one).
//
// electron-updater refuses an update whose signature does not match `publisherName` in app-update.yml, which
// electron-builder writes from build.win.signtoolOptions.publisherName in package.json. A wrong value would lock every
// installed copy out of updates, so the signed installer is checked against the configured value before it is uploaded.
//
//   node build/check-publisher.js --from-store <thumbprint>   BEFORE the build: the exact name of the certificate in the
//                                                             Windows store, and the line to put in package.json
//   node build/check-publisher.js <signed installer>          AFTER signing: the signature must match the configured
//                                                             name(s); fails if none is configured or they differ
//
// Before a later certificate change, one release lists both names (old and new), so installed versions accept the next
// one: "publisherName": ["Old name", "New name"]. See docs/signing-on-owner-pc.md.
const { spawnSync } = require('child_process');
const sig = require('./signature');

function checkPublisher(installer, pkg = require('../package.json'), inspect = sig.inspect) {
  const names = sig.configuredPublisherNames(pkg);
  const info = inspect(installer);
  if (info.state !== 'valid') return { ok: false, message: `${installer} has no valid signature (${info.status})`, info, names };
  if (!names.length) {
    return { ok: false, info, names, message: `publisherName is not set in package.json (build.win.signtoolOptions.publisherName). The installer is signed as: ${info.subject}\n` +
      `  suggested: "publisherName": ${JSON.stringify([sig.commonName(info.subject)])}` };
  }
  if (!sig.publisherMatches(names, info.subject)) {
    return { ok: false, info, names, message: `signer does not match the configured publisherName.\n  configured: ${JSON.stringify(names)}\n  signed as : ${info.subject}\n` +
      'Installed copies would refuse the update. Fix package.json (and build again, the name is written into app-update.yml) or the certificate.' };
  }
  return { ok: true, info, names, message: `publisherName matches: ${JSON.stringify(names)} == ${info.subject}` };
}

function subjectFromStore(thumbprint) {
  const t = thumbprint.replace(/[\s:]/g, '');
  if (!/^[0-9A-Fa-f]{40}$/.test(t)) throw new Error('give the 40 hex digits of the thumbprint');
  const ps = `(Get-ChildItem Cert:\\CurrentUser\\My\\${t}).Subject`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout.trim()) throw new Error(`certificate ${t} not found in Cert:\\CurrentUser\\My (is SimplySign Desktop logged in?) ${r.stderr}`);
  return r.stdout.trim();
}

module.exports = { checkPublisher };

if (require.main === module) {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--from-store') {
      const subject = subjectFromStore(args[1] || '');
      console.log(`certificate subject: ${subject}`);
      console.log(`put into desktop/package.json, build.win.signtoolOptions:\n  "publisherName": ${JSON.stringify([sig.commonName(subject)])}`);
      process.exit(0);
    }
    if (!args[0]) { console.error('usage: node build/check-publisher.js <signed installer> | --from-store <thumbprint>'); process.exit(2); }
    const r = checkPublisher(args[0]);
    console.log(r.message);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
