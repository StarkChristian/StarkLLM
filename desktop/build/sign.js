// Code signing for every Windows file StarkLLM ships (roadmap phase 0, "Windows trust"). Windows Smart App Control
// checks each EXE and DLL when it is loaded and blocks unsigned files it does not know (seen 9 and 10 Nov 2026 on a
// real PC: the 2.0.8 update and the 2.0.10 installer).
//
// electron-builder calls this for the app, its DLLs and .node files (win.signExts), the uninstaller and the installer.
// build/release-sign.js and CI also run it from the command line:  node build/sign.js <file>...
//
// STARKLLM_SIGN selects how:
//   (unset)  no signing: local builds and pull requests without a certificate
//   certum   the Certum Open Source Code Signing certificate (SimplySign, key in Certum's cloud) from the Windows
//            certificate store, on the owner's PC. STARKLLM_CERT_SHA1 (thumbprint, preferred) or
//            STARKLLM_CERT_SUBJECT (name). SHA-256, RFC 3161 timestamp from time.certum.pl (STARKLLM_TIMESTAMP_URL
//            to change). There is deliberately no setting for a PIN or a one-time code: SimplySign Desktop keeps
//            the session open, signtool just uses it.
//   test     a test certificate: STARKLLM_SIGN_PFX, STARKLLM_SIGN_PFX_PASSWORD (CI, build/make-test-cert.js).
//            With signtool on Windows, with osslsigncode elsewhere (dry runs on Linux).
//   azure    Azure Artifact Signing: STARKLLM_AZURE_DLIB (Azure.CodeSigning.Dlib.dll), STARKLLM_AZURE_METADATA (json)
// Files that already carry a valid signature (ours from an earlier run, Microsoft's d3dcompiler_47.dll in Electron)
// are left as they are, so a run that stopped half way (SimplySign session expired) can simply be started again.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { backend, signtoolPath, inspect } = require('./signature');

const AZURE_TIMESTAMP = 'http://timestamp.acs.microsoft.com';
const CERTUM_TIMESTAMP = 'http://time.certum.pl';
const ATTEMPTS = 3;

function normalizeThumbprint(t) {
  const s = String(t).replace(/[\s:]/g, '').toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(s)) throw new Error('STARKLLM_CERT_SHA1 must be the 40 hex digits of the certificate thumbprint');
  return s;
}

function signArgs(mode, file) {
  const files = [].concat(file);
  if (mode === 'test') {
    const pfx = process.env.STARKLLM_SIGN_PFX;
    if (!pfx) throw new Error('STARKLLM_SIGN=test needs STARKLLM_SIGN_PFX');
    return ['sign', '/fd', 'sha256', '/f', pfx, '/p', process.env.STARKLLM_SIGN_PFX_PASSWORD || '', ...files];
  }
  if (mode === 'certum') {
    const sha1 = process.env.STARKLLM_CERT_SHA1;
    const subject = process.env.STARKLLM_CERT_SUBJECT;
    if (!sha1 && !subject) throw new Error('STARKLLM_SIGN=certum needs STARKLLM_CERT_SHA1 (thumbprint) or STARKLLM_CERT_SUBJECT');
    const select = sha1 ? ['/sha1', normalizeThumbprint(sha1)] : ['/n', subject];
    const store = process.env.STARKLLM_CERT_STORE_MACHINE ? ['/sm'] : [];
    const ts = process.env.STARKLLM_TIMESTAMP_URL || CERTUM_TIMESTAMP;
    return ['sign', '/fd', 'sha256', '/tr', ts, '/td', 'sha256', ...select, ...store, ...files];
  }
  if (mode === 'azure') {
    const dlib = process.env.STARKLLM_AZURE_DLIB;
    const metadata = process.env.STARKLLM_AZURE_METADATA;
    if (!dlib || !metadata) throw new Error('STARKLLM_SIGN=azure needs STARKLLM_AZURE_DLIB and STARKLLM_AZURE_METADATA');
    return ['sign', '/fd', 'sha256', '/tr', AZURE_TIMESTAMP, '/td', 'sha256', '/dlib', dlib, '/dmdf', metadata, ...files];
  }
  throw new Error(`unknown STARKLLM_SIGN=${mode} (use certum, test or azure)`);
}

