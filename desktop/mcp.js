// MCP servers of the user (docs/roadmap-2026-12.md, R6; docs/connections.md): the list in the profile folder
// (mcp-servers.json), the running connections, and the IPC for Settings and the tool card in the chat. The protocol is in
// mcp-client.js; the catalog, risk tiers and pins in connections-core.js; the per-call rules in tool-policy.js.
// Three kinds of servers share this list: "manual" (Settings › Local Tools), "catalog" and "bundle" (Settings ›
// Connections, connections.js). Secrets are never in this list: only the names under which Windows Credential Manager
// keeps them.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const client = require('./mcp-client');
const core = require('./connections-core');
const { createPolicy } = require('./tool-policy');
const { getShared } = require('./netguard');

const MAX_SERVERS = 24;
const connections = new Map(); // server id -> { conn, tools, raw, server, error }
let isOffline = () => false;
let policy = createPolicy();
let secretStore = null; // set by connections.js (secret-store.js)
let resolveLaunch = () => null; // set by connections.js: catalog and bundle entries -> { command, args, env }
let log = () => {};

function file() {
  return path.join(app.getPath('userData'), 'mcp-servers.json');
}

function readServers() {
  try {
    const list = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function writeServers(list) {
  fs.writeFileSync(file(), JSON.stringify(list.slice(0, MAX_SERVERS), null, 1));
}

function updateServer(id, fn) {
  const list = readServers().map((s) => (s.id === id ? fn(s) : s));
  writeServers(list);
  return list.find((s) => s.id === id);
}

// the user's environment without secrets, plus the variables the user set for this server
function serverEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/token|secret|passw|pwd$|api_?key|private|credential|^starkllm|^electron|^aws_|^azure_|^gh_|^github_/i.test(k)) continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(extra || {})) if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) env[k] = String(v).slice(0, 4000);
  return env;
}

// a server from the Settings form -> the stored entry, or null
function cleanServer(input, id) {
  const name = String((input && input.name) || '').trim().slice(0, 60);
  const transport = input && input.transport === 'http' ? 'http' : 'stdio';
  if (!name) return null;
  const entry = { id, name, transport, kind: 'manual', enabledTools: [] };
  if (transport === 'http') {
    const url = client.localUrl(input.url);
    if (!url) return null;
    entry.url = url;
  } else {
    const command = String(input.command || '').trim().slice(0, 500);
    if (!command) return null;
    entry.command = command;
    entry.args = (Array.isArray(input.args) ? input.args : String(input.args || '').split(/\s+/)).map((a) => String(a)).filter(Boolean).slice(0, 40);
    entry.env = {};
    for (const [k, v] of Object.entries(input.env || {})) if (/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) entry.env[k] = String(v).slice(0, 4000);
  }
  // never a server that listens on every network interface
  if (core.checkBinding({ args: entry.args || [], env: entry.env || {}, url: entry.url || '' })) return null;
  return entry;
}

// ── tiers of a server's tools ──
// catalog entries carry the catalog's rules; other servers: guessed from the name, and their output counts as untrusted
function toolTier(entry, tool) {
  return entry.rules ? core.tierOf(entry.rules, tool) : core.guessTier(tool);
}
function toolLocked(entry, tool) {
  const tier = toolTier(entry, tool);
  if (tier === 'blocked') return 'blocked';
  if (entry.readOnly && tier !== 'read') return 'read-only';
  if ((entry.changedTools || []).includes(tool)) return 'changed';
  return '';
}
const untrustedOutput = (entry, tool) => (entry.rules ? core.isUntrustedOutput(entry.rules, tool) : true);

function stop(id) {
  const c = connections.get(id);
  if (c && c.conn) c.conn.close();
  connections.delete(id);
}

function stopAll() {
  for (const id of [...connections.keys()]) stop(id);
}

