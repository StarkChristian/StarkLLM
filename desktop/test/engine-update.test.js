// Found on Windows (8 Nov 2026): after installing a new build over an older one the old engine kept running, because
// the app reused any engine that answered. The engine is now reused only when it was built from the same files.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// engine.js needs Electron's app object; a stand-in is enough for this pure function.
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getVersion: () => '2.0.5', getPath: () => '/tmp' } };
  return origLoad.call(this, request, ...rest);
};
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { engineIsCurrent, engineFingerprint } = require('../engine');
Module._load = origLoad;

function engineDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-'));
  fs.mkdirSync(path.join(dir, 'backend', 'app'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), 'services: {}');
  fs.writeFileSync(path.join(dir, 'backend', 'app', 'vision_service.py'), 'old');
  fs.writeFileSync(path.join(dir, 'backend', 'app', 'voice.onnx'), Buffer.alloc(2 * 1024 * 1024));
  return dir;
}

test('the fingerprint changes when an engine file changes, also with the same version number', () => {
  const dir = engineDir();
  const before = engineFingerprint(dir);
  assert.strictEqual(engineFingerprint(dir), before);
  fs.writeFileSync(path.join(dir, 'backend', 'app', 'vision_service.py'), 'new');
  assert.notStrictEqual(engineFingerprint(dir), before);
});

test('a running engine is reused only when it was built from the same files', () => {
  assert.strictEqual(engineIsCurrent({ version: '2.0.5', build: 'abc' }, 'abc'), true);
  assert.strictEqual(engineIsCurrent({ version: '2.0.5', build: 'old' }, 'abc'), false);
});

test('an engine from before 2.0.5 (no build in /health) or one that does not answer is updated', () => {
  assert.strictEqual(engineIsCurrent({ status: 'ok', version: '2.0.4' }, 'abc'), false);
  assert.strictEqual(engineIsCurrent(null, 'abc'), false);
});
