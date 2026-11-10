// Code signing for every Windows file StarkLLM ships (roadmap phase 0, "Windows trust"). Windows Smart App Control
// checks each EXE and DLL when it is loaded and blocks unsigned files it does not know (seen 9 and 10 Nov 2026 on a
// real PC: the 2.0.8 update and the 2.0.10 installer).
//
// electron-builder calls this for the app, its DLLs and .node files (win.signExts), the uninstaller and the installer.
// CI also runs it from the command line for the NSIS plugin DLLs before the build:  node build/sign.js <file>...
//
// STARKLLM_SIGN selects how:
//   (unset)  no signing: local builds and pull requests without a certificate
//   test     a test certificate (CI): STARKLLM_SIGN_PFX, STARKLLM_SIGN_PFX_PASSWORD; proves every file gets signed
//   azure    Azure Artifact Signing: STARKLLM_AZURE_DLIB (Azure.CodeSigning.Dlib.dll), STARKLLM_AZURE_METADATA (json)
// Files that already carry a valid signature of their own publisher (Microsoft's d3dcompiler_47.dll in Electron,
// python.org's python.exe) are left as they are.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const AZURE_TIMESTAMP = 'http://timestamp.acs.microsoft.com';

function signtool() {
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

function hasValidSignature(tool, file) {
  return spawnSync(tool, ['verify', '/pa', '/q', file], { windowsHide: true }).status === 0;
}

function signArgs(mode, file) {
  if (mode === 'test') {
    const pfx = process.env.STARKLLM_SIGN_PFX;
    if (!pfx) throw new Error('STARKLLM_SIGN=test needs STARKLLM_SIGN_PFX');
    return ['sign', '/fd', 'sha256', '/f', pfx, '/p', process.env.STARKLLM_SIGN_PFX_PASSWORD || '', file];
  }
  if (mode === 'azure') {
    const dlib = process.env.STARKLLM_AZURE_DLIB;
    const metadata = process.env.STARKLLM_AZURE_METADATA;
    if (!dlib || !metadata) throw new Error('STARKLLM_SIGN=azure needs STARKLLM_AZURE_DLIB and STARKLLM_AZURE_METADATA');
    return ['sign', '/fd', 'sha256', '/tr', AZURE_TIMESTAMP, '/td', 'sha256', '/dlib', dlib, '/dmdf', metadata, file];
  }
  throw new Error(`unknown STARKLLM_SIGN=${mode} (use test or azure)`);
}

// true when the file was signed now, false when it was left as it is
function signFile(file, log = console.log) {
  const mode = process.env.STARKLLM_SIGN;
  if (!mode) return false;
  const tool = signtool();
  if (hasValidSignature(tool, file)) {
    log(`  kept existing signature: ${path.basename(file)}`);
    return false;
  }
  const r = spawnSync(tool, signArgs(mode, file), { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`signing ${file} failed: ${(r.stdout || '') + (r.stderr || '')}`.trim());
  log(`  signed: ${path.basename(file)}`);
  return true;
}

// electron-builder: called once per file and hash algorithm; sign once, with SHA-256
module.exports = async function sign(configuration) {
  if (configuration.hash && configuration.hash !== 'sha256') return;
  signFile(configuration.path);
};
module.exports.signFile = signFile;
module.exports.signArgs = signArgs;

if (require.main === module) {
  const files = process.argv.slice(2);
  let signed = 0;
  for (const f of files) if (signFile(f)) signed++;
  console.log(`${signed} of ${files.length} files signed`);
}