const fillSecrets = (s, values) => String(s).replace(/\$\{secret:([\w-]+)\}/g, (_, k) => (values[k] == null ? '' : values[k]));

async function readSecrets(entry) {
  const values = {};
  for (const [field, ref] of Object.entries(entry.secretRefs || {})) {
    if (!secretStore) throw new Error('secrets are not available');
    const v = await secretStore.get(ref);
    if (v == null) throw new Error('a saved secret of this connection is missing: remove the connection and add it again');
    values[field] = v;
  }
  return values;
}

async function start(entry) {
  stop(entry.id);
  if (isOffline()) throw new Error('StarkLLM is fully offline: tool servers are off.');
  const bind = core.checkBinding({ args: entry.args || [], env: entry.env || {}, url: entry.url || '', allowLan: Boolean(entry.allowLan) });
  if (bind) throw new Error(bind === 'binds-all' ? 'refused: this server would listen on every network interface (0.0.0.0)' : `refused: ${bind}`);
  const secrets = await readSecrets(entry);
  let conn;
  if (entry.transport === 'http') {
    const headers = {};
    for (const [h, spec] of Object.entries(entry.secretHeaders || {})) headers[h] = String(spec.format || '{value}').replace('{value}', secrets[spec.field] || '');
    let base = fetch;
    if (entry.tls === 'pin') {
      const { pinnedFetch } = require('./pinned-https');
      base = pinnedFetch({ pin: entry.tlsPin || '', onPin: (fp) => updateServer(entry.id, (s) => ({ ...s, tlsPin: fp })) });
    }
    const purpose = entry.allowLan ? `A connection on the home network: ${entry.name}` : 'A tool server (MCP) on this PC';
    conn = new client.HttpConnection({ url: entry.url, allowLan: Boolean(entry.allowLan), headers, fetchFn: getShared().wrapFetch(base, 'mcp', purpose) });
  } else {
    const launch = entry.kind && entry.kind !== 'manual' ? resolveLaunch(entry) : null;
    if (entry.kind && entry.kind !== 'manual' && !launch) throw new Error('this connection is not installed');
    const secretEnv = {};
    for (const [k, field] of Object.entries(entry.secretEnv || {})) secretEnv[k] = secrets[field] || '';
    conn = new client.StdioConnection({
      command: launch ? launch.command : entry.command,
      args: [...(launch ? launch.args : []), ...(entry.args || []).map((a) => fillSecrets(a, secrets))],
      cwd: entry.cwd || undefined,
      env: serverEnv({ ...(entry.env || {}), ...((launch && launch.env) || {}), ...secretEnv }),
    });
  }
  try {
    const r = await client.connect(conn);
    let current = readServers().find((s) => s.id === entry.id) || entry;
    // pins: taken at the first start after installation; a later change of a tool turns it off until the user looks again
    if (!current.pins) {
      current = updateServer(entry.id, (s) => ({ ...s, pins: core.pinTools(r.raw), changedTools: [] })) || current;
    } else {
      const cmp = core.comparePins(current.pins, r.raw);
      const changed = [...cmp.changed, ...cmp.added];
      if (changed.length) {
        log(`MCP server ${entry.name}: tools changed since installation: ${changed.join(', ')}`);
        current = updateServer(entry.id, (s) => ({ ...s, changedTools: [...new Set([...(s.changedTools || []), ...changed])], enabledTools: (s.enabledTools || []).filter((t) => !changed.includes(t)) })) || current;
      }
    }
    connections.set(entry.id, { conn, tools: r.tools, raw: r.raw, server: r.server, error: '' });
    return r;
  } catch (e) {
    conn.close();
    connections.set(entry.id, { conn: null, tools: [], raw: [], server: null, error: String(e.message || e).slice(0, 300) });
    throw e;
  }
}

