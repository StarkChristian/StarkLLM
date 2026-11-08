// "Install Ollama for me": the installer only runs when Windows confirms a valid signature by Ollama.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installOllama, trusted } = require('../ollama-install');
const { buildErrorPage } = require('../diagnostics');

function deps(sig) {
  const calls = [];
  return {
    calls,
    deps: {
      tmpdir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-')),
      download: async (url, target, onProgress) => { calls.push('download ' + url); fs.writeFileSync(target, 'x'); onProgress(1, 2); onProgress(2, 2); return { bytes: 2, total: 2 }; },
      signature: async () => sig,
      runInstaller: async (file) => { calls.push('install ' + path.basename(file)); },
    },
  };
}

test('only a valid signature by Ollama counts', () => {
  assert.ok(trusted({ status: 'Valid', subject: 'CN=Ollama Inc., O=Ollama Inc., L=Palo Alto, S=California, C=US' }));
  assert.ok(!trusted({ status: 'NotSigned', subject: '' }));
  assert.ok(!trusted({ status: 'Valid', subject: 'CN=Someone Else, O=Someone Else' }));
  assert.ok(!trusted({ status: 'HashMismatch', subject: 'CN=Ollama Inc.' }));
});

test('a signed installer is downloaded from ollama.com and run, with progress', async () => {
  const { calls, deps: d } = deps({ status: 'Valid', subject: 'CN=Ollama Inc., O=Ollama Inc.' });
  const shown = [];
  await installOllama({ onStatus: (t, f) => shown.push([t, f]), deps: d });
  assert.match(calls[0], /^download https:\/\/ollama\.com\/download\/OllamaSetup\.exe$/);
  assert.match(calls[1], /^install OllamaSetup-\d+\.exe$/);
  assert.ok(shown.some(([t, f]) => /Downloading Ollama: 100 %/.test(t) && f === 1));
});

test('an unsigned or foreign installer is not run', async () => {
  const { calls, deps: d } = deps({ status: 'NotSigned', subject: '' });
  await assert.rejects(installOllama({ deps: d }), /not validly signed by Ollama/);
  assert.strictEqual(calls.filter((c) => c.startsWith('install')).length, 0);
});

test('the start page offers "Install Ollama for me" only when Ollama is not installed', () => {
  const base = { docker: 'running', ollama: false, missingModels: [], backend: true, engine: { ok: true, logFile: 'engine.log' } };
  assert.match(buildErrorPage({ ...base, ollamaInstalled: false }), /href="starkllm-install-ollama:">Install Ollama for me</);
  assert.doesNotMatch(buildErrorPage({ ...base, ollamaInstalled: true }), /starkllm-install-ollama/);
});
