// .mcpb bundles (MCP Bundles, formerly .dxt): a ZIP file with manifest.json and the server's files. StarkLLM shows the
// manifest and asks before anything is unpacked or started (docs/connections.md). This module reads the ZIP (stored or
// deflated entries; no ZIP64, no encryption), checks the manifest and builds the server entry. No Electron here.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { guessTier } = require('./connections-core');

const MAX_BUNDLE = 256 * 1024 * 1024;
const MAX_UNPACKED = 1024 * 1024 * 1024;
const MAX_FILES = 20000;
const SERVER_TYPES = ['node', 'python', 'binary', 'uv'];

// ── ZIP ──
function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('not a ZIP file');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 bundles are not supported');
  if (count > MAX_FILES) throw new Error('too many files in the bundle');
  if (cdOffset + cdSize > buf.length) throw new Error('damaged ZIP file');
  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged ZIP file');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    if (flags & 1) throw new Error('encrypted bundles are not supported');
    entries.set(name, { name, method, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const extract = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const lp = e.localOffset;
    if (buf.readUInt32LE(lp) !== 0x04034b50) throw new Error('damaged ZIP file');
    const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
    const raw = buf.slice(start, start + e.compressedSize);
    let out;
    if (e.method === 0) out = raw;
    else if (e.method === 8) out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(e.size, 1) });
    else throw new Error(`unsupported compression in ${name}`);
    if (out.length !== e.size) throw new Error(`damaged file in the bundle: ${name}`);
    return out;
  };
  return { entries, extract };
}

