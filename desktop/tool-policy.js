// The rules for each call of a connection's tool (docs/connections.md, "Safety model"), on top of the yes in the chat:
//  * read tools may be allowed for this session (until StarkLLM closes or "Stop all connections");
//  * write tools ask every time; exec, send and delete tools ask every time, show the full arguments and can never be
//    allowed for the session;
//  * after a tool returned content from an untrusted source (notes, mail, files, web pages) into a chat, an exec, send or
//    delete tool in that chat needs a second, explicit tick: the content might carry hidden instructions;
//  * every call is written to an audit log (time, connection, tool, arguments, size of the result, outcome).
// No Electron here: desktop/test/connections.test.js tests it.
const fs = require('fs');
const path = require('path');

const MAX_ARGS_CHARS = 4000;

function createPolicy({ auditFile = null, now = () => new Date(), maxKeep = 5000, maxBytes = 4 * 1024 * 1024 } = {}) {
  const session = new Set(); // "<server>/<tool>" allowed for this session (read tools only)
  const tainted = new Map(); // chat id -> { server, tool, time }
  let memory = [];
  const key = (serverId, tool) => `${serverId}/${tool}`;
  const chatKey = (chatId) => String(chatId || 'default').slice(0, 80);

  function check({ serverId, tool, tier, chatId }) {
    const taint = tainted.get(chatKey(chatId)) || null;
    const allowed = tier === 'read' && session.has(key(serverId, tool));
    return {
      tier,
      blocked: tier === 'blocked',
      sessionAllowed: allowed,
      ask: !allowed,
      canAllowSession: tier === 'read',
      // exec / send / delete after untrusted content: the second tick
      needsCheck: tier === 'exec' && Boolean(taint),
      taintedBy: taint ? `${taint.server} / ${taint.tool}` : '',
    };
  }

  function allowSession({ serverId, tool, tier }) {
    if (tier !== 'read') return false; // never for write, exec, send or delete
    session.add(key(serverId, tool));
    return true;
  }

  // approval = what the tool card in the chat sends: { confirmed: the user pressed the button, checked: the second tick }
  function authorize({ serverId, tool, tier, chatId, approval = {} }) {
    if (tier === 'blocked') return { ok: false, error: 'tool-blocked' };
    const c = check({ serverId, tool, tier, chatId });
    if (tier === 'read' && c.sessionAllowed) return { ok: true, auto: !approval.confirmed };
    if (approval.confirmed !== true) return { ok: false, error: 'needs-approval' };
    if (c.needsCheck && approval.checked !== true) return { ok: false, error: 'needs-check' };
    return { ok: true, auto: false };
  }

  function noteResult({ chatId, untrusted, server, tool }) {
    if (untrusted) tainted.set(chatKey(chatId), { server: String(server || ''), tool: String(tool || ''), time: now().toISOString() });
  }

  function stopAll() {
    session.clear();
    tainted.clear();
  }

  function readAll() {
    if (!auditFile) return memory.slice();
    const out = [];
    try {
      for (const line of fs.readFileSync(auditFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch (e) { /* half-written line */ }
      }
    } catch (e) { /* no log yet */ }
    return out;
  }

  function audit({ server, serverId, tool, tier, args, resultBytes = 0, outcome = 'ok', error = '', ms = 0, auto = false }) {
    let argText = '';
    try { argText = JSON.stringify(args === undefined ? {} : args); } catch (e) { argText = '[not serialisable]'; }
    if (argText.length > MAX_ARGS_CHARS) argText = `${argText.slice(0, MAX_ARGS_CHARS)}… (${argText.length} characters)`;
    const entry = {
      time: now().toISOString(), server: String(server || ''), serverId: String(serverId || ''), tool: String(tool || ''), tier: String(tier || ''),
      args: argText, resultBytes: Number(resultBytes) || 0, outcome, error: String(error || '').slice(0, 300), ms: Math.round(ms), auto: Boolean(auto),
    };
    if (!auditFile) {
      memory.push(entry);
      if (memory.length > maxKeep) memory = memory.slice(-maxKeep);
      return entry;
    }
    try {
      fs.mkdirSync(path.dirname(auditFile), { recursive: true });
      fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n');
      if (fs.statSync(auditFile).size > maxBytes) {
        const keep = readAll().slice(-maxKeep);
        fs.writeFileSync(auditFile, keep.map((e) => JSON.stringify(e)).join('\n') + '\n');
      }
    } catch (e) { /* the log must never stop a call */ }
    return entry;
  }

  return {
    check, allowSession, authorize, noteResult, stopAll, audit,
    auditList: (limit = 200) => readAll().reverse().slice(0, limit),
    sessionAllowed: () => [...session],
  };
}

module.exports = { createPolicy };
