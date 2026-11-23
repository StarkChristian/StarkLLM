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
// Third-party files (Electron/Chromium libraries, elevate.exe: the "unsignedAllowed" list in build/unsigned-allowlist.json)
// are NOT signed by default, only our own files. STARKLLM_SIGN_THIRD_PARTY=1 signs them too: use it only if the Smart
// App Control test on Windows 11 shows that they are blocked (docs/signing-on-owner-pc.md). The NSIS plugin DLLs are
// signed only by naming them on the command line (node build/sign.js <dll>...), same condition.
// The engine without Docker (resources/engine-native) is different: its unsigned files are always signed, because Smart
// App Control blocked them (2.2.0 test, 17 Nov 2026: ctranslate2's _ext.pyd). Files with a valid signature of another
// publisher (the Python Software Foundation's python.exe) keep it; an expired one (Tesseract's) is replaced by ours.
// Files that already carry a valid signature (ours from an earlier run, Microsoft's d3dcompiler_47.dll in Electron)
// are left as they are, so a run that stopped half way (SimplySign session expired) can simply be started again.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const { backend, signtoolPath, inspect, loadAllowlist, findAllowed } = require('./signature');

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

// ── Signatures kept for the next build (STARKLLM_SIGN_CACHE, set by release-sign.js) ──
// Most program files of a release do not change from one build to the next (the engine's Python packages, Tesseract):
// about 230 of the 233 signatures of a build. The signed copy of a file is kept under the SHA-256 of the unsigned file;
// the next build puts the same signed copy in place instead of signing the same bytes again. A kept copy is used only
// when its signature is valid now (signtool verify: certificate, timestamp), and every file is checked again after the
// build (check-signed.js), so a wrong entry cannot reach a release. The cloud certificate counts signatures (5000 a month).
function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// files -> { pending: the files still to sign, keys: file -> hash of its unsigned bytes, reused: how many got their copy }
function reuseKept(files, dir, isValid = hasValidSignature, log = console.log) {
  const keys = new Map();
  if (!dir) return { pending: files, keys, reused: 0 };
  fs.mkdirSync(dir, { recursive: true });
  let reused = 0;
  const pending = files.filter((f) => {
    if (!fs.existsSync(f) || isValid(f)) return true; // already signed: kept by signFilesNow
    const key = fileSha256(f);
    keys.set(f, key);
    const kept = path.join(dir, key);
    if (!fs.existsSync(kept)) return true;
    const tmp = `${f}.kept`;
    fs.copyFileSync(kept, tmp);
    if (!isValid(tmp)) { fs.rmSync(tmp, { force: true }); return true; }
    fs.renameSync(tmp, f);
    reused++;
    log(`  reused kept signature: ${path.basename(f)}`);
    return false;
  });
  return { pending, keys, reused };
}

// after signing: the signed copies of the files that were unsigned before, under the hash of their unsigned bytes
function keepSigned(keys, dir, isValid = hasValidSignature) {
  if (!dir) return 0;
  let kept = 0;
  for (const [f, key] of keys) {
    const to = path.join(dir, key);
    if (fs.existsSync(to) || !fs.existsSync(f) || !isValid(f)) continue;
    fs.copyFileSync(f, `${to}.tmp`);
    fs.renameSync(`${to}.tmp`, to);
    kept++;
  }
  return kept;
}

// Signs the files that carry no valid signature yet, in as few signtool calls as possible (one signature per file,
// the cloud certificate counts signatures); files whose signed copy was kept from an earlier build get that copy.
// Returns how many files were signed now.
function signFiles(files, log = console.log) {
  if (!process.env.STARKLLM_SIGN) return 0;
  const dir = process.env.STARKLLM_SIGN_CACHE || '';
  const reuse = reuseKept(files, dir, hasValidSignature, log);
  if (reuse.reused) log(`  ${reuse.reused} signature(s) reused from earlier builds (${dir})`);
  try {
    return signFilesNow(reuse.pending, log);
  } finally {
    keepSigned(reuse.keys, dir);
  }
}

function signFilesNow(files, log = console.log) {
  const mode = process.env.STARKLLM_SIGN;
  if (!mode) return 0;
  let pending = files;
  if (!process.env.STARKLLM_SIGN_THIRD_PARTY) {
    const third = loadAllowlist().unsigned;
    pending = files.filter((f) => {
      if (!findAllowed(third, f)) return true;
      log(`  not signed (third-party file, STARKLLM_SIGN_THIRD_PARTY is not set): ${path.basename(f)}`);
      return false;
    });
  }
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
module.exports.reuseKept = reuseKept;
module.exports.keepSigned = keepSigned;
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
