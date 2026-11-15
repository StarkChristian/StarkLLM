// Code signing (build/sign.js): nothing is signed without STARKLLM_SIGN, and the signtool arguments per mode.
const test = require('node:test');
const assert = require('node:assert');
const sign = require('../build/sign');

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('without STARKLLM_SIGN nothing is signed (local builds, pull requests without a certificate)', async () => {
  await withEnv({ STARKLLM_SIGN: null }, async () => {
    assert.strictEqual(sign.signFile('C:\\x\\StarkLLM.exe', () => {}), false);
    await sign({ path: 'C:\\x\\StarkLLM.exe', hash: 'sha256' });
  });
});

test('test certificate: SHA-256 with the PFX file', () => {
  withEnv({ STARKLLM_SIGN_PFX: 'C:\\t\\test.pfx', STARKLLM_SIGN_PFX_PASSWORD: 'pw' }, () => {
    assert.deepStrictEqual(sign.signArgs('test', 'a.dll'), ['sign', '/fd', 'sha256', '/f', 'C:\\t\\test.pfx', '/p', 'pw', 'a.dll']);
  });
});

test('Artifact Signing: SHA-256, RFC 3161 timestamp from Microsoft, the signing client library', () => {
  withEnv({ STARKLLM_AZURE_DLIB: 'C:\\a\\Azure.CodeSigning.Dlib.dll', STARKLLM_AZURE_METADATA: 'C:\\a\\metadata.json' }, () => {
    const args = sign.signArgs('azure', 'StarkLLM.exe');
    assert.deepStrictEqual(args.slice(0, 7), ['sign', '/fd', 'sha256', '/tr', 'http://timestamp.acs.microsoft.com', '/td', 'sha256']);
    assert.ok(args.includes('/dlib') && args.includes('/dmdf') && args[args.length - 1] === 'StarkLLM.exe');
  });
  withEnv({ STARKLLM_AZURE_DLIB: null, STARKLLM_AZURE_METADATA: null }, () => {
    assert.throws(() => sign.signArgs('azure', 'x.exe'), /STARKLLM_AZURE_DLIB/);
  });
});

test('an unknown mode is refused instead of building unsigned files by mistake', () => {
  assert.throws(() => sign.signArgs('tset', 'x.exe'), /unknown STARKLLM_SIGN/);
});

test('Certum: signtool with the certificate from the store, SHA-256, RFC 3161 timestamp from time.certum.pl', () => {
  const thumb = 'aa bb:cc dd ee ff 00 11 22 33 44 55 66 77 88 99 aa bb cc dd'.replace(/[ :]/g, '');
  withEnv({ STARKLLM_CERT_SHA1: thumb.toLowerCase(), STARKLLM_CERT_SUBJECT: null, STARKLLM_TIMESTAMP_URL: null, STARKLLM_CERT_STORE_MACHINE: null }, () => {
    assert.deepStrictEqual(sign.signArgs('certum', 'a.exe'), ['sign', '/fd', 'sha256', '/tr', 'http://time.certum.pl', '/td', 'sha256', '/sha1', thumb.toUpperCase(), 'a.exe']);
    assert.deepStrictEqual(sign.signArgs('certum', ['a.exe', 'b.dll']).slice(-2), ['a.exe', 'b.dll']);
  });
});

test('Certum: by subject name, other timestamp server, machine store', () => {
  withEnv({ STARKLLM_CERT_SHA1: null, STARKLLM_CERT_SUBJECT: 'Open Source Developer, Christian Stark', STARKLLM_TIMESTAMP_URL: 'http://ts.example', STARKLLM_CERT_STORE_MACHINE: '1' }, () => {
    assert.deepStrictEqual(sign.signArgs('certum', 'a.exe'), ['sign', '/fd', 'sha256', '/tr', 'http://ts.example', '/td', 'sha256', '/n', 'Open Source Developer, Christian Stark', '/sm', 'a.exe']);
  });
});

test('Certum: needs a thumbprint or a name, refuses a malformed thumbprint, has no setting for PIN or code', () => {
  withEnv({ STARKLLM_CERT_SHA1: null, STARKLLM_CERT_SUBJECT: null }, () => {
    assert.throws(() => sign.signArgs('certum', 'a.exe'), /STARKLLM_CERT_SHA1/);
  });
  withEnv({ STARKLLM_CERT_SHA1: '1234', STARKLLM_CERT_SUBJECT: null }, () => {
    assert.throws(() => sign.signArgs('certum', 'a.exe'), /40 hex/);
  });
  const src = require('node:fs').readFileSync(require.resolve('../build/sign.js'), 'utf8');
  assert.deepStrictEqual(src.match(/process\.env\.STARKLLM_\w*(PIN|OTP|CODE)\w*/gi), null, 'no PIN or code is read from the environment');
});

test('osslsigncode (Linux dry run) only does the test certificate', () => {
  withEnv({ STARKLLM_SIGN_PFX: '/t/test.pfx', STARKLLM_SIGN_PFX_PASSWORD: 'pw' }, () => {
    assert.deepStrictEqual(sign.osslsigncodeArgs('test', 'a.dll', 'a.dll.signing'), ['sign', '-pkcs12', '/t/test.pfx', '-pass', 'pw', '-h', 'sha256', '-in', 'a.dll', '-out', 'a.dll.signing']);
    assert.throws(() => sign.osslsigncodeArgs('certum', 'a.dll', 'x'), /needs Windows/);
  });
});