// a path inside the bundle, or null when it would leave the folder (../, absolute paths, drive letters)
function safeRelative(name) {
  const n = String(name).replace(/\\/g, '/');
  if (!n || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').some((s) => s === '..') || /[\u0000-\u001f]/.test(n)) return null;
  return n;
}

// ── manifest ──
const str = (v, max = 300) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function parseManifest(json) {
  let m;
  try {
    m = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (e) {
    throw new Error('manifest.json is not valid JSON');
  }
  if (!m || typeof m !== 'object') throw new Error('manifest.json is empty');
  const version = m.manifest_version || m.dxt_version;
  if (!version) throw new Error('manifest.json has no manifest_version');
  if (!m.name || !/^[\w.@/-]{1,100}$/.test(String(m.name))) throw new Error('manifest.json: name');
  if (!m.version) throw new Error('manifest.json: version');
  const s = m.server || {};
  if (!SERVER_TYPES.includes(s.type)) throw new Error(`manifest.json: server type "${str(s.type, 40)}" is not supported`);
  const cfg = s.mcp_config || {};
  if (!cfg.command || typeof cfg.command !== 'string') throw new Error('manifest.json: server.mcp_config.command');
  if (cfg.args && !Array.isArray(cfg.args)) throw new Error('manifest.json: server.mcp_config.args');
  const userConfig = {};
  for (const [k, u] of Object.entries(m.user_config || {})) {
    if (!/^[A-Za-z_][\w-]{0,40}$/.test(k) || !u || typeof u !== 'object') throw new Error(`manifest.json: user_config ${str(k, 40)}`);
    if (!['string', 'number', 'boolean', 'directory', 'file'].includes(u.type)) throw new Error(`manifest.json: user_config ${k} type`);
    userConfig[k] = u;
  }
  return {
    manifestVersion: str(version, 20),
    name: str(m.name, 100),
    displayName: str(m.display_name || m.name, 100),
    version: str(m.version, 40),
    description: str(m.description, 600),
    author: str(m.author && (m.author.name || m.author), 100),
    license: str(m.license, 60),
    homepage: str(m.homepage || m.repository && m.repository.url, 200),
    serverType: s.type,
    entryPoint: str(s.entry_point, 200),
    command: cfg.command,
    args: (cfg.args || []).map((a) => String(a)),
    env: Object.fromEntries(Object.entries(cfg.env || {}).map(([k, v]) => [String(k), String(v)])),
    tools: (Array.isArray(m.tools) ? m.tools : []).slice(0, 200).map((t) => ({ name: str(t && t.name, 64), description: str(t && t.description, 300) })).filter((t) => t.name),
    toolsGenerated: Boolean(m.tools_generated),
    userConfig,
    platforms: (m.compatibility && Array.isArray(m.compatibility.platforms)) ? m.compatibility.platforms.map((x) => str(x, 20)) : [],
  };
}

// user_config -> form fields (the same kinds as the catalog's)
function formFromManifest(man) {
  return Object.entries(man.userConfig).map(([id, u]) => ({
    id,
    kind: u.sensitive ? 'secret' : u.type === 'directory' ? 'folder' : u.type === 'boolean' ? 'checkbox' : u.type === 'number' ? 'number' : 'text',
    label: str(u.title || id, 100),
    hint: str(u.description, 300),
    required: Boolean(u.required),
    default: u.default,
  }));
}

// open a bundle: the manifest and the facts the user sees before saying yes
function inspectBundle(file) {
  const st = fs.statSync(file);
  if (st.size > MAX_BUNDLE) throw new Error('the bundle is larger than 256 MB');
  const zip = readZip(fs.readFileSync(file));
  const mf = zip.extract('manifest.json');
  if (!mf) throw new Error('the bundle has no manifest.json');
  const manifest = parseManifest(mf.toString('utf8'));
  let unpacked = 0;
  for (const e of zip.entries.values()) {
    if (!e.name.endsWith('/') && !safeRelative(e.name)) throw new Error(`a file of the bundle points outside it: ${str(e.name, 80)}`);
    unpacked += e.size;
  }
  if (unpacked > MAX_UNPACKED) throw new Error('the bundle unpacks to more than 1 GB');
  return { manifest, fileCount: zip.entries.size, unpackedSize: unpacked, form: formFromManifest(manifest), tiers: manifest.tools.map((t) => ({ name: t.name, tier: guessTier(t.name) })) };
}

function unpackBundle(file, dest) {
  const zip = readZip(fs.readFileSync(file));
  fs.mkdirSync(dest, { recursive: true });
  const root = path.resolve(dest);
  for (const e of zip.entries.values()) {
    const rel = safeRelative(e.name);
    if (!rel) throw new Error('a file of the bundle points outside it');
    const target = path.resolve(root, rel);
    if (!target.startsWith(root + path.sep)) throw new Error('a file of the bundle points outside it');
    if (rel.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, zip.extract(e.name));
  }
}

// ${__dirname}, ${user_config.x}, ${HOME} ... -> values. Secret values stay a placeholder (${secret:x}) and are filled in
// from Credential Manager only when the server starts.
function substitute(value, { dir, values, secretIds, home = require('os').homedir() }) {
  return String(value).replace(/\$\{([^}]+)\}/g, (all, name) => {
    if (name === '__dirname') return dir;
    if (name === 'HOME') return home;
    if (name === 'DESKTOP') return path.join(home, 'Desktop');
    if (name === 'DOCUMENTS') return path.join(home, 'Documents');
    if (name === 'DOWNLOADS') return path.join(home, 'Downloads');
    if (name === 'pathSeparator' || name === '/') return path.sep;
    const m = name.match(/^user_config\.([\w-]+)$/);
    if (m) {
      if (secretIds.includes(m[1])) return `\${secret:${m[1]}}`;
      const v = values[m[1]];
      return v === undefined || v === null ? '' : String(v);
    }
    return '';
  });
}

// the server entry (mcp.js) for an unpacked bundle; runtime paths come from runtimes.js
function bundleServer(man, { dir, values = {}, secretIds = [], paths }) {
  const sub = (v) => substitute(v, { dir, values, secretIds });
  const args = man.args.map(sub);
  const env = {};
  const secretEnv = {};
  for (const [k, v] of Object.entries(man.env)) {
    const only = String(v).match(/^\$\{user_config\.([\w-]+)\}$/);
    if (only && secretIds.includes(only[1])) secretEnv[k] = only[1];
    else env[k] = sub(v);
  }
  let command;
  let pre = [];
  const cmd = man.command;
  if (cmd === 'node' || man.serverType === 'node' && /(^|[\\/])node(\.exe)?$/i.test(cmd)) command = paths.node;
  else if (/^python3?(\.exe)?$/i.test(cmd) || man.serverType === 'python' && /python/i.test(path.basename(cmd))) {
    command = paths.uv;
    pre = ['run', '--no-project', '--python', '3.12', 'python'];
    Object.assign(env, { UV_PYTHON_INSTALL_DIR: paths.uvPython, UV_CACHE_DIR: paths.uvCache, UV_PYTHON_PREFERENCE: 'only-managed', UV_NO_CONFIG: '1' });
  } else if (cmd === 'uv' || cmd === 'uvx') {
    command = paths.uv;
    if (cmd === 'uvx') pre = ['tool', 'run'];
    Object.assign(env, { UV_PYTHON_INSTALL_DIR: paths.uvPython, UV_CACHE_DIR: paths.uvCache, UV_PYTHON_PREFERENCE: 'only-managed', UV_NO_CONFIG: '1' });
  } else {
    // a program of the bundle itself: it must be inside the bundle's folder
    const full = path.resolve(dir, sub(cmd));
    if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error('the bundle starts a program outside its folder');
    command = full;
  }
  return { command, args: [...pre, ...args], env, secretEnv, cwd: dir };
}

module.exports = { readZip, parseManifest, inspectBundle, unpackBundle, bundleServer, formFromManifest, substitute, safeRelative, MAX_BUNDLE };
