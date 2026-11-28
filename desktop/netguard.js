// The one place where the desktop app (Electron main process) may reach the network (roadmap phase 3, "provable
// privacy"). It is the counterpart of backend/app/core/netguard.py for the engine.
//
//  * Every outgoing connection of the main process (update check, update download, Ollama installer, engine download,
//    model download) is announced here with begin(feature, url, purpose): it is recorded in the user's profile
//    (network-log.jsonl: time, host, purpose, bytes, feature - never a path or a query) and refused while the
//    "fully offline" switch is on (privacy.json).
//  * attachSession() puts the same rule on every request of the app's window: with the switch on, nothing but this PC
//    can be reached; with it off, requests to other hosts are recorded.
//  * A test (test/netguard.test.js) reads the source files and fails when code opens a connection without this module.
//
// No Electron here: the session is passed in, so CI can test everything with fakes.
const fs = require('fs');
const path = require('path');

const FEATURES = {
  mcp: 'A tool server (MCP) on this PC that the user added: the tool calls the user allowed',
  connection_install: 'Download of a connection package the user chose to install (Settings › Connections: npm, PyPI, Python by uv)',
  update_check: 'Check for a newer StarkLLM version (GitHub)',
  update_download: 'Download of a StarkLLM update (GitHub)',
  ollama_install: 'Download of the Ollama installer the user asked for',
  engine_download: 'Download of the StarkLLM engine (Docker images, or the engine package without Docker)',
  engine_build: 'Build of the engine on this PC (Docker downloads packages)',
  model_download: 'Download of an AI model by the local Ollama',
  ui: 'A request of the app window to another host',
  phone_link: 'A paired phone on the home network (Settings > Phone; incoming)',
  phone_relay: 'Phones away from home: the connection to the StarkLLM relay (only encrypted bytes pass)',
  web_task: 'StarkLLM\'s browser window: a web task the user started in the chat (the sites of the task, and the local AI model)',
  unattributed: 'A connection that did not go through the network layer'
};

class OfflineError extends Error {
  constructor(host, feature) {
    super(`Fully offline mode is on: the connection to ${host || 'the internet'} was blocked.`);
    this.name = 'OfflineError';
    this.code = 'STARKLLM_OFFLINE';
    this.host = host;
    this.feature = feature;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch (e) {
    return String(url || '').toLowerCase();
  }
}

// "this_pc": loopback and the PC's own name for itself; "lan": another device on the local network; "internet": the rest.
function classify(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127\./.test(h)) return 'this_pc';
  if (/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || /^(fc|fd|fe80:)/.test(h) || /\.(local|lan|internal|home\.arpa)$/.test(h)) return 'lan';
  return 'internet';
}

const CSV_COLUMNS = ['time', 'source', 'feature', 'purpose', 'host', 'port', 'method', 'zone', 'outcome', 'bytes_out', 'bytes_in', 'status', 'error'];
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@]/.test(s)) s = "'" + s; // a spreadsheet program would read it as a formula
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * dir: the folder for privacy.json and network-log.jsonl (null: keep everything in memory, for tests).
 */
