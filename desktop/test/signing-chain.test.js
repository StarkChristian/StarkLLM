// The whole signing chain as a dry run with a self-signed test certificate made at run time: sign the app folder,
// pack (stand-in for electron-builder), sign the installer, recompute latest.yml and the blockmap, check every file.
// Needs osslsigncode and openssl on PATH (Linux: apt install osslsigncode) or Windows with signtool; skipped otherwise.
// What this cannot show: the Certum certificate and SimplySign, electron-builder's real NSIS build, Windows trust.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeTestCert } = require('../build/make-test-cert');

const root = path.join(__dirname, '..');
const vendor = path.join(root, 'node_modules', 'electron-winstaller', 'vendor');
const have = (cmd) => !spawnSync(cmd, ['--version'], { stdio: 'ignore' }).error;
const canRun = process.platform !== 'win32' && have('osslsigncode') && have('openssl') && fs.existsSync(vendor);
const skip = canRun ? false : 'needs osslsigncode, openssl and electron-winstaller vendor files (dry run on Linux)';

function makeApp(dir) {
  const put = (to, from) => { fs.mkdirSync(path.dirname(path.join(dir, to)), { recursive: true }); fs.copyFileSync(path.join(vendor, from), path.join(dir, to)); };
  put('StarkLLM.exe', 'rcedit.exe');
  put('7z.dll', '7z.dll');
  put('ffmpeg.dll', '7z-x64.dll');
  put('resources/elevate.exe', 'WriteZipToSetup.exe');
  put('resources/native/addon.node', 'winterop.dll');
  fs.writeFileSync(path.join(dir, 'resources', 'app-update.yml'), 'provider: github\n');
}

function releaseSign(app, work, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(root, 'build', 'release-sign.js'), '--app', app, '--work', work], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, STARKLLM_SIGN: 'test', FAKE_INSTALLER_SOURCE: path.join(vendor, 'Setup.exe'), STARKLLM_PACK_CMD: `node ${path.join(root, 'build', 'fake-pack.js')} {app} {out}`, ...extraEnv },
  });
}

test('dry run: every file signed, installer signed, latest.yml follows the signed installer', { skip }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starkllm-chain-'));
  const app = path.join(tmp, 'win-unpacked');
  makeApp(app);
  const before = fs.statSync(path.join(app, 'StarkLLM.exe')).size;
  const r = releaseSign(app, path.join(tmp, 'work'));
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /3 signed now/);
  assert.match(r.stdout, /ok   StarkLLM-v[\d.]+-Setup\.exe  signed: CN="Open Source Developer, StarkLLM Test/);
  assert.match(r.stdout, /not signed \(third-party file[^)]*\): ffmpeg\.dll/, 'third-party files are not signed by default');
  assert.match(r.stdout, /ffmpeg\.dll {2}unsigned, allowed/);
  assert.match(r.stdout, /signatures made in this run \(.*\): 5\b/);  // StarkLLM.exe, 7z.dll, addon.node, uninstaller, installer
  assert.strictEqual(fs.statSync(path.join(app, 'StarkLLM.exe')).size, before, 'the original app folder is not touched');
  const out = path.join(tmp, 'work', 'out');
  const yml = fs.readFileSync(path.join(out, 'latest.yml'), 'utf8');
  const size = fs.statSync(path.join(out, fs.readdirSync(out).find((f) => /Setup\.exe$/.test(f)))).size;
  assert.match(yml, new RegExp(`size: ${size}\\b`));
  assert.ok(fs.existsSync(path.join(out, fs.readdirSync(out).find((f) => /Setup\.exe$/.test(f)) + '.blockmap')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('dry run: STARKLLM_SIGN_THIRD_PARTY=1 signs the third-party files too', { skip }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starkllm-chain-'));
  const app = path.join(tmp, 'win-unpacked');
  makeApp(app);
  const r = releaseSign(app, path.join(tmp, 'work'), { STARKLLM_SIGN_THIRD_PARTY: '1' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /5 signed now/);
  assert.match(r.stdout, /ffmpeg\.dll {2}signed/);
  assert.match(r.stdout, /elevate\.exe {2}signed/);
  assert.match(r.stdout, /signatures made in this run \(.*\): 7\b/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('dry run, started again: files that are signed are kept (resume after an expired session)', { skip }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starkllm-chain-'));
  const app = path.join(tmp, 'win-unpacked');
  makeApp(app);
  const c = makeTestCert(path.join(tmp, 'cert'));
  const env = { STARKLLM_SIGN_PFX: c.pfx, STARKLLM_SIGN_PFX_PASSWORD: c.password, STARKLLM_TEST_CA: c.pem };
  // first run signs half of the files only, as if the session ended: sign two files by hand with the same certificate
  const first = spawnSync(process.execPath, [path.join(root, 'build', 'sign.js'), path.join(app, 'StarkLLM.exe'), path.join(app, '7z.dll')],
    { cwd: root, encoding: 'utf8', env: { ...process.env, STARKLLM_SIGN: 'test', ...env } });
  assert.strictEqual(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /2 of 2 files signed/);
  const r = releaseSign(app, path.join(tmp, 'work'), env);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /kept existing signature: StarkLLM\.exe/);
  assert.match(r.stdout, /kept existing signature: 7z\.dll/);
  assert.match(r.stdout, /1 signed now/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('dry run: an unsigned file of ours fails the check, a file changed after signing fails it too', { skip }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starkllm-chain-'));
  const app = path.join(tmp, 'win-unpacked');
  makeApp(app);
  const work = path.join(tmp, 'work');
  assert.strictEqual(releaseSign(app, work).status, 0);
  const signed = path.join(work, 'app');
  const env = { ...process.env, STARKLLM_TEST_CA: path.join(work, 'test-cert', 'test-sign.pem') };
  const check = () => spawnSync(process.execPath, [path.join(root, 'build', 'check-signed.js'), signed], { encoding: 'utf8', env });
  assert.strictEqual(check().status, 0, check().stdout);
  fs.appendFileSync(path.join(signed, '7z.dll'), 'tampered');
  const t = check();
  assert.strictEqual(t.status, 1);
  assert.match(t.stdout, /FAIL 7z\.dll/);
  fs.copyFileSync(path.join(vendor, 'candle.exe'), path.join(signed, 'NewTool.exe'));
  const u = check();
  assert.match(u.stdout, /FAIL NewTool\.exe {2}UNSIGNED/);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('dry run: a publisherName that differs from the signature stops the release', { skip }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starkllm-chain-'));
  const app = path.join(tmp, 'win-unpacked');
  makeApp(app);
  const work = path.join(tmp, 'work');
  assert.strictEqual(releaseSign(app, work).status, 0);
  const signed = fs.readdirSync(path.join(work, 'out')).find((f) => /Setup\.exe$/.test(f));
  const env = { ...process.env, STARKLLM_TEST_CA: path.join(work, 'test-cert', 'test-sign.pem') };
  const r = spawnSync(process.execPath, [path.join(root, 'build', 'check-publisher.js'), path.join(work, 'out', signed)], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /publisherName is not set/);
  assert.match(r.stdout, /suggested: "publisherName": \["Open Source Developer, StarkLLM Test/);
  fs.rmSync(tmp, { recursive: true, force: true });
});
