// MCP client (docs/roadmap-2026-12.md, R6): StarkLLM's model can use the tools of other MCP servers on this PC.
// Two kinds of servers: a program StarkLLM starts (stdio: JSON-RPC, one message per line) or a server that already
// runs on this PC (streamable HTTP at http://127.0.0.1:<port>/...). No Electron here: tested with a fake server.
//
// Rules the user can rely on (enforced here and in mcp.js):
//  * only servers the user added, only on this PC (no address outside 127.0.0.1 / localhost / ::1);
//  * every tool of a server is off until the user turns it on; every call shows its arguments and waits for a yes
//    in the chat (the tool card); the result goes back to the chat only when the user sends it;
//  * tool names and descriptions come from the server: they are cut short and cleaned before the model sees them;
//  * a started program gets the user's environment without secrets (tokens, keys, passwords), plus the variables the
//    user set for that server; it ends with StarkLLM and with the offline switch.

const { spawn } = require('child_process');

const PROTOCOL = '2025-06-18';
const CALL_SECONDS = 60;

function cleanText(s, max) {
  // no control characters, no markup that imitates the prompt's own blocks
  return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/```/g, "'''").replace(/═+/g, '').slice(0, max);
}

// a tool of a server -> { name, description, parameters } in a safe size
function cleanTool(tool) {
  const name = String((tool && tool.name) || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64);
  if (!name) return null;
  let parameters = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} };
  if (JSON.stringify(parameters).length > 4000) parameters = { type: 'object', properties: {} };
  return { name, description: cleanText(tool.description, 600), parameters };
}

// the text of a tools/call result for the chat (text parts; other parts are named)
function resultText(result) {
  if (!result) return '';
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts.map((p) => {
    if (p && p.type === 'text') return String(p.text || '');
    if (p && p.type) return `[${p.type}]`;
    return '';
  }).filter(Boolean).join('\n');
  const body = text || (result.structuredContent ? JSON.stringify(result.structuredContent, null, 2) : '');
  return cleanText(body, 20000) + (result.isError ? '\n(the tool reported an error)' : '');
}

function localUrl(u) {
  try {
    const url = new URL(String(u || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname) ? url.href : null;
  } catch (e) {
    return null;
  }
}

// ── stdio: a program StarkLLM starts ──
class StdioConnection {
  constructor({ command, args = [], cwd, env, spawnFn = spawn }) {
    const viaShell = process.platform === 'win32' && !/\.(exe|com)$/i.test(command);
    // Windows: "npx", "uvx" and other launchers are .cmd files, which only the command shell runs; arguments are quoted
    const quote = (a) => (/[\s"&|<>^()]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a);
    this.child = viaShell
      ? spawnFn([command, ...args].map(quote).join(' '), [], { cwd: cwd || undefined, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: true })
      : spawnFn(command, args, { cwd: cwd || undefined, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdin.on('error', () => {}); // the server ended: the pending calls fail with its exit message
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.stderr = '';
    this.closed = false;
    this.child.stdout.on('data', (b) => this.onData(b));
    this.child.stderr.on('data', (b) => { this.stderr = (this.stderr + b.toString('utf8')).slice(-4000); });
    const fail = (why) => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error(why));
      this.pending.clear();
    };
    this.child.on('error', (e) => fail(`the program could not start: ${e.message}`));
    this.child.on('exit', (code) => fail(`the program ended (exit code ${code})${this.stderr ? ': ' + this.stderr.trim().slice(-300) : ''}`));
  }

  onData(b) {
    this.buffer += b.toString('utf8');
    if (this.buffer.length > 8 * 1024 * 1024) this.buffer = this.buffer.slice(-1024 * 1024);
    let k;
    while ((k = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, k).trim();
      this.buffer = this.buffer.slice(k + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; } // a program that prints other text on stdout
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(cleanText(msg.error.message || 'error', 300)));
        else resolve(msg.result);
      } else if (msg.id != null && msg.method) {
        // a request of the server (sampling, roots ...): not offered by StarkLLM
        this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported by StarkLLM' } });
      }
    }
  }

  send(obj) {
    if (!this.closed) this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, seconds = CALL_SECONDS) {
    if (this.closed) return Promise.reject(new Error('the server is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`no answer within ${seconds} s`)); }, seconds * 1000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params });
  }

  close() {
    this.closed = true;
    if (process.platform === 'win32' && this.child.pid) {
      // the server with every program it started (a .cmd launcher starts node, which starts the server)
      require('child_process').execFile('taskkill', ['/pid', String(this.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      try { this.child.kill(); } catch (e) { /* gone */ }
    }
  }
}

// ── streamable HTTP: a server that runs on this PC ──
class HttpConnection {
  constructor({ url, fetchFn = fetch }) {
    this.url = localUrl(url);
    if (!this.url) throw new Error('only servers on this PC (127.0.0.1 or localhost)');
    this.fetch = fetchFn;
    this.session = '';
    this.nextId = 1;
  }

  async post(body, seconds = CALL_SECONDS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), seconds * 1000);
    try {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL };
      if (this.session) headers['Mcp-Session-Id'] = this.session;
      const res = await this.fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal, redirect: 'error' });
      const sid = res.headers.get('mcp-session-id');
      if (sid) this.session = sid;
      if (res.status === 202) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const type = res.headers.get('content-type') || '';
      if (type.includes('text/event-stream')) {
        // the answer is one of the "data:" events
        for (const block of text.split(/\r?\n\r?\n/)) {
          const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (!data) continue;
          try {
            const msg = JSON.parse(data);
            if (msg.id === body.id) return msg;
          } catch (e) { /* not JSON */ }
        }
        return null;
      }
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }

  async request(method, params, seconds) {
    const id = this.nextId++;
    const msg = await this.post({ jsonrpc: '2.0', id, method, params }, seconds);
    if (!msg) throw new Error('no answer');
    if (msg.error) throw new Error(cleanText(msg.error.message || 'error', 300));
    return msg.result;
  }

  notify(method, params) {
    this.post({ jsonrpc: '2.0', method, params }).catch(() => {});
  }

  close() { /* nothing runs here */ }
}

// Connect: the handshake, then the list of tools
async function connect(conn) {
  const init = await conn.request('initialize', {
    protocolVersion: PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'StarkLLM', version: '1' },
  }, 30);
  conn.notify('notifications/initialized', {});
  const tools = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const r = await conn.request('tools/list', cursor ? { cursor } : {}, 30);
    for (const t of (r && r.tools) || []) {
      const c = cleanTool(t);
      if (c && tools.length < 100) tools.push(c);
    }
    cursor = r && r.nextCursor;
    if (!cursor) break;
  }
  const info = (init && init.serverInfo) || {};
  return { server: { name: cleanText(info.name, 80), version: cleanText(info.version, 40) }, tools };
}

async function callTool(conn, name, args) {
  const r = await conn.request('tools/call', { name, arguments: args && typeof args === 'object' ? args : {} }, CALL_SECONDS);
  return resultText(r);
}

// The name the model uses for a tool of a server: ext__<server id>__<tool>
const externalName = (serverId, tool) => `ext__${serverId}__${tool}`;
function parseExternalName(name) {
  const m = String(name || '').match(/^ext__([a-z0-9-]{1,40})__([A-Za-z0-9_.-]{1,64})$/);
  return m ? { serverId: m[1], tool: m[2] } : null;
}

module.exports = { StdioConnection, HttpConnection, connect, callTool, cleanTool, resultText, localUrl, externalName, parseExternalName, PROTOCOL };