function createGuard({ dir = null, now = () => new Date(), maxBytes = 2 * 1024 * 1024, maxKeep = 3000 } = {}) {
  let offline = false;
  let asked = false; // the user has been asked once (first start) whether to go fully offline
  let memory = []; // used when there is no folder
  const localCounts = {};
  const announced = new Map(); // url -> open begin() calls (main-process requests already recorded)
  let nextId = 1;
  const statePath = dir && path.join(dir, 'privacy.json');
  const logPath = dir && path.join(dir, 'network-log.jsonl');

  if (statePath) {
    try {
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      offline = saved.offline === true;
      asked = saved.asked === true;
    } catch (e) {
      // first start: online, as before
    }
  }

  function readAll() {
    if (!logPath) return memory.slice();
    const out = [];
    try {
      for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch (e) {
          // a half-written line
        }
      }
    } catch (e) {
      // no log yet
    }
    return out;
  }

  function append(entry) {
    if (!logPath) {
      memory.push(entry);
      if (memory.length > maxKeep) memory = memory.slice(-maxKeep);
      return;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(logPath, JSON.stringify(entry) + '\n');
      if (fs.statSync(logPath).size > maxBytes) {
        const keep = readAll().slice(-maxKeep);
        fs.writeFileSync(logPath, keep.map((e) => JSON.stringify(e)).join('\n') + '\n');
      }
    } catch (e) {
      // the log must never stop the app
    }
  }

  function saveState() {
    if (!statePath) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ offline, asked }));
    } catch (e) {
      // kept in memory for this run
    }
  }

  const guard = {
    isOffline: () => offline,
    setOffline(value) {
      offline = Boolean(value);
      saveState();
      return offline;
    },
    hasAsked: () => asked,
    markAsked() {
      asked = true;
      saveState();
    },
    classify,
    localCounts: () => ({ ...localCounts }),

    // Throws OfflineError (and records the attempt) when the switch is on and the destination is not this PC.
    check(feature, url, purpose = '') {
      const host = hostOf(url);
      if (offline && classify(host) !== 'this_pc') {
        guard.record({ feature, host, purpose, outcome: 'blocked', error: 'offline mode', scheme: schemeOf(url) });
        throw new OfflineError(host, feature);
      }
      return host;
    },

    record(e) {
      const host = e.host || hostOf(e.url);
      if (classify(host) === 'this_pc') {
        localCounts[e.feature] = (localCounts[e.feature] || 0) + 1;
        return null;
      }
      const entry = {
        id: `d${Date.now().toString(36)}${nextId++}`,
        time: now().toISOString(),
        source: 'app',
        feature: e.feature || 'unattributed',
        purpose: e.purpose || FEATURES[e.feature] || '',
        host,
        port: e.port || null,
        scheme: e.scheme || '',
        method: e.method || '',
        zone: classify(host),
        outcome: e.outcome || 'ok',
        bytes_out: e.bytes_out === undefined ? 0 : e.bytes_out,
        bytes_in: e.bytes_in === undefined ? null : e.bytes_in,
        status: e.status === undefined ? null : e.status,
        error: String(e.error || '').slice(0, 200),
        via: e.via || ''
      };
      append(entry);
      return entry;
    },

    // Announces a connection: refuses it while offline, otherwise records it. finish() / fail() complete the entry.
    begin(feature, url, purpose = '', { method = 'GET', bytesOut = 0, via = '' } = {}) {
      const viaHost = via ? hostOf(via) : '';
      if (viaHost) {
        // a local service (Ollama) contacts the destination for us: that destination is what counts
        if (offline && classify(viaHost) !== 'this_pc') {
          guard.record({ feature, host: viaHost, purpose, outcome: 'blocked', error: 'offline mode' });
          throw new OfflineError(viaHost, feature);
        }
      } else {
        guard.check(feature, url, purpose);
      }
      const host = viaHost || hostOf(url);
      const u = safeUrl(url);
      // the session hook (attachSession) sees this request too: it must not record it a second time
      const key = String(url);
      if (!viaHost) announced.set(key, (announced.get(key) || 0) + 1);
      let released = false;
      const release = () => {
        if (released || viaHost) return;
        released = true;
        const n = (announced.get(key) || 1) - 1;
        if (n > 0) announced.set(key, n); else announced.delete(key);
      };
      const entry = guard.record({ feature, host, purpose, scheme: u.protocol.replace(':', ''), port: u.port ? Number(u.port) : null, method, bytes_out: bytesOut, bytes_in: null, via: via ? 'local Ollama' : '' });
      const done = (patch) => {
        release();
        if (entry) append({ ...entry, ...patch });
      };
      return {
        entry,
        finish: ({ status = null, bytesIn = null } = {}) => done({ status, bytes_in: bytesIn }),
        fail: (e) => done({ outcome: 'error', error: String((e && e.message) || e).slice(0, 200) })
      };
    },

    // A device of the home network connects to the app (the phone link, phonelink.js): refused while fully offline,
    // otherwise recorded like an outgoing connection, with the method "IN".
    inbound(feature, address, purpose = '') {
      const host = String(address || '').replace(/^::ffff:/i, '');
      if (offline) {
        guard.record({ feature, host, purpose, method: 'IN', outcome: 'blocked', error: 'offline mode' });
        throw new OfflineError(host, feature);
      }
      return guard.record({ feature, host, purpose, method: 'IN', scheme: 'https' });
    },

    // fetch(url, opts) -> the same, but announced first. For net.fetch / global fetch.
    wrapFetch(fetchFn, feature, purpose = '') {
      return async (url, opts = {}) => {
        const h = guard.begin(feature, url, purpose, { method: (opts && opts.method) || 'GET', bytesOut: opts && typeof opts.body === 'string' ? opts.body.length : 0 });
        try {
          const res = await fetchFn(url, opts);
          h.finish({ status: res.status, bytesIn: Number(res.headers && res.headers.get && res.headers.get('content-length')) || null });
          return res;
        } catch (e) {
          h.fail(e);
          throw e;
        }
      };
    },

    // Newest first; a line written again with the same id (a finished request) replaces the earlier one.
    list(limit = 500) {
      const byId = new Map();
      for (const e of readAll()) byId.set(e.id, e);
      return [...byId.values()].reverse().slice(0, limit);
    },
    clear() {
      memory = [];
      Object.keys(localCounts).forEach((k) => delete localCounts[k]);
      if (logPath) {
        try {
          fs.writeFileSync(logPath, '');
        } catch (e) {
          // nothing to clear
        }
      }
    },
    toCsv(rows = guard.list(5000)) {
      return [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
    },

    // The app window: with the switch on, only this PC can be reached; otherwise requests to other hosts are recorded.
    // feature: what the window is for ("ui" = the app's own window, "web_task" = StarkLLM's browser window).
    // blockLocal: web pages of that window must not reach this PC or the home network (the engine, Ollama, a router).
    attachSession(session, { feature = 'ui', blockLocal = false } = {}) {
      const open = new Map();
      const wb = session.webRequest;
      wb.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
        const host = hostOf(details.url);
        const zone = classify(host);
        if (blockLocal && zone !== 'internet') {
          guard.record({ feature, host, purpose: 'A web page asked for this PC or the home network', scheme: schemeOf(details.url), method: details.method, outcome: 'blocked', error: 'local address' });
          return callback({ cancel: true });
        }
        if (zone === 'this_pc') {
          localCounts[feature] = (localCounts[feature] || 0) + 1;
          return callback({});
        }
        if (!blockLocal && announced.has(details.url)) return callback({});   // already recorded by begin()
        if (offline) {
          guard.record({ feature, host, purpose: feature === 'ui' ? 'Blocked request of the app window' : 'Blocked request of the StarkLLM browser window', scheme: schemeOf(details.url), method: details.method, outcome: 'blocked', error: 'offline mode' });
          return callback({ cancel: true });
        }
        const entry = guard.record({ feature, host, scheme: schemeOf(details.url), method: details.method, bytes_in: null });
        if (entry) open.set(details.id, entry);
        callback({});
      });
      wb.onCompleted({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details) => {
        const entry = open.get(details.id);
        if (!entry) return;
        open.delete(details.id);
        const len = details.responseHeaders && (details.responseHeaders['Content-Length'] || details.responseHeaders['content-length']);
        append({ ...entry, status: details.statusCode, bytes_in: len ? Number([].concat(len)[0]) || null : null });
      });
      wb.onErrorOccurred({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details) => {
        const entry = open.get(details.id);
        if (!entry) return;
        open.delete(details.id);
        append({ ...entry, outcome: 'error', error: details.error || '' });
      });
    }
  };
  return guard;
}

function safeUrl(url) {
  try {
    return new URL(url);
  } catch (e) {
    return { protocol: '', port: '' };
  }
}
const schemeOf = (url) => safeUrl(url).protocol.replace(':', '');

// One guard for the whole main process. initShared(userDataDir) is called first thing when the app is ready; before that
// (and in tests of other modules) a guard without a folder is used: it records in memory and never blocks.
let shared = null;
function initShared(dir) {
  shared = createGuard({ dir });
  return shared;
}
function getShared() {
  if (!shared) shared = createGuard({ dir: null });
  return shared;
}

module.exports = { createGuard, initShared, getShared, classify, hostOf, OfflineError, FEATURES, CSV_COLUMNS };
