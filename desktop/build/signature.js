// Shared helpers for code signing: which tool signs and verifies on this machine, reading the signer of a file,
// the publisher name check that electron-updater does, and the list of files that may stay unsigned.
//
// Two backends:
//   signtool       Windows. The only one that can use the Certum certificate in the Windows certificate store,
//                  and the one that produces the signatures users get.
//   osslsigncode   Linux/macOS. Only for dry runs with a self-signed test certificate (CI, the server): it proves the
//                  steps and the checks work without the real certificate. Select with STARKLLM_SIGN_BACKEND.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PE_EXTENSIONS = /\.(exe|dll|node|pyd|sys|ocx|scr)$/i;

function backend() {
  const b = process.env.STARKLLM_SIGN_BACKEND;
  if (b) {
    if (b !== 'signtool' && b !== 'osslsigncode') throw new Error(`unknown STARKLLM_SIGN_BACKEND=${b} (use signtool or osslsigncode)`);
    return b;
  }
  return process.platform === 'win32' ? 'signtool' : 'osslsigncode';
}

function signtoolPath() {
  if (process.env.SIGNTOOL_PATH) return process.env.SIGNTOOL_PATH;
  const base = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  const versions = fs.existsSync(base) ? fs.readdirSync(base).filter((v) => /^10\.\d/.test(v)) : [];
  versions.sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  for (const v of versions) {
    const exe = path.join(base, v, 'x64', 'signtool.exe');
    if (fs.existsSync(exe)) return exe;
  }
  throw new Error('signtool.exe not found (Windows SDK); set SIGNTOOL_PATH');
}

// "/CN=A, B/O=C" (OpenSSL) -> 'CN="A, B", O=C' (what PowerShell shows and electron-updater sees)
function opensslSubjectToWindows(subject) {
  const parts = subject.split(/\/(?=[A-Za-z][A-Za-z0-9.]*=)/).filter(Boolean);
  return parts.map((p) => {
    const i = p.indexOf('=');
    const key = p.slice(0, i);
    const value = p.slice(i + 1);
    return /[,+="<>#;]/.test(value) ? `${key}="${value.replace(/"/g, '""')}"` : `${key}=${value}`;
  }).join(', ');
}

// What the file carries. state: 'valid' (signature checks out and is trusted), 'unsigned', 'invalid' (a signature
// is there but broken, changed after signing or not trusted). subject like PowerShell prints it, timestamped boolean.
function inspect(file) {
  if (backend() === 'signtool') {
    const script = `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; ` +
      `[pscustomobject]@{ Status = [string]$s.Status; Subject = $s.SignerCertificate.Subject; Thumbprint = $s.SignerCertificate.Thumbprint; ` +
      `Timestamped = [bool]$s.TimeStamperCertificate } | ConvertTo-Json -Compress`;
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error(`Get-AuthenticodeSignature failed for ${file}: ${r.stderr || r.stdout}`);
    const j = JSON.parse(r.stdout);
    const state = j.Status === 'Valid' ? 'valid' : j.Status === 'NotSigned' ? 'unsigned' : 'invalid';
    return { state, status: j.Status, subject: j.Subject || null, thumbprint: j.Thumbprint || null, timestamped: !!j.Timestamped };
  }
  const args = ['verify'];
  if (process.env.STARKLLM_TEST_CA) args.push('-CAfile', process.env.STARKLLM_TEST_CA);
  args.push('-in', file);
  const r = spawnSync('osslsigncode', args, { encoding: 'utf8' });
  if (r.error) throw new Error(`osslsigncode not found (apt install osslsigncode): ${r.error.message}`);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (/No signature found/.test(out)) return { state: 'unsigned', status: 'NotSigned', subject: null, timestamped: false };
  const m = out.match(/Subject: (\/.*)/);
  const subject = m ? opensslSubjectToWindows(m[1].trim()) : null;
  const timestamped = !/Timestamp is not available/.test(out);
  const ok = /Signature verification: ok/.test(out) && r.status === 0;
  return { state: ok ? 'valid' : 'invalid', status: ok ? 'Valid' : 'NotTrusted', subject, timestamped };
}

// ---- publisher name, as electron-updater checks it (windowsExecutableCodeSignatureVerifier.js) ----
const { parseDn } = require('builder-util-runtime');

// true when electron-updater, configured with these publisher names, accepts a file signed with this subject
function publisherMatches(publisherNames, subject) {
  const names = Array.isArray(publisherNames) ? publisherNames : [publisherNames];
  const have = parseDn(subject || '');
  for (const name of names) {
    const dn = parseDn(name);
    if (dn.size) {
      if ([...dn.keys()].every((k) => dn.get(k) === have.get(k))) return true;
    } else if (name === have.get('CN')) {
      return true;
    }
  }
  return false;
}

function commonName(subject) {
  return parseDn(subject || '').get('CN') || null;
}

function configuredPublisherNames(pkg) {
  const w = (pkg.build && pkg.build.win) || {};
  const v = (w.signtoolOptions && w.signtoolOptions.publisherName) || w.publisherName || null;
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).filter(Boolean);
}

// ---- files that may stay unsigned ----
const ALLOWLIST_FILE = path.join(__dirname, 'unsigned-allowlist.json');

function loadAllowlist(file = ALLOWLIST_FILE) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { unsigned: j.unsignedAllowed || [], foreign: j.foreignSignatureAllowed || [] };
}

function globToRegExp(glob) {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*');
  return new RegExp(`(^|/)${body}$`, 'i');
}

// rel: path relative to the checked folder, any slashes
function findAllowed(list, rel) {
  const p = rel.replace(/\\/g, '/');
  return list.find((e) => globToRegExp(e.pattern).test(p)) || null;
}

function listPeFiles(dir) {
  const out = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (PE_EXTENSIONS.test(e.name)) out.push(p);
  });
  walk(dir);
  return out.sort();
}

module.exports = {
  PE_EXTENSIONS, backend, signtoolPath, inspect, opensslSubjectToWindows, publisherMatches, commonName,
  configuredPublisherNames, loadAllowlist, findAllowed, listPeFiles, ALLOWLIST_FILE,
};
