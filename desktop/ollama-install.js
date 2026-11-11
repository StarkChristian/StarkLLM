// Installs Ollama on Windows when the user asks for it on the "what is missing" page ("Install Ollama for me").
// Downloads the official installer from ollama.com, runs it only if Windows confirms a valid signature by Ollama,
// and installs it for the current user without a wizard. No Electron here, so CI can run it on a Windows machine.
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');

const INSTALLER_URL = 'https://ollama.com/download/OllamaSetup.exe';

// Follows redirects (ollama.com -> GitHub releases); onProgress(downloaded, total)
function download(url, target, onProgress = () => {}, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'StarkLLM-Desktop' }, timeout: 60000 }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).toString(), target, onProgress, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`download failed: HTTP ${res.statusCode}`));
        return;
      }
      const total = Number(res.headers['content-length']) || 0;
      let done = 0;
      const out = fs.createWriteStream(target);
      res.on('data', (c) => {
        done += c.length;
        onProgress(done, total);
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve({ bytes: done, total })));
      out.on('error', reject);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('no answer from the download server')));
    req.on('error', reject);
  });
}

// Windows' own check of the file's digital signature (Authenticode). The path goes in through an environment variable,
// so the script is fixed text: no quoting can change it, and no encoded command is needed (security software treats
// "powershell -EncodedCommand" as a sign of malware).
const SIGNATURE_SCRIPT = "$s = Get-AuthenticodeSignature -LiteralPath $env:STARKLLM_SIGNED_FILE; [string]$s.Status + '|' + $s.SignerCertificate.Subject";

function signature(file, runPs = powershell) {
  return runPs(SIGNATURE_SCRIPT, { STARKLLM_SIGNED_FILE: file }).then((out) => {
    const [status, subject = ''] = out.trim().split('|');
    return { status, subject };
  });
}

function powershell(script, extraEnv = {}, run = execFile) {
  if (script.includes('"')) return Promise.reject(new Error('PowerShell scripts here must not contain double quotes'));
  return new Promise((resolve, reject) => {
    // Without PSModulePath: one inherited from PowerShell 7 stops Windows PowerShell from loading its own modules.
    const env = { ...process.env, ...extraEnv };
    for (const k of Object.keys(env)) if (k.toLowerCase() === 'psmodulepath') delete env[k];
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 120000, env }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message} ${String(stderr).trim()}`.trim()));
      else if (!String(stdout).trim() && String(stderr).trim()) reject(new Error(String(stderr).trim().slice(0, 500)));
      else resolve(String(stdout));
    });
  });
}

function trusted(sig) {
  return sig.status === 'Valid' && /\bO=Ollama\b|CN=Ollama\b/i.test(sig.subject);
}

function runInstaller(file) {
  return new Promise((resolve, reject) => {
    // Inno Setup: no wizard, no message boxes, no restart; per-user install (no administrator rights)
    execFile(file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'], { windowsHide: true, timeout: 15 * 60 * 1000 }, (err) => {
      if (err) reject(new Error(`the Ollama installer stopped: ${err.message}`));
      else resolve();
    });
  });
}

/**
 * onStatus(text, fraction): progress for the start screen. Resolves when Ollama is installed; rejects with a message
 * for the user otherwise. deps are for tests.
 */
async function installOllama({ onStatus = () => {}, log = () => {}, deps = {} } = {}) {
  const d = { download, signature, runInstaller, tmpdir: os.tmpdir, ...deps };
  const target = path.join(d.tmpdir(), `OllamaSetup-${Date.now()}.exe`);
  onStatus('Downloading Ollama from ollama.com...', null);
  const { bytes } = await d.download(INSTALLER_URL, target, (done, total) => {
    if (total) onStatus(`Downloading Ollama: ${Math.floor((done / total) * 100)} % (${Math.round(done / 1e6)} MB of ${Math.round(total / 1e6)} MB)`, done / total);
  });
  log(`Ollama installer downloaded (${Math.round(bytes / 1e6)} MB)`);
  onStatus('Checking the Ollama installer...', null);
  const sig = await d.signature(target);
  log(`Ollama installer signature: ${sig.status}, ${sig.subject}`);
  if (!trusted(sig)) {
    try { fs.rmSync(target, { force: true }); } catch (e) { /* temp file */ }
    throw new Error(`The downloaded file is not validly signed by Ollama (${sig.status || 'no signature'}), so it was not run. Install Ollama from ollama.com instead.`);
  }
  onStatus('Installing Ollama (about a minute)...', null);
  try {
    await d.runInstaller(target);
  } finally {
    try { fs.rmSync(target, { force: true }); } catch (e) { /* temp file */ }
  }
  log('Ollama installed');
}

module.exports = { installOllama, trusted, download, signature, powershell, INSTALLER_URL, SIGNATURE_SCRIPT };
