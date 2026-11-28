// Connections (docs/connections.md): the catalog of apps StarkLLM can connect to through MCP, the forms made from it,
// the risk tier of each tool, the pins of each tool's name, description and schema, and the rule that no connection
// listens on every network interface. No Electron here: desktop/test/connections.test.js tests all of it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { classify, hostOf } = require('./netguard');

const LANGS = ['en', 'de', 'es', 'fr', 'it', 'tr'];
const TIERS = ['read', 'write', 'exec'];
const FIELD_KINDS = ['folder', 'secret', 'url', 'text', 'number', 'checkbox'];
const CATEGORIES = ['files', 'notes', 'research', 'home', '3d', 'images', 'video', 'developer', 'office', 'system', 'bundle'];
const NETWORK = ['offline', 'lan', 'cloud'];
const RUNTIMES = ['npm', 'uv', 'builtin', 'none'];
const CATALOG_FILE = path.join(__dirname, 'connections', 'catalog.json');
const CONNECTORS_DIR = path.join(__dirname, 'connectors');
// an exact version: 1.2.3, 2026.11.27, 1.0.0-rc.1 (no ranges, no "latest")
const EXACT_VERSION = /^\d+(\.\d+){1,3}(-[0-9A-Za-z.]+)?$/;
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;

function loadCatalog(file = CATALOG_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// a text of the catalog in one language: a plain string (a brand name), "@name" (a shared text), or { en, de, ... }
function text(value, lang, texts = {}) {
  let v = value;
  if (typeof v === 'string' && v.startsWith('@')) v = texts[v.slice(1)];
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return v[lang] || v.en || '';
}

function isLocalized(value, texts) {
  let v = value;
  if (typeof v === 'string' && v.startsWith('@')) v = texts[v.slice(1)];
  if (typeof v === 'string') return v.trim().length > 0;
  return Boolean(v) && LANGS.every((l) => typeof v[l] === 'string' && v[l].trim().length > 0);
}

// ── no connection may listen on every interface (0.0.0.0, ::) ──
const ALL_INTERFACES = /(^|[^0-9.])0\.0\.0\.0([^0-9.]|$)|^\[?::\]?$|^\[::\](:\d+)?$/;

// the address of an HTTP connection: this PC, or (only where the catalog allows it) the home network
function checkUrl(url, { allowLan = false } = {}) {
  let u;
  try {
    u = new URL(String(url || ''));
  } catch (e) {
    return 'invalid-url';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'invalid-url';
  if (u.username || u.password) return 'invalid-url';
  const host = hostOf(u.href);
  if (host === '0.0.0.0' || host === '::' || host === '0:0:0:0:0:0:0:0') return 'binds-all';
  const zone = classify(host);
  if (zone === 'this_pc') return null;
  if (zone === 'lan' && allowLan) return null;
  return zone === 'lan' ? 'lan-not-allowed' : 'not-local';
}

// a configuration that would make a server listen on every interface is refused
function checkBinding({ args = [], env = {}, url = '', allowLan = false } = {}) {
  for (const a of args) if (ALL_INTERFACES.test(String(a).trim())) return 'binds-all';
  for (const [k, v] of Object.entries(env || {})) {
    if (ALL_INTERFACES.test(String(v).trim())) return 'binds-all';
    // HOST=:: and the like
    if (/(^|_)(HOST|BIND|LISTEN|ADDRESS|ADDR)$/i.test(k) && /^\[?::\]?$/.test(String(v).trim())) return 'binds-all';
  }
  if (url) return checkUrl(url, { allowLan });
  return null;
}

// ── catalog validation ──
function validateCatalog(cat) {
  const errors = [];
  const err = (id, msg) => errors.push(`${id}: ${msg}`);
  if (!cat || !Array.isArray(cat.entries)) return ['catalog: no entries'];
  const texts = cat.texts || {};
  for (const [k, v] of Object.entries(texts)) if (!isLocalized(v, {})) err(`texts.${k}`, 'needs en, de, es, fr, it, tr');
  const ids = new Set();
  for (const e of cat.entries) {
    const id = (e && e.id) || '?';
    if (!ID.test(id)) err(id, 'bad id');
    if (ids.has(id)) err(id, 'duplicate id');
    ids.add(id);
    if (!['ready', 'planned'].includes(e.status)) err(id, 'status must be ready or planned');
    if (!isLocalized(e.name, texts)) err(id, 'name');
    if (!isLocalized(e.description, texts)) err(id, 'description needs six languages');
    if (!CATEGORIES.includes(e.category)) err(id, `category ${e.category}`);
    if (!NETWORK.includes(e.network)) err(id, `network ${e.network}`);
    if (!e.publisher || !e.license) err(id, 'publisher and license');
    if (e.lastUpdate && !/^\d{4}-\d{2}-\d{2}$/.test(e.lastUpdate)) err(id, 'lastUpdate is YYYY-MM-DD');
    if (e.needsApp != null && !isLocalized(e.needsApp, texts)) err(id, 'needsApp needs six languages');
    for (const s of e.steps || []) if (!isLocalized(s, texts)) err(id, 'a step needs six languages');
    if (e.advanced && !isLocalized(e.advancedWarning, texts)) err(id, 'an advanced entry needs a warning in six languages');
    if (e.status === 'planned') continue;
    const p = e.package || {};
    if (!RUNTIMES.includes(p.runtime)) err(id, `runtime ${p.runtime}`);
    if (p.runtime === 'npm' || p.runtime === 'uv') {
      if (!p.name || !/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\[[a-z0-9,_-]+\])?$/i.test(p.name)) err(id, 'package name');
      if (!EXACT_VERSION.test(String(p.version || ''))) err(id, `version "${p.version}" is not pinned exactly`);
      if (!p.bin || !/^[\w.-]+$/.test(p.bin)) err(id, 'bin');
      if (p.python && !/^3\.\d{1,2}$/.test(p.python)) err(id, 'python version');
      if (p.runtime === 'uv' && !p.python) err(id, 'uv packages name their Python version');
      for (const k of ['pythonEnv', 'dataDirEnv']) if (p[k] && !/^[A-Z_][A-Z0-9_]{0,63}$/.test(p[k])) err(id, `${k} must be a variable name`);
    }
    if (p.runtime === 'builtin' && (!p.script || !/^[\w.-]+\.js$/.test(p.script) || !fs.existsSync(path.join(CONNECTORS_DIR, p.script)))) err(id, 'builtin script missing');
    for (const s of p.setup || []) if (!Array.isArray(s) || s.some((a) => typeof a !== 'string' || /[{}]/.test(a))) err(id, 'setup steps are fixed argument lists');
    if (!['stdio', 'http'].includes(e.transport)) err(id, 'transport');
    if (e.transport === 'http' && !e.url) err(id, 'http needs url');
    if (e.transport === 'stdio' && p.runtime === 'none') err(id, 'stdio needs a runtime');
    // fields
    const fieldIds = new Set();
    for (const f of e.fields || []) {
      if (!f.id || !/^[A-Za-z][A-Za-z0-9]{0,30}$/.test(f.id)) err(id, `field id ${f.id}`);
      if (fieldIds.has(f.id)) err(id, `field ${f.id} twice`);
      fieldIds.add(f.id);
      if (!FIELD_KINDS.includes(f.kind)) err(id, `field ${f.id} kind ${f.kind}`);
      if (!isLocalized(f.label, texts)) err(id, `field ${f.id} label needs six languages`);
      if (f.hint && !isLocalized(f.hint, texts)) err(id, `field ${f.id} hint needs six languages`);
      if (f.unlocks && (f.kind !== 'checkbox' || !TIERS.includes(f.unlocks))) err(id, `field ${f.id} unlocks`);
      if (f.kind === 'secret' && !f.env && !f.header) err(id, `secret ${f.id} goes nowhere (env or header)`);
      if (f.env && !/^[A-Z_][A-Z0-9_]{0,63}$/.test(f.env)) err(id, `field ${f.id} env name`);
    }
    const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    for (const a of e.args || []) {
      for (const ph of placeholders(a)) {
        if (!fieldIds.has(ph)) err(id, `argument {${ph}} has no field`);
        const f = (e.fields || []).find((x) => x.id === ph);
        if (f && f.kind === 'secret') err(id, `secret ${ph} must not be an argument (the command line is visible to other programs)`);
      }
    }
    for (const v of Object.values(e.env || {})) {
      for (const ph of placeholders(v)) {
        const f = (e.fields || []).find((x) => x.id === ph);
        if (!f) err(id, `env {${ph}} has no field`);
        else if (f.kind === 'secret') err(id, `secret ${ph} belongs in the field's env, not in a template`);
      }
    }
    if (e.url && placeholders(e.url).some((ph) => !fieldIds.has(ph))) err(id, 'url placeholder');
    if (e.url && !placeholders(e.url).length) {
      const why = checkUrl(e.url, { allowLan: Boolean(e.allowLan) });
      if (why) err(id, `url ${why}`);
    }
    if (e.allowLan && e.network !== 'lan') err(id, 'allowLan needs network "lan" (a privacy row)');
    const bind = checkBinding({ args: e.args || [], env: e.env || {} });
    if (bind) err(id, bind);
    // tiers
    const tiers = e.tiers || {};
    for (const t of TIERS) if (!Array.isArray(tiers[t])) err(id, `tiers.${t} must be a list`);
    if (!TIERS.includes(e.defaultTier)) err(id, 'defaultTier');
    if (!Array.isArray(e.blockedTools)) err(id, 'blockedTools must be a list');
    if (!Array.isArray(e.untrustedOutput)) err(id, 'untrustedOutput must be a list');
  }
  return errors;
}

// ── forms ──
// the fields of an entry as the Settings page shows them, in one language
function formFor(entry, lang = 'en', texts = {}) {
  return (entry.fields || []).map((f) => {
    const out = { id: f.id, kind: f.kind, label: text(f.label, lang, texts), required: Boolean(f.required) };
    if (f.hint) out.hint = text(f.hint, lang, texts);
    if (f.default !== undefined) out.default = f.default;
    if (f.kind === 'url') out.placeholder = String(f.default || 'http://127.0.0.1:8000');
    if (f.lan) out.lan = true;
    if (f.unlocks) out.unlocks = f.unlocks;
    return out;
  });
}

const BAD_TEXT = /[\u0000-\u001f\u007f]/;
// Windows paths (C:\..., \\server\share) or absolute POSIX paths
const ABSOLUTE = /^([A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/)/;

// the user's answers -> the parts of a server entry; secrets come back apart and never enter the entry
function applyForm(entry, values = {}) {
  const errors = [];
  const v = {};
  const secrets = {};
  const unlocked = [];
  for (const f of entry.fields || []) {
    let x = values[f.id];
    if (x === undefined || x === null || x === '') x = f.default;
    if (f.kind === 'checkbox') {
      v[f.id] = x === true || x === 'true';
      if (v[f.id] && f.unlocks) unlocked.push(f.unlocks);
      continue;
    }
    if (x === undefined || x === null || x === '') {
      if (f.required) errors.push({ field: f.id, error: 'required' });
      continue;
    }
    const s = String(x).trim();
    if (BAD_TEXT.test(s) || s.length > 2000) { errors.push({ field: f.id, error: 'invalid' }); continue; }
    if (f.kind === 'secret') { secrets[f.id] = s; continue; }
    if (f.kind === 'folder') {
      // the command shell expands %VAR% and !VAR!; a folder with them is refused (mcp-client.js says why)
      if (!ABSOLUTE.test(s) || /[%!"<>|]/.test(s)) { errors.push({ field: f.id, error: 'folder' }); continue; }
    }
    if (f.kind === 'number') {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 1 || n > 65535) { errors.push({ field: f.id, error: 'number' }); continue; }
    }
    if (f.kind === 'url') {
      const why = checkUrl(s, { allowLan: Boolean(f.lan && entry.allowLan) });
      if (why) { errors.push({ field: f.id, error: why }); continue; }
    }
    if (f.kind === 'text' && s.length > 500) { errors.push({ field: f.id, error: 'invalid' }); continue; }
    v[f.id] = s;
  }
  const fill = (tpl) => String(tpl).replace(/\{(\w+)\}/g, (_, k) => (v[k] === undefined ? '' : String(v[k])));
  const args = (entry.args || []).map(fill);
  const env = {};
  for (const [k, val] of Object.entries(entry.env || {})) env[k] = fill(val);
  const secretEnv = {};
  const secretHeaders = {};
  for (const f of entry.fields || []) {
    if (f.kind === 'checkbox' && f.env) env[f.env] = v[f.id] ? 'true' : 'false';
    else if (f.kind !== 'secret' && f.env && v[f.id] !== undefined) env[f.env] = String(v[f.id]);
    if (f.kind === 'secret' && secrets[f.id] !== undefined) {
      if (f.env) secretEnv[f.env] = f.id;
      if (f.header) secretHeaders[f.header] = { field: f.id, format: f.format || '{value}' };
    }
  }
  const url = entry.url ? fill(entry.url) : '';
  const bind = checkBinding({ args, env, url, allowLan: Boolean(entry.allowLan) });
  if (bind) errors.push({ field: url ? 'url' : '', error: bind });
  return { ok: errors.length === 0, errors, args, env, url, secretEnv, secretHeaders, secrets, unlocked, values: v };
}

// ── risk tiers ──
const glob = (pattern) => new RegExp(`^${String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
const matches = (list, name) => (list || []).some((p) => glob(p).test(name));
const RANK = { read: 0, write: 1, exec: 2 };

// "blocked" (can never be turned on), "read", "write" or "exec" (exec, send or delete)
// An exact name wins; among patterns the most dangerous tier wins; else the entry's default.
function tierOf(entry, toolName) {
  const name = String(toolName || '');
  if (matches(entry.blockedTools, name)) return 'blocked';
  const tiers = entry.tiers || {};
  for (const t of ['exec', 'write', 'read']) if ((tiers[t] || []).includes(name)) return t;
  for (const t of ['exec', 'write', 'read']) if ((tiers[t] || []).some((p) => p.includes('*') && glob(p).test(name))) return t;
  return TIERS.includes(entry.defaultTier) ? entry.defaultTier : 'exec';
}

const EXEC_WORDS = new Set(['delete', 'remove', 'rm', 'unlink', 'send', 'exec', 'execute', 'run', 'eval', 'shell', 'command', 'cmd', 'script',
  'code', 'post', 'publish', 'email', 'mail', 'drop', 'kill', 'format', 'install', 'uninstall', 'reset', 'push', 'purge', 'destroy', 'transfer',
  'pay', 'payment', 'tweet', 'sms', 'call', 'powershell', 'bash', 'terminal', 'sudo', 'wipe', 'truncate']);
const READ_VERBS = new Set(['get', 'list', 'read', 'search', 'find', 'fetch', 'show', 'describe', 'query', 'view', 'count', 'status', 'lookup',
  'inspect', 'preview', 'browse', 'ls', 'info', 'stat', 'check']);

// a tool of a server outside the catalog (a .mcpb bundle, a server added by hand): guessed from its name.
// The server's own hints (readOnlyHint ...) come from the server and are not trusted for this.
function guessTier(toolName) {
  const words = String(toolName || '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => EXEC_WORDS.has(w))) return 'exec';
  if (words.length && READ_VERBS.has(words[0])) return 'read';
  return 'write';
}

const isUntrustedOutput = (entry, toolName) => matches(entry.untrustedOutput, String(toolName || ''));

// ── pins: a tool's name, description and input schema, hashed when the connection is installed ──
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value === undefined ? null : value);
}

function hashTool(tool) {
  const t = tool || {};
  return crypto.createHash('sha256').update(canonical({ name: t.name || '', description: t.description || '', inputSchema: t.inputSchema || t.parameters || {} })).digest('hex');
}

function pinTools(rawTools) {
  const pins = {};
  for (const t of rawTools || []) if (t && t.name) pins[t.name] = hashTool(t);
  return pins;
}

// what changed since the pins were taken: changed and added tools need the user's look again
function comparePins(pins, rawTools) {
  const now = pinTools(rawTools);
  const changed = [];
  const added = [];
  for (const [name, h] of Object.entries(now)) {
    if (!(name in (pins || {}))) added.push(name);
    else if (pins[name] !== h) changed.push(name);
  }
  const removed = Object.keys(pins || {}).filter((n) => !(n in now));
  return { changed, added, removed, current: now };
}

// the catalog as the Settings page shows it, in one language
function catalogView(cat, lang = 'en') {
  const texts = cat.texts || {};
  return cat.entries.map((e) => ({
    id: e.id,
    status: e.status,
    advanced: Boolean(e.advanced),
    name: text(e.name, lang, texts),
    description: text(e.description, lang, texts),
    category: e.category,
    publisher: e.publisher,
    license: e.license,
    lastUpdate: e.lastUpdate || '',
    homepage: e.homepage || '',
    network: e.network,
    package: e.package && e.package.name ? `${e.package.name}@${e.package.version}` : (e.package && e.package.requires) || '',
    runtime: (e.package && e.package.runtime) || 'none',
    needsApp: e.needsApp ? text(e.needsApp, lang, texts) : '',
    steps: (e.steps || []).map((s) => text(s, lang, texts)),
    advancedWarning: e.advancedWarning ? text(e.advancedWarning, lang, texts) : '',
    readOnlyByDefault: Boolean(e.readOnlyByDefault),
    fields: formFor(e, lang, texts),
  }));
}

module.exports = {
  LANGS, TIERS, FIELD_KINDS, CATALOG_FILE, EXACT_VERSION,
  loadCatalog, validateCatalog, text, formFor, applyForm, checkUrl, checkBinding,
  tierOf, guessTier, isUntrustedOutput, hashTool, pinTools, comparePins, canonical, catalogView, glob,
};
