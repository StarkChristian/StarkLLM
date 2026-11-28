// Secrets of connections (API keys, tokens, passwords) live in Windows Credential Manager, never in a settings file
// (docs/connections.md). Windows: the PasswordVault of Windows (Credential Manager › Web credentials), reached through
// Windows PowerShell; the secret travels on the program's input, never on its command line. Other systems (a run from
// source on Linux): sealed with Electron's safeStorage into a file, or refused when that is not available.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const RESOURCE = 'StarkLLM Connections';

// one request per run: {"op":"set|get|remove","user":"...","secret":"<base64>"} on standard input
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[void][Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime]
$req = [Console]::In.ReadToEnd() | ConvertFrom-Json
$vault = New-Object Windows.Security.Credentials.PasswordVault
$resource = '${RESOURCE}'
function Find-Cred { try { return $vault.Retrieve($resource, $req.user) } catch { return $null } }
switch ($req.op) {
  'set' {
    $old = Find-Cred; if ($old) { $vault.Remove($old) }
    $plain = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($req.secret))
    $vault.Add((New-Object Windows.Security.Credentials.PasswordCredential($resource, $req.user, $plain)))
    [Console]::Out.Write('ok')
  }
  'get' {
    $c = Find-Cred
    if ($c) { $c.RetrievePassword(); [Console]::Out.Write('ok:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($c.Password))) } else { [Console]::Out.Write('none') }
  }
  'remove' { $c = Find-Cred; if ($c) { $vault.Remove($c) }; [Console]::Out.Write('ok') }
}
`;

// runs the script with the request on standard input -> { code, stdout, stderr }
function runPowerShell(script, input, { spawnFn = spawn, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawnFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const cleanKey = (key) => {
  const k = String(key || '');
  // "<connection id>/<field>"
  if (!/^[A-Za-z0-9_-]{1,60}\/[A-Za-z0-9_-]{1,60}$/.test(k)) throw new Error('bad secret name');
  return k;
};

function windowsStore({ run = runPowerShell } = {}) {
  const call = async (req) => {
    const r = await run(SCRIPT, JSON.stringify(req));
    if (r.code !== 0) throw new Error(`Windows Credential Manager: ${String(r.stderr || '').trim().slice(0, 200) || `exit code ${r.code}`}`);
    return String(r.stdout || '').trim();
  };
  return {
    kind: 'windows-credential-manager',
    async set(key, value) {
      const out = await call({ op: 'set', user: cleanKey(key), secret: Buffer.from(String(value), 'utf8').toString('base64') });
      if (out !== 'ok') throw new Error('Windows Credential Manager did not store the secret');
    },
    async get(key) {
      const out = await call({ op: 'get', user: cleanKey(key) });
      if (out.startsWith('ok:')) return Buffer.from(out.slice(3), 'base64').toString('utf8');
      return null;
    },
    async remove(key) { await call({ op: 'remove', user: cleanKey(key) }); },
  };
}

// sealed file (safeStorage of Electron) for runs on other systems; seal/unseal are passed in
function sealedFileStore({ file, seal, unseal }) {
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
  };
  const write = (data) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  };
  return {
    kind: 'sealed-file',
    async set(key, value) { const d = read(); d[cleanKey(key)] = seal(String(value)); write(d); },
    async get(key) { const d = read(); const v = d[cleanKey(key)]; return v ? unseal(v) : null; },
    async remove(key) { const d = read(); delete d[cleanKey(key)]; write(d); },
  };
}

function createSecretStore({ platform = process.platform, run, file, seal, unseal } = {}) {
  if (platform === 'win32') return windowsStore({ run });
  if (file && seal && unseal) return sealedFileStore({ file, seal, unseal });
  const refuse = async () => { throw new Error('no protected place for secrets on this system'); };
  return { kind: 'none', set: refuse, get: refuse, remove: async () => {} };
}

module.exports = { createSecretStore, runPowerShell, SCRIPT, RESOURCE };
