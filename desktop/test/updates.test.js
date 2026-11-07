// node --test test/  (no Electron needed: app, dialog, shell and net are fakes)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUpdater, isNewer, parseVersion, decide, DOWNLOAD_PAGE } = require('../updates');

test('version comparison', () => {
  assert.deepStrictEqual(parseVersion('v2.0.3'), [2, 0, 3]);
  assert.strictEqual(parseVersion('latest'), null);
  assert.ok(isNewer('2.0.10', '2.0.9'));
  assert.ok(isNewer('v2.1.0', '2.0.3'));
  assert.ok(!isNewer('2.0.3', '2.0.3'));
  assert.ok(!isNewer('2.0.2', '2.0.3'));
  assert.ok(!isNewer('garbage', '2.0.3'));
});

test('drafts, pre-releases and skipped versions are not offered', () => {
  assert.strictEqual(decide({ tag_name: 'v9.0.0', prerelease: true }, '2.0.3', {}).show, false);
  assert.strictEqual(decide({ tag_name: 'v9.0.0', draft: true }, '2.0.3', {}).show, false);
  assert.strictEqual(decide({ tag_name: 'v2.0.4' }, '2.0.3', { skipVersion: '2.0.4' }).show, false);
  assert.strictEqual(decide({ tag_name: 'v2.0.5' }, '2.0.3', { skipVersion: '2.0.4' }).show, true);
});

function harness({ answers = [], release = { tag_name: 'v2.1.0' }, fail = false, version = '2.0.3' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starkllm-upd-'));
  const calls = { fetch: 0, dialogs: [], opened: [] };
  const deps = {
    app: { getPath: () => dir, getVersion: () => version },
    dialog: {
      showMessageBox: async (_w, opts) => {
        calls.dialogs.push(opts.message);
        return { response: answers.length ? answers.shift() : 1 };
      }
    },
    shell: { openExternal: (u) => calls.opened.push(u) },
    net: {
      fetch: async (url, opts) => {
        calls.fetch++;
        calls.url = url;
        calls.headers = opts.headers;
        if (fail) throw new Error('offline');
        return { ok: true, status: 200, json: async () => release };
      }
    },
    getWindow: () => null
  };
  return { u: createUpdater(deps), calls, dir };
}

test('first start asks; declining means GitHub is never contacted', async () => {
  const { u, calls, dir } = harness({ answers: [1] });
  await u.onStart();
  assert.strictEqual(calls.dialogs.length, 1);
  assert.match(calls.dialogs[0], /Check for new StarkLLM versions/);
  assert.strictEqual(calls.fetch, 0);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'))).updateCheck, false);
  await u.onStart();
  assert.strictEqual(calls.dialogs.length, 1, 'the question is asked only once');
  assert.strictEqual(calls.fetch, 0);
});

test('agreeing checks and offers the download page for a newer version', async () => {
  const { u, calls } = harness({ answers: [0, 0] });
  await u.onStart();
  assert.strictEqual(calls.fetch, 1);
  assert.match(calls.url, /api\.github\.com\/repos\/StarkChristian\/StarkLLM\/releases\/latest/);
  assert.match(calls.headers['User-Agent'], /^StarkLLM-Desktop\/2\.0\.3$/, 'no personal data in the request');
  assert.match(calls.dialogs[1], /2\.1\.0 is available/);
  assert.deepStrictEqual(calls.opened, [DOWNLOAD_PAGE]);
});

test('no dialog when up to date, and a failed check stays silent on start', async () => {
  const a = harness({ answers: [0], release: { tag_name: 'v2.0.3' } });
  await a.u.onStart();
  assert.strictEqual(a.calls.dialogs.length, 1);
  const b = harness({ answers: [0], fail: true });
  await b.u.onStart();
  assert.strictEqual(b.calls.dialogs.length, 1);
});

test('skip this version is remembered; the manual check still reports it', async () => {
  const { u, calls } = harness({ answers: [0, 2] });
  await u.onStart();
  await u.onStart();
  assert.strictEqual(calls.dialogs.length, 2, 'skipped version is not offered again on start');
  await u.check({ manual: true });
  assert.strictEqual(calls.dialogs.length, 3);
});

test('STARKLLM_UPDATE_CHECK=0 turns the automatic check off', async () => {
  process.env.STARKLLM_UPDATE_CHECK = '0';
  try {
    const { u, calls } = harness();
    await u.onStart();
    assert.strictEqual(calls.dialogs.length + calls.fetch, 0);
  } finally {
    delete process.env.STARKLLM_UPDATE_CHECK;
  }
});
