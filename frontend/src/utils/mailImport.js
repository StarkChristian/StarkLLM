// Settings > Letters from e-mail (docs/mail-import.md): the parts of the page that need no browser, so they can be tested.

export const SECURITY_PORTS = { ssl: 993, starttls: 143 };
export const MIN_INTERVAL = 5;
export const MAX_INTERVAL = 1440;

// "a\n b, c" -> ["a", "b", "c"]: one entry per line (commas too), empty ones dropped, no repeats
export function parseList(text) {
  const out = [];
  for (const part of String(text || '').split(/[\n,;]/)) {
    const v = part.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

export function formatList(list) {
  return (list || []).join('\n');
}

export function emptyForm(workspaceId) {
  return {
    host: '', port: SECURITY_PORTS.ssl, security: 'ssl', username: '', password: '', folders: 'INBOX',
    workspace_id: workspaceId || '', senders: '', subjects: '', interval_minutes: 15, mark_read: false, enabled: true,
  };
}

export function formFromAccount(acc) {
  return {
    host: acc.host, port: acc.port, security: acc.security, username: acc.username, password: '',
    folders: formatList(acc.folders), workspace_id: acc.workspace_id, senders: formatList(acc.senders),
    subjects: formatList(acc.subjects), interval_minutes: acc.interval_minutes, mark_read: acc.mark_read,
    enabled: acc.enabled,
  };
}

// The request body for the engine: never with the password (that goes to the Windows key store of the desktop app).
export function accountBody(form) {
  return {
    host: String(form.host || '').trim(), port: Number(form.port), security: form.security,
    username: String(form.username || '').trim(), folders: parseList(form.folders).length ? parseList(form.folders) : ['INBOX'],
    workspace_id: Number(form.workspace_id), senders: parseList(form.senders), subjects: parseList(form.subjects),
    interval_minutes: Number(form.interval_minutes), mark_read: Boolean(form.mark_read), enabled: form.enabled !== false,
  };
}

// The first thing that is wrong with the form, as a code the page translates; null when it can be saved.
export function formProblem(form, { needPassword }) {
  const host = String(form.host || '').trim();
  if (!host || !String(form.username || '').trim() || !form.workspace_id || (needPassword && !form.password)) return 'incomplete';
  if (/[\s/]|:\/\//.test(host)) return 'bad_host';
  if (!(form.security in SECURITY_PORTS)) return 'tls_required';
  const port = Number(form.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'bad_port';
  const every = Number(form.interval_minutes);
  if (!Number.isInteger(every) || every < MIN_INTERVAL || every > MAX_INTERVAL) return 'bad_interval';
  return null;
}

// Switching the encryption moves a standard port along; a port the user typed stays.
export function portFor(security, currentPort) {
  const standard = Object.values(SECURITY_PORTS);
  return standard.includes(Number(currentPort)) ? SECURITY_PORTS[security] : currentPort;
}
