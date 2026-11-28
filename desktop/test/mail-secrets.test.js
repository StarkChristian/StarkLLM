// Letters from e-mail (docs/mail-import.md): the passwords of the mail accounts are kept only wrapped by the key store.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMemoryKeyStore } = require('../data-key');
const { MailSecrets, mailToken, deliverPasswords, forgetPasswords } = require('../mail-secrets');

const PASSWORD = 'test-app-password-' + crypto.randomBytes(6).toString('hex');   // made up for the test

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mail-secrets-'));
}

test('a password is stored wrapped by the key store, never in plain text', () => {
  const dir = tmpDir();
  const secrets = new MailSecrets({ dir, keyStore: createMemoryKeyStore() });
  secrets.set(7, PASSWORD);
  const raw = fs.readFileSync(path.join(dir, 'mail-secrets.json'), 'utf8');
  assert.ok(!raw.includes(PASSWORD));
  assert.ok(!raw.includes(Buffer.from(PASSWORD).toString('base64')));
  assert.deepEqual(secrets.ids(), [7]);
  assert.deepEqual(secrets.passwords(), { 7: PASSWORD });
  assert.deepEqual(secrets.passwords([8]), {});
  assert.equal(secrets.remove(7), true);
  assert.deepEqual(secrets.passwords(), {});
});

test('without a key store nothing is written', () => {
  const dir = tmpDir();
  const secrets = new MailSecrets({ dir, keyStore: createMemoryKeyStore({ available: false }) });
  assert.throws(() => secrets.set(1, PASSWORD), (e) => e.code === 'no-key-store');
  assert.equal(fs.existsSync(path.join(dir, 'mail-secrets.json')), false);
  assert.throws(() => new MailSecrets({ dir, keyStore: createMemoryKeyStore() }).set('x', PASSWORD), (e) => e.code === 'bad-account');
  assert.throws(() => new MailSecrets({ dir, keyStore: createMemoryKeyStore() }).set(1, ''), (e) => e.code === 'bad-password');
});

test('a password of another Windows account (another key) is left out, not shown', () => {
  const dir = tmpDir();
  new MailSecrets({ dir, keyStore: createMemoryKeyStore() }).set(3, PASSWORD);
  assert.deepEqual(new MailSecrets({ dir, keyStore: createMemoryKeyStore() }).passwords(), {});
});

test('the engine gets the passwords with the token derived from its secret, and forgets them on request', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ known: [7], unknown: [9] }) };
  };
  const r = await deliverPasswords({ apiUrl: 'http://127.0.0.1:8000', secret: 's3cret', passwords: { 7: PASSWORD, 9: 'x' }, fetchImpl });
  assert.deepEqual(r, { ok: true, known: [7], unknown: [9] });
  assert.equal(calls[0].url, 'http://127.0.0.1:8000/api/v1/mail/internal/passwords');
  const expected = crypto.createHmac('sha256', 's3cret').update('starkllm-mail-secrets').digest('hex');
  assert.equal(calls[0].opts.headers['X-StarkLLM-Internal'], expected);
  assert.equal(mailToken('s3cret'), expected);
  assert.deepEqual(JSON.parse(calls[0].opts.body), { passwords: { 7: PASSWORD, 9: 'x' } });
  assert.deepEqual(await deliverPasswords({ apiUrl: 'x', secret: 's', passwords: {}, fetchImpl }), { ok: true, known: [], unknown: [] });
  assert.equal(calls.length, 1);   // nothing to hand over: no request
  await forgetPasswords({ apiUrl: 'http://127.0.0.1:8000', secret: 's3cret', fetchImpl });
  assert.equal(calls[1].url, 'http://127.0.0.1:8000/api/v1/mail/internal/forget');
  assert.deepEqual(JSON.parse(calls[1].opts.body), { ids: null });
});

test('only the app page may store a password, and the page has no way to read one back', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const handlers = main.slice(main.indexOf('function registerMailHandlers'), main.indexOf('function registerMailHandlers') + 2500);
  assert.match(handlers, /fromAppPage\(event\)/);
  assert.match(handlers, /'mail:set-password'/);
  const start = preload.indexOf('mail: {');
  const bridge = preload.slice(start, preload.indexOf('\n  },', start));
  assert.match(bridge, /setPassword/);
  assert.doesNotMatch(bridge, /\bgetPassword|\bpasswords\(|\bread\(/);
});
