// Settings › Connections (docs/connections.md): only in the desktop app, which installs and starts the connections.
export const connectionsBridge = () => (typeof window !== 'undefined' && window.starkllmDesktop && window.starkllmDesktop.connections) || null;
export const hasConnections = () => Boolean(connectionsBridge());

// the first values of a generated form: the field's default, else empty (a checkbox: off)
export function initialValues(fields) {
  const v = {};
  for (const f of fields || []) {
    if (f.kind === 'checkbox') v[f.id] = f.default === true;
    else if (f.kind === 'secret') v[f.id] = '';
    else v[f.id] = f.default === undefined || f.default === null ? '' : String(f.default);
  }
  return v;
}

// the required fields that are still empty (the desktop app checks again)
export function missingRequired(fields, values) {
  return (fields || []).filter((f) => f.required && f.kind !== 'checkbox' && !String((values || {})[f.id] ?? '').trim()).map((f) => f.id);
}

// 12345 -> "12 KB"
export function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

// the order of the tool list: what reads first, what runs or deletes last, what is always off at the end
const RANK = { read: 0, write: 1, exec: 2, blocked: 3 };
export const sortTools = (tools) => [...(tools || [])].sort((a, b) => (RANK[a.tier] ?? 2) - (RANK[b.tier] ?? 2) || String(a.name).localeCompare(String(b.name)));

// the servers of one page: Settings › Connections shows catalog and bundle entries, Local Tools the ones added by hand
export const serversOfKinds = (servers, kinds) => (servers || []).filter((s) => kinds.includes(s.kind || 'manual'));
