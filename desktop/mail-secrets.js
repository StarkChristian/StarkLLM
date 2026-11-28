// Passwords of the e-mail accounts of "Letters from e-mail" (docs/mail-import.md). They are kept only here, each one
// wrapped by the Windows key store (Electron safeStorage, DPAPI: only this Windows user on this PC can open it), in
// mail-secrets.json in the app's profile folder. The engine gets them in memory after it started and never writes
// them down; the page that typed one in never gets it back.
//
// The key store is the same interface as in data-key.js: { name, isAvailable(), wrap(Buffer), unwrap(Buffer) }.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAIL_CONTEXT = 'starkllm-mail-secrets';
const MAX_PASSWORD = 1024;

class MailSecretError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function accountKey(id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) throw new MailSecretError('bad-account', 'Unknown e-mail account.');
  return String(n);
}

class MailSecrets {
  constructor({ dir, keyStore }) {
    this.dir = dir;
    this.file = path.join(dir, 'mail-secrets.json');
    this.keyStore = keyStore;
  }

  available() {
    return Boolean(this.keyStore && this.keyStore.isAvailable());
  }

  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return data && typeof data.accounts === 'object' && data.accounts ? data.accounts : {};
    } catch (e) {
      return {};
    }
  }

  write(accounts) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, store: this.keyStore.name, accounts }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  set(id, password) {
    const key = accountKey(id);
    const text = String(password == null ? '' : password);
    if (!text || text.length > MAX_PASSWORD) throw new MailSecretError('bad-password', 'Enter the password of the e-mail account.');
    if (!this.available()) throw new MailSecretError('no-key-store', 'This PC has no safe place for the password (the Windows key store is not available).');
    const accounts = this.read();
    accounts[key] = this.keyStore.wrap(Buffer.from(text, 'utf8')).toString('base64');
    this.write(accounts);
  }

  remove(id) {
    const accounts = this.read();
    const key = accountKey(id);
    if (!(key in accounts)) return false;
    delete accounts[key];
    this.write(accounts);
    return true;
  }

  ids() {
    return Object.keys(this.read()).map(Number);
  }

  // { "<id>": "<password>" } of the given accounts (all when ids is missing); one that cannot be opened is left out
  passwords(ids) {
    const accounts = this.read();
    const wanted = ids ? new Set(ids.map((i) => String(i))) : null;
    const out = {};
    for (const [key, wrapped] of Object.entries(accounts)) {
      if (wanted && !wanted.has(key)) continue;
      try {
        out[key] = this.keyStore.unwrap(Buffer.from(wrapped, 'base64')).toString('utf8');
      } catch (e) {
        // another Windows account or PC: the user types the password again
      }
    }
    return out;
  }
}

// The engine accepts passwords only with this token, derived from the secret only the app and the engine know.
function mailToken(secret) {
  return crypto.createHmac('sha256', secret).update(MAIL_CONTEXT).digest('hex');
}

// Hands passwords to the engine's memory. Returns { ok, known, unknown } (unknown: accounts the engine does not have).
async function deliverPasswords({ apiUrl, secret, passwords, fetchImpl }) {
  if (!Object.keys(passwords).length) return { ok: true, known: [], unknown: [] };
  const res = await fetchImpl(`${apiUrl}/api/v1/mail/internal/passwords`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-StarkLLM-Internal': mailToken(secret) },
    body: JSON.stringify({ passwords }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) return { ok: false, status: res.status, known: [], unknown: [] };
  const body = await res.json();
  return { ok: true, known: body.known || [], unknown: body.unknown || [] };
}

// The engine forgets the passwords (ids: those accounts; null: all, when the app quits).
async function forgetPasswords({ apiUrl, secret, ids = null, fetchImpl, timeoutMs = 3000 }) {
  try {
    const res = await fetchImpl(`${apiUrl}/api/v1/mail/internal/forget`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-StarkLLM-Internal': mailToken(secret) },
      body: JSON.stringify({ ids }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    return { ok: res.ok };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { MailSecrets, MailSecretError, mailToken, deliverPasswords, forgetPasswords, MAIL_CONTEXT };
