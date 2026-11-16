// Fully offline must never download anything, also not the engine images (MSI test of 2.1.1, finding N15).
const test = require('node:test');
const assert = require('node:assert');
const { offlineUpArgs } = require('../engine');

test('fully offline starts the engine only from images on this PC (no build, no pull)', () => {
  const args = offlineUpArgs('starkllm', 'c.yml');
  assert.deepStrictEqual(args, ['compose', '-p', 'starkllm', '-f', 'c.yml', 'up', '-d', '--no-build', '--pull', 'never']);
});

test('the offline start in startEngine uses these arguments', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'engine.js'), 'utf8');
  const offlineBranch = src.slice(src.indexOf('if (guard.isOffline()) {'), src.indexOf('} else if (usePrebuilt()) {'));
  assert.ok(src.includes('const noBuildUp = () => run(docker, offlineUpArgs(PROJECT, compose)'));
  assert.ok(offlineBranch.includes('noBuildUp()'));
  assert.ok(!/'pull'/.test(offlineBranch));
});