function view() {
  return readServers().map((s) => {
    const c = connections.get(s.id);
    const tools = ((c && c.tools) || []).map((t) => ({ ...t, tier: toolTier(s, t.name), locked: toolLocked(s, t.name) }));
    return {
      id: s.id, name: s.name, transport: s.transport, kind: s.kind || 'manual', catalogId: s.catalogId || '', command: s.command || '', args: s.args || [], url: s.url || '',
      envNames: Object.keys(s.env || {}), enabledTools: s.enabledTools || [], readOnly: Boolean(s.readOnly), allowLan: Boolean(s.allowLan),
      changedTools: s.changedTools || [], secretNames: Object.keys(s.secretRefs || {}),
      running: Boolean(c && c.conn), error: (c && c.error) || '', tools, server: (c && c.server) || null,
    };
  });
}

// the tools the user turned on, of the servers that run: for the model's prompt (names ext__<server>__<tool>)
function enabledTools() {
  const out = [];
  for (const s of readServers()) {
    const c = connections.get(s.id);
    if (!c || !c.conn) continue;
    for (const t of c.tools) {
      if ((s.enabledTools || []).includes(t.name) && !toolLocked(s, t.name)) {
        out.push({ name: client.externalName(s.id, t.name), description: `${t.description} (tool of "${s.name}")`.slice(0, 700), parameters: t.parameters });
      }
    }
  }
  return out.slice(0, 30);
}

function lookup(name) {
  const p = client.parseExternalName(name);
  if (!p) return { error: 'unknown-tool' };
  const s = readServers().find((x) => x.id === p.serverId);
  const c = connections.get(p.serverId);
  if (!s || !c || !c.conn) return { error: 'not-running' };
  if (!c.tools.some((t) => t.name === p.tool)) return { error: 'tool-off' };
  return { p, s, c, tier: toolTier(s, p.tool) };
}