// osslsigncode (dry runs on Linux): same result as signtool with a PFX, written to a temp file and moved over
function osslsigncodeArgs(mode, file, out) {
  if (mode !== 'test') throw new Error(`STARKLLM_SIGN=${mode} needs Windows (signtool); on Linux only STARKLLM_SIGN=test works`);
  const pfx = process.env.STARKLLM_SIGN_PFX;
  if (!pfx) throw new Error('STARKLLM_SIGN=test needs STARKLLM_SIGN_PFX');
  return ['sign', '-pkcs12', pfx, '-pass', process.env.STARKLLM_SIGN_PFX_PASSWORD || '', '-h', 'sha256', '-in', file, '-out', out];
}

function hasValidSignature(file) {
  if (backend() === 'signtool') {
    return spawnSync(signtoolPath(), ['verify', '/pa', '/q', file], { windowsHide: true }).status === 0;
  }
  return inspect(file).state === 'valid';
}

let signaturesMade = 0;
// build/release-sign.js sets STARKLLM_SIGN_COUNT_FILE so the signatures made by electron-builder's own calls
// (uninstaller, installer) are counted too: the cloud certificate allows 5000 signatures a month
function recordSignatures(n) {
  signaturesMade += n;
  if (n && process.env.STARKLLM_SIGN_COUNT_FILE) fs.appendFileSync(process.env.STARKLLM_SIGN_COUNT_FILE, 'x'.repeat(n));
}

function runSigntool(mode, files) {
  const r = spawnSync(signtoolPath(), signArgs(mode, files), { windowsHide: true, encoding: 'utf8' });
  return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

function runOsslsigncode(mode, files) {
  for (const file of files) {
    const tmp = `${file}.signing`;
    const r = spawnSync('osslsigncode', osslsigncodeArgs(mode, file, tmp), { encoding: 'utf8' });
    if (r.status !== 0) { fs.rmSync(tmp, { force: true }); return { ok: false, output: `${r.stdout || ''}${r.stderr || ''}`.trim() }; }
    fs.renameSync(tmp, file);
  }
  return { ok: true, output: '' };
}

// Signs the files that carry no valid signature yet, in as few signtool calls as possible (one signature per file,
// the cloud certificate counts signatures). Returns how many files were signed now.
function signFiles(files, log = console.log) {
  const mode = process.env.STARKLLM_SIGN;
  if (!mode) return 0;
  let pending = files;
  let signed = 0;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    pending = pending.filter((f) => {
      if (!hasValidSignature(f)) return true;
      log(`  kept existing signature: ${path.basename(f)}`);
      return false;
    });
    if (!pending.length) return signed;
    const run = backend() === 'signtool' ? runSigntool : runOsslsigncode;
    const r = run(mode, pending);
    if (r.ok) {
      pending.forEach((f) => log(`  signed: ${path.basename(f)}`));
      signed += pending.length;
      recordSignatures(pending.length);
      return signed;
    }
    // signtool signs file by file and stops at the first failure: what is signed is kept, the rest is tried again
    // (timestamp server busy; if the SimplySign session ended, the next attempts fail the same way and the error says so)
    const before = pending.length;
    pending = pending.filter((f) => !hasValidSignature(f));
    signed += before - pending.length;
    recordSignatures(before - pending.length);
    if (attempt === ATTEMPTS || !pending.length) {
      throw new Error(`signing failed for ${pending.length} file(s), first: ${pending[0]}\n${r.output}\n` +
        'If this says the certificate or key was not found: SimplySign Desktop is not logged in (see docs/signing-on-owner-pc.md). Start the same command again, files that are signed are kept.');
    }
    log(`  signing failed (attempt ${attempt} of ${ATTEMPTS}), trying again in 5 s: ${r.output.split('\n')[0]}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
  }
  return signed;
}

// true when the file was signed now, false when it was left as it is
function signFile(file, log = console.log) {
  return signFiles([file], log) > 0;
}

// electron-builder: called once per file and hash algorithm; sign once, with SHA-256
module.exports = async function sign(configuration) {
  if (configuration.hash && configuration.hash !== 'sha256') return;
  signFile(configuration.path);
};
module.exports.signFile = signFile;
module.exports.signFiles = signFiles;
module.exports.signArgs = signArgs;
module.exports.osslsigncodeArgs = osslsigncodeArgs;
module.exports.signaturesMade = () => signaturesMade;

if (require.main === module) {
  const files = process.argv.slice(2);
  try {
    const n = signFiles(files);
    console.log(`${n} of ${files.length} files signed`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
