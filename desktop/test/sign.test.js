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
