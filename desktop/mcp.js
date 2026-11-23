// MCP servers of the user (docs/roadmap-2026-12.md, R6): the list in the profile folder (mcp-servers.json), the
// running connections, and the IPC for Settings and the tool card in the chat. The protocol is in mcp-client.js.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const client = require('./mcp-client');
const { getShared } = require('./netguard');

const MAX_SERVERS = 12;
const connections = new Map(); // server id -> { conn, tools, server, error }
let isOffline = () => false;

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
  const entry = { id, name, transport, enabledTools: [] };
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
  return entry;
}

function stop(id) {
  const c = connections.get(id);
  if (c && c.conn) c.conn.close();
  connections.delete(id);
}

function stopAll() {
  for (const id of [...connections.keys()]) stop(id);
}

async function start(entry) {
  stop(entry.id);
  if (isOffline()) throw new Error('StarkLLM is fully offline: tool servers are off.');
  const conn = entry.transport === 'http'
    ? new client.HttpConnection({ url: entry.url, fetchFn: getShared().wrapFetch(fetch, 'mcp', 'A tool server (MCP) on this PC') })
    : new client.StdioConnection({ command: entry.command, args: entry.args, env: serverEnv(entry.env) });
  try {
    const r = await client.connect(conn);
    connections.set(entry.id, { conn, tools: r.tools, server: r.server, error: '' });
    return r;
  } catch (e) {
    conn.close();
    connections.set(entry.id, { conn: null, tools: [], server: null, error: String(e.message || e).slice(0, 300) });
    throw e;
  }
}

function view() {
  return readServers().map((s) => {
    const c = connections.get(s.id);
    return {
      id: s.id, name: s.name, transport: s.transport, command: s.command || '', args: s.args || [], url: s.url || '',
      envNames: Object.keys(s.env || {}), enabledTools: s.enabledTools || [],
      running: Boolean(c && c.conn), error: (c && c.error) || '', tools: (c && c.tools) || [], server: (c && c.server) || null,
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
      if ((s.enabledTools || []).includes(t.name)) {
        out.push({ name: client.externalName(s.id, t.name), description: `${t.description} (tool of "${s.name}")`.slice(0, 700), parameters: t.parameters });
      }
    }
  }
  return out.slice(0, 30);
}

function register(ipcMain, { fromApp, offline = () => false, log = () => {} }) {
  isOffline = offline;
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
    const list = readServers().map((s) => {
      if (s.id !== String(id)) return s;
      const set = new Set(s.enabledTools || []);
      if (on) set.add(String(tool)); else set.delete(String(tool));
      return { ...s, enabledTools: [...set].slice(0, 100) };
    });
    writeServers(list);
    return { ok: true, servers: view() };
  }));
  ipcMain.handle('mcp:enabled-tools', allowed(async () => ({ tools: enabledTools() })));
  // one call, after the user's yes in the tool card of the chat
  ipcMain.handle('mcp:call', allowed(async (_e, name, args) => {
    const p = client.parseExternalName(name);
    if (!p) return { error: 'unknown-tool' };
    const s = readServers().find((x) => x.id === p.serverId);
    const c = connections.get(p.serverId);
    if (!s || !c || !c.conn) return { error: 'not-running' };
    if (!(s.enabledTools || []).includes(p.tool) || !c.tools.some((t) => t.name === p.tool)) return { error: 'tool-off' };
    if (isOffline()) return { error: 'offline' };
    log(`MCP call: ${s.name} / ${p.tool}`);
    const text = await client.callTool(c.conn, p.tool, args);
    return { ok: true, result: text };
  }));

  // the servers the user added start with StarkLLM (when it is online)
  setTimeout(() => {
    if (isOffline()) return;
    for (const s of readServers()) start(s).catch((e) => log(`MCP server ${s.name} did not start: ${e.message}`));
  }, 5000);
}

module.exports = { register, stopAll, cleanServer, serverEnv };
