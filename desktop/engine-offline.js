// The "fully offline" switch lives in the desktop app (netguard.js) and in the engine on this PC
// (backend/app/core/netguard.py). The switch of the app sets both: the person at the desktop app owns this PC (like the
// first-start question), so the engine accepts it with the key derived from its SECRET_KEY, the same key as the
// desktop session (backend/app/api/auth.py, desktop_key; backend/app/api/privacy.py, /privacy/offline/desktop).
//
// One rule keeps the two equal: "offline" wins.
//   on:  the app goes offline at once (cutting connections is always safe), then the engine is told.
//   off: the engine is asked first. When it refuses, it stays offline and so does the app. When it cannot be
//        reached (not started yet, or not installed: the first start needs the internet to get it), the app goes
//        online anyway, so nobody is locked out of the download; the page reconciles the two when the engine runs.
// Whatever happens to the engine is in the returned state (engine, engineError), never silently dropped.
const crypto = require('crypto');

const OFFLINE_PATH = '/api/v1/privacy/offline/desktop';

function desktopKey(secret) {
  return crypto.createHmac('sha256', secret).update('starkllm-desktop-session').digest('hex');
}

// -> { ok: true, offline } | { ok: false, reason: 'unreachable' | 'refused', status, error }
async function setEngineOffline({ fetchFn, apiUrl, key, on, timeoutMs = 5000 }) {
  let res;
  try {
    res = await fetchFn(`${apiUrl}${OFFLINE_PATH}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Desktop-Key': key },
      body: JSON.stringify({ enabled: Boolean(on) }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (e) {
    return { ok: false, reason: 'unreachable', status: null, error: String((e && e.message) || e) };
  }
  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    // no JSON: the status says enough
  }
  if (!res.ok) return { ok: false, reason: 'refused', status: res.status, error: (body && body.detail) || `HTTP ${res.status}` };
  return { ok: true, offline: Boolean(body && body.offline) };
}

// guard: the app's network guard; setEngine(on) -> what setEngineOffline returns.
// -> { offline (the app), engine (true/false, null when unknown), engineError (null, 'unreachable', 'refused'), engineDetail }
async function switchOffline({ guard, on, setEngine }) {
  const wanted = Boolean(on);
  let r;
  if (wanted) {
    guard.setOffline(true);
    r = await safely(setEngine, true);
  } else {
    r = await safely(setEngine, false);
    if (r.ok || r.reason === 'unreachable') guard.setOffline(false);
  }
  return {
    offline: guard.isOffline(),
    engine: r.ok ? r.offline : null,
    engineError: r.ok ? null : r.reason,
    engineDetail: r.ok ? null : r.error || null
  };
}

async function safely(setEngine, on) {
  try {
    return await setEngine(on);
  } catch (e) {
    return { ok: false, reason: 'unreachable', status: null, error: String((e && e.message) || e) };
  }
}

module.exports = { desktopKey, setEngineOffline, switchOffline, OFFLINE_PATH };