function register(ipcMain, { fromApp, offline = () => false, log: logFn = () => {}, auditFile = null }) {
  isOffline = offline;
  log = logFn;
  policy = createPolicy({ auditFile });
  const allowed = (fn) => async (event, ...args) => {
    if (!fromApp(event)) return { error: 'not-allowed' };
    try {
      return await fn(event, ...args);
    } catch (e) {
      return { error: 'failed', message: String(e.message || e).slice(0, 300) };
    }
  };
  ipcMain.handle('mcp:list', allowed(async () => ({ servers: view() })));
  ipcMain.handle('mcp:add', allowed(async (_e, input) => {
    const list = readServers();
    if (list.length >= MAX_SERVERS) return { error: 'too-many' };
    const entry = cleanServer(input, `s${Date.now().toString(36)}`);
    if (!entry) return { error: 'invalid' };
    writeServers([...list, entry]);
    log(`MCP server added: ${entry.name} (${entry.transport})`);
    try { await start(entry); } catch (e) { /* shown in the list */ }
    return { ok: true, servers: view() };
  }));
  ipcMain.handle('mcp:remove', allowed(async (_e, id) => {
    stop(String(id));
    writeServers(readServers().filter((s) => s.id !== String(id)));
    return { ok: true, servers: view() };
  }));
  ipcMain.handle('mcp:start', allowed(async (_e, id) => {
    const entry = readServers().find((s) => s.id === String(id));
    if (!entry) return { error: 'unknown' };
    await start(entry);
    return { ok: true, servers: view() };
  }));
  ipcMain.handle('mcp:stop', allowed(async (_e, id) => { stop(String(id)); return { ok: true, servers: view() }; }));
  ipcMain.handle('mcp:set-tool', allowed(async (_e, id, tool, on) => {
    const entry = readServers().find((s) => s.id === String(id));
    if (!entry) return { error: 'unknown' };
    const locked = toolLocked(entry, String(tool));
    if (on && locked) return { error: `tool-${locked}`, servers: view() };
    updateServer(entry.id, (s) => {
      const set = new Set(s.enabledTools || []);
      if (on) set.add(String(tool)); else set.delete(String(tool));
      return { ...s, enabledTools: [...set].slice(0, 100) };
    });
    return { ok: true, servers: view() };
  }));
  // the user looked at the changed tools: pin them again (they stay off until turned on)
  ipcMain.handle('mcp:accept-changes', allowed(async (_e, id) => {
    const c = connections.get(String(id));
    if (!c || !c.conn) return { error: 'not-running' };
    updateServer(String(id), (s) => ({ ...s, pins: core.pinTools(c.raw), changedTools: [] }));
    return { ok: true, servers: view() };
  }));
  ipcMain.handle('mcp:enabled-tools', allowed(async () => ({ tools: enabledTools() })));
  // what the tool card must ask: { tier, ask, canAllowSession, needsCheck, ... }
  ipcMain.handle('mcp:check', allowed(async (_e, name, chatId) => {
    const l = lookup(name);
    if (l.error) return l;
    return { ok: true, ...policy.check({ serverId: l.s.id, tool: l.p.tool, tier: l.tier, chatId }), server: l.s.name };
  }));
  ipcMain.handle('mcp:allow-session', allowed(async (_e, name) => {
    const l = lookup(name);
    if (l.error) return l;
    return policy.allowSession({ serverId: l.s.id, tool: l.p.tool, tier: l.tier }) ? { ok: true } : { error: 'not-read-tool' };
  }));
  // one call, after the user's yes in the tool card of the chat (or a read tool allowed for this session)
  ipcMain.handle('mcp:call', allowed(async (_e, name, args, approval) => {
    const l = lookup(name);
    if (l.error) return l;
    const { p, s, c, tier } = l;
    if (!(s.enabledTools || []).includes(p.tool) || toolLocked(s, p.tool)) return { error: 'tool-off' };
    if (isOffline()) return { error: 'offline' };
    const a = approval && typeof approval === 'object' ? approval : {};
    const auth = policy.authorize({ serverId: s.id, tool: p.tool, tier, chatId: a.chatId, approval: a });
    const base = { server: s.name, serverId: s.id, tool: p.tool, tier, args };
    if (!auth.ok) {
      policy.audit({ ...base, outcome: 'refused', error: auth.error });
      return { error: auth.error };
    }
    log(`MCP call: ${s.name} / ${p.tool} (${tier})`);
    const t0 = Date.now();
    try {
      const text = await client.callTool(c.conn, p.tool, args);
      policy.audit({ ...base, resultBytes: Buffer.byteLength(text, 'utf8'), ms: Date.now() - t0, auto: auth.auto });
      policy.noteResult({ chatId: a.chatId, untrusted: untrustedOutput(s, p.tool), server: s.name, tool: p.tool });
      return { ok: true, result: text, tier };
    } catch (e) {
      policy.audit({ ...base, outcome: 'error', error: e.message, ms: Date.now() - t0 });
      throw e;
    }
  }));
  // "Stop all connections": every server ends, allowances for this session are gone
  ipcMain.handle('mcp:stop-all', allowed(async () => { stopAll(); policy.stopAll(); log('MCP: all connections stopped by the user'); return { ok: true, servers: view() }; }));
  ipcMain.handle('mcp:audit', allowed(async (_e, limit) => ({ entries: policy.auditList(Math.min(Number(limit) || 200, 2000)) })));

  // the servers the user added start with StarkLLM (when it is online)
  setTimeout(() => {
    if (isOffline()) return;
    for (const s of readServers()) start(s).catch((e) => log(`MCP server ${s.name} did not start: ${e.message}`));
  }, 5000);
}

function configure({ secrets, launch }) {
  if (secrets) secretStore = secrets;
  if (launch) resolveLaunch = launch;
}

module.exports = {
  register, configure, stopAll, cleanServer, serverEnv, readServers, writeServers, updateServer, start, stop, view, toolTier, toolLocked,
  stopEverything: () => { stopAll(); policy.stopAll(); }, MAX_SERVERS,
};
