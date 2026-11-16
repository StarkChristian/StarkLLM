// Roadmap phase 1: when an updated engine does not start, StarkLLM goes back to the previous engine.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getVersion: () => '2.0.9', getPath: () => require('node:os').tmpdir() } };
  return origLoad.call(this, request, ...rest);
};
const { skipFailedUpdate, keepRollbackImages, rollbackEngine } = require('../engine');
Module._load = origLoad;

const DAY = 24 * 60 * 60 * 1000;

test('a failed update is not tried again for a day while the previous engine runs', () => {
  const state = { failedBuild: 'new', previousBuild: 'old', at: 1000 };
  assert.strictEqual(skipFailedUpdate(state, 'new', 'old', 1000 + DAY - 1), true);
  assert.strictEqual(skipFailedUpdate(state, 'new', 'old', 1000 + DAY + 1), false, 'tried again after a day');
  assert.strictEqual(skipFailedUpdate(state, 'newer', 'old', 2000), false, 'another new build is tried at once');
  assert.strictEqual(skipFailedUpdate(state, 'new', 'other', 2000), false, 'not when another engine runs');
  assert.strictEqual(skipFailedUpdate(null, 'new', 'old', 2000), false);
});

test('the running engine images are kept under a rollback tag', async () => {
  const calls = [];
  const runCmd = async (cmd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'inspect') return { code: 0, lines: [`sha256:${args[3]}`] };
    return { code: 0, lines: [] };
  };
  const previous = await keepRollbackImages('docker', 'old', { runCmd });
  assert.deepStrictEqual(previous, { backend: 'starkllm-backend:rollback', frontend: 'starkllm-frontend:rollback', build: 'old' });
  assert.ok(calls.includes('tag sha256:starkllm-backend starkllm-backend:rollback'));
  assert.ok(calls.includes('tag sha256:starkllm-frontend starkllm-frontend:rollback'));
});

test('no rollback when the running engine images cannot be found', async () => {
  const runCmd = async () => ({ code: 1, lines: ['Error: No such object'] });
  assert.strictEqual(await keepRollbackImages('docker', 'old', { runCmd }), null);
});

test('going back starts the kept images with their own build', async () => {
  let seen;
  const runCmd = async (cmd, args, opts) => {
    seen = { args, env: opts.env };
    return { code: 0, lines: [] };
  };
  const ok = await rollbackEngine({
    docker: 'docker', compose: 'c.yml', cwd: '/tmp', env: { SECRET_KEY: 'k', STARKLLM_ENGINE_BUILD: 'new' },
    previous: { backend: 'starkllm-backend:rollback', frontend: 'starkllm-frontend:rollback', build: 'old' },
    answers: async () => true, runCmd, wait: async (check) => check()
  });
  assert.strictEqual(ok, true);
  assert.deepStrictEqual(seen.args, ['compose', '-p', 'starkllm', '-f', 'c.yml', 'up', '-d', '--no-build']);
  assert.strictEqual(seen.env.STARKLLM_BACKEND_IMAGE, 'starkllm-backend:rollback');
  assert.strictEqual(seen.env.STARKLLM_FRONTEND_IMAGE, 'starkllm-frontend:rollback');
  assert.strictEqual(seen.env.STARKLLM_ENGINE_BUILD, 'old');
  assert.strictEqual(seen.env.SECRET_KEY, 'k', 'same data and key as the new engine');
});

test('going back fails when the previous engine does not answer either', async () => {
  const ok = await rollbackEngine({
    docker: 'docker', compose: 'c.yml', cwd: '/tmp', env: {},
    previous: { backend: 'b', frontend: 'f', build: 'old' },
    answers: async () => false, runCmd: async () => ({ code: 0, lines: [] }), wait: async (check) => check()
  });
  assert.strictEqual(ok, false);
});
