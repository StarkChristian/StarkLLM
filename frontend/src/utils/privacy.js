// The "fully offline" switch lives in two places: the engine (backend/app/core/netguard.py) and, in the desktop app,
// the app itself (desktop/netguard.js). One rule keeps them equal: "offline" wins. Whichever side is offline, the other
// is switched offline too; turning it off turns both off.

const OFFLINE_EVENT = 'starkllm:offline';

const desktop = () => (typeof window !== 'undefined' ? window.starkllmDesktop : undefined);
const auth = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function engineStatus(token) {
  const res = await fetch('/api/v1/privacy/status', { headers: auth(token) });
  return res.ok ? res.json() : null;
}

async function engineSet(token, enabled) {
  const res = await fetch('/api/v1/privacy/offline', { method: 'PUT', headers: auth(token), body: JSON.stringify({ enabled }) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

function announce(offline) {
  window.dispatchEvent(new CustomEvent(OFFLINE_EVENT, { detail: offline }));
}

// Reads both sides and makes them equal; returns { offline, desktop (bool or null), engine (bool or null) }.
export async function readOffline(token) {
  let engine = null;
  let app = null;
  try { const s = await engineStatus(token); engine = s ? Boolean(s.offline) : null; } catch (_) { /* engine not reachable */ }
  try { const d = desktop(); if (d && d.getPrivacy) { const p = await d.getPrivacy(); app = p && !p.error ? Boolean(p.offline) : null; } } catch (_) { /* browser */ }
  if (engine === true && app === false) { try { await desktop().setOffline(true); app = true; } catch (_) { /* keep */ } }
  if (app === true && engine === false) { try { await engineSet(token, true); engine = true; } catch (_) { /* keep */ } }
  return { offline: engine === true || app === true, desktop: app, engine };
}

export async function setOffline(token, enabled) {
  // the engine first: it is the one that can say no (only the administrator turns the switch off)
  await engineSet(token, enabled);
  const d = desktop();
  if (d && d.setOffline) await d.setOffline(enabled);
  announce(enabled);
  return enabled;
}

export function onOfflineChange(cb) {
  const handler = (e) => cb(Boolean(e.detail));
  window.addEventListener(OFFLINE_EVENT, handler);
  return () => window.removeEventListener(OFFLINE_EVENT, handler);
}

export async function readNetworkLog(token, limit = 500) {
  let engine = [];
  let status = null;
  let features = {};
  try {
    const res = await fetch(`/api/v1/privacy/network-log?limit=${limit}`, { headers: auth(token) });
    if (res.ok) { const b = await res.json(); engine = b.entries || []; status = b.status; features = b.features || {}; }
  } catch (_) { /* engine not reachable */ }
  let app = [];
  let appCounts = {};
  const d = desktop();
  if (d && d.getNetworkLog) {
    try { const l = await d.getNetworkLog(limit); if (Array.isArray(l)) app = l; } catch (_) { /* old desktop app */ }
    try { const p = await d.getPrivacy(); appCounts = (p && p.localCounts) || {}; } catch (_) { /* old desktop app */ }
  }
  const entries = [...engine, ...app].sort((a, b) => String(b.time).localeCompare(String(a.time)));
  const local = Object.values({ ...(status ? status.local_requests : {}) }).reduce((a, b) => a + b, 0)
    + Object.values(appCounts).reduce((a, b) => a + b, 0);
  return { entries, status, features, localRequests: local };
}

export async function clearNetworkLog(token) {
  await fetch('/api/v1/privacy/network-log', { method: 'DELETE', headers: auth(token) });
  const d = desktop();
  if (d && d.clearNetworkLog) await d.clearNetworkLog();
}

const COLUMNS = ['time', 'source', 'feature', 'purpose', 'host', 'port', 'method', 'zone', 'outcome', 'bytes_out', 'bytes_in', 'status', 'error'];

export function toCsv(entries) {
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // a spreadsheet program would read it as a formula
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${[COLUMNS.join(','), ...entries.map((e) => COLUMNS.map((c) => cell(e[c])).join(','))].join('\n')}\n`;
}

export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
