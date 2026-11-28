// Puts the runtimes for Settings › Connections into the installer (docs/connections.md): uv for Python servers and
// Node.js (with npm) for Node servers, so that the user installs nothing. Pinned versions; each download is checked
// against the SHA-256 written here before it is unpacked. Run by "npm run dist" (predist) on the build PC, not on the
// user's PC. Output: build/runtime/uv/uv.exe and build/runtime/node/{node.exe, node_modules/npm} (package.json
// extraResources -> resources/runtime).
//   node build/fetch-runtimes.js           Windows x64 (the release)
//   node build/fetch-runtimes.js --check   only verify what is already there
//   node build/fetch-runtimes.js --force   download and unpack again
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readZip, safeRelative } = require('../mcpb');

const RUNTIMES = [
  {
    name: 'uv',
    version: '0.13.10',
    url: 'https://github.com/astral-sh/uv/releases/download/0.13.10/uv-x86_64-pc-windows-msvc.zip',
    sha256: '297b3881fe1adfb922becc2c1613202abb41dc83ea5ff43d472aa087ca1f8683',
    dir: 'uv',
    strip: '', // uv.exe, uvx.exe, uvw.exe at the top of the archive
    keep: ['uv.exe', 'LICENSE-APACHE', 'LICENSE-MIT'], // only uv itself: one program less to sign
    check: 'uv.exe',
  },
  {
    name: 'node',
    version: '24.22.3',
    url: 'https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-x64.zip',
    sha256: 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f',
    dir: 'node',
    strip: 'node-v24.22.3-win-x64',
    keep: ['node.exe', 'LICENSE', 'node_modules/npm/'], // node and npm; not corepack, npx.cmd and the other launchers
    check: 'node.exe',
  },
];

const OUT = path.join(__dirname, 'runtime');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function download(url, file) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

function stampOf(rt) {
  return path.join(OUT, rt.dir, '.starkllm-runtime.json');
}

function upToDate(rt) {
  try {
    const s = JSON.parse(fs.readFileSync(stampOf(rt), 'utf8'));
    return s.version === rt.version && s.sha256 === rt.sha256 && fs.existsSync(path.join(OUT, rt.dir, rt.check));
  } catch (e) {
    return false;
  }
}

async function fetchOne(rt) {
  if (upToDate(rt) && !process.argv.includes('--force')) {
    console.log(`${rt.name} ${rt.version}: already there`);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `starkllm-${rt.name}-`));
  try {
    const zip = path.join(tmp, path.basename(new URL(rt.url).pathname));
    console.log(`${rt.name} ${rt.version}: downloading ${rt.url}`);
    await download(rt.url, zip);
    const got = sha256(zip);
    if (got !== rt.sha256) throw new Error(`${rt.name}: SHA-256 ${got} is not the pinned ${rt.sha256}`);
    const unpack = path.join(tmp, 'x');
    fs.mkdirSync(unpack);
    // StarkLLM's own ZIP reader (the one for .mcpb bundles): the same on every build PC, nothing outside the folder
    const archive = readZip(fs.readFileSync(zip));
    const prefix = rt.strip ? `${rt.strip}/` : '';
    for (const e of archive.entries.values()) {
      const rel = safeRelative(e.name);
      if (!rel) throw new Error(`${rt.name}: a file of the archive points outside it: ${e.name}`);
      const inner = rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
      if (!rt.keep.some((k) => (k.endsWith('/') ? inner.startsWith(k) : inner === k))) continue;
      const target = path.join(unpack, rel);
      if (rel.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, archive.extract(e.name));
    }
    const src = rt.strip ? path.join(unpack, rt.strip) : unpack;
    const dest = path.join(OUT, rt.dir);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
    if (!fs.existsSync(path.join(dest, rt.check))) throw new Error(`${rt.name}: ${rt.check} missing after unpacking`);
    fs.writeFileSync(stampOf(rt), JSON.stringify({ version: rt.version, sha256: rt.sha256, url: rt.url }, null, 1));
    console.log(`${rt.name} ${rt.version}: ok`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.includes('--check')) {
    const missing = RUNTIMES.filter((rt) => !upToDate(rt)).map((rt) => `${rt.name} ${rt.version}`);
    if (missing.length) {
      console.error(`missing or outdated runtimes: ${missing.join(', ')} (run: npm run fetch-runtimes)`);
      process.exit(1);
    }
    console.log('runtimes ok');
    return;
  }
  for (const rt of RUNTIMES) await fetchOne(rt);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { RUNTIMES };
