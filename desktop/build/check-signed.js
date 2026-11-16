// Fails when a file we own is unsigned (or signed by someone else, or the signature is broken) in a release build.
//
//   node build/check-signed.js <folder or file>... [--publisher <name>]... [--publisher-from-config]
//                              [--require-timestamp] [--allowlist <file>]
//
// Every .exe/.dll/.node/... in a folder, and each file given directly (the installer), must carry a valid signature,
// except the files listed in build/unsigned-allowlist.json (third-party files, with the reason).
//   --publisher             the signer must match this name (CN or full DN, as electron-updater compares it);
//                           a file signed by someone else fails unless the allowlist says that is fine (Microsoft)
//   --publisher-from-config the names from build.win.signtoolOptions.publisherName in package.json
//   --allow <pattern>=<why>  one more file that may stay unsigned, with the reason (repeatable); for pipelines that
//                           cannot sign everything (SignPath cannot sign the uninstaller)
//   --require-timestamp     a valid signature without an RFC 3161 timestamp fails (it would die with the certificate)
const fs = require('fs');
const path = require('path');
const sig = require('./signature');

function checkTree(targets, opts = {}) {
  const base = opts.allowlist || sig.loadAllowlist();
  const allow = { ...base, unsigned: [...base.unsigned, ...(opts.extraUnsigned || [])] };
  const names = opts.publishers || [];
  const inspect = opts.inspect || sig.inspect;
  const rows = [];
  for (const target of targets) {
    const stat = fs.statSync(target);
    const files = stat.isDirectory() ? sig.listPeFiles(target) : [target];
    for (const file of files) {
      const rel = stat.isDirectory() ? path.relative(target, file) : path.basename(file);
      const info = inspect(file);
      const row = { file, rel, state: info.state, subject: info.subject, ok: true, note: '' };
      if (info.state === 'invalid') {
        Object.assign(row, { ok: false, note: `signature present but not valid (${info.status})` });
      } else if (info.state === 'unsigned') {
        const a = sig.findAllowed(allow.unsigned, rel);
        if (a) row.note = `unsigned, allowed: ${a.reason}`;
        else Object.assign(row, { ok: false, note: 'UNSIGNED and not on the allowed list: this is our file' });
      } else {
        const ours = !names.length || sig.publisherMatches(names, info.subject);
        const foreign = sig.findAllowed(allow.foreign, rel);
        if (!ours && !foreign) Object.assign(row, { ok: false, note: `signed by another publisher: ${info.subject}` });
        else if (!ours) row.note = `signed by another publisher, allowed: ${foreign.reason}`;
        else if (opts.requireTimestamp && !info.timestamped) Object.assign(row, { ok: false, note: 'signed without a timestamp' });
        else row.note = `signed: ${info.subject}`;
      }
      rows.push(row);
    }
  }
  return { rows, failures: rows.filter((r) => !r.ok) };
}

module.exports = { checkTree };

if (require.main === module) {
  const args = process.argv.slice(2);
  const targets = [];
  const opts = { publishers: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--publisher') opts.publishers.push(args[++i]);
    else if (a === '--publisher-from-config') opts.publishers.push(...sig.configuredPublisherNames(require('../package.json')));
    else if (a === '--allow') {
      const [pattern, ...why] = args[++i].split('=');
      (opts.extraUnsigned = opts.extraUnsigned || []).push({ pattern, reason: why.join('=') || 'allowed on the command line' });
    } else if (a === '--require-timestamp') opts.requireTimestamp = true;
    else if (a === '--allowlist') opts.allowlist = sig.loadAllowlist(args[++i]);
    else targets.push(a);
  }
  if (!targets.length) { console.error('usage: node build/check-signed.js <folder or file>... [--publisher <name>] [--require-timestamp]'); process.exit(2); }
  try {
    const { rows, failures } = checkTree(targets, opts);
    for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.rel}  ${r.note}`);
    console.log(`${rows.length} files checked, ${failures.length} failed`);
    if (!rows.length) { console.error('no files found to check'); process.exit(1); }
    process.exit(failures.length ? 1 : 0);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
