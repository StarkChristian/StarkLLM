// Signs and packs a release on one PC: sign every file of the app folder, pack the installer from it, sign the
// installer (and the uninstaller, inside electron-builder's run), recompute latest.yml and the blockmap, verify.
// This is the local counterpart of .github/workflows/desktop-release.yml (which uses SignPath).
// Step by step instructions for the owner: docs/signing-on-owner-pc.md.
//
//   node build/release-sign.js [--app dist/win-unpacked] [--work release-work] [--install-check]
//
//   STARKLLM_SIGN=certum  STARKLLM_CERT_SHA1=<thumbprint>     the real certificate (Windows, SimplySign logged in)
//   STARKLLM_SIGN=test                                        a self-signed certificate made now (dry run; on Windows
//                                                             and on Linux with osslsigncode)
//   STARKLLM_PACK_CMD   replaces the electron-builder command ({app} and {out} are filled in); used by the Linux dry run
//
// The app folder comes from an unsigned build of the same commit: `npx electron-builder --win nsis --x64 --publish never`
// (it contains resources/app-update.yml). The folder is copied; the original is not touched. Files that carry a valid
// signature are kept, so after an expired SimplySign session the same command can be run again.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const sig = require('./signature');
const sign = require('./sign');
const { makeTestCert } = require('./make-test-cert');
const { refreshUpdateInfo } = require('./refresh-update-info');
const { checkTree } = require('./check-signed');
const { checkPublisher } = require('./check-publisher');

const root = path.join(__dirname, '..');

function step(n, text) { console.log(`\n== ${n}. ${text}`); }

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function trustOnThisPc(cer) {
  // makes a self-signed test certificate count as trusted on this PC only (CI runner); needs administrator rights
  const ps = [`Import-Certificate -FilePath '${cer}' -CertStoreLocation Cert:\\LocalMachine\\Root | Out-Null`,
    `Import-Certificate -FilePath '${cer}' -CertStoreLocation Cert:\\LocalMachine\\TrustedPublisher | Out-Null`].join('; ');
  const r = sig.powershell(ps);
  if (r.status !== 0) throw new Error(`could not trust the test certificate (run as administrator): ${r.stderr}`);
}

function parseArgs(argv) {
  const o = { app: path.join(root, 'dist', 'win-unpacked'), work: path.join(root, 'release-work'), installCheck: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--app') o.app = path.resolve(argv[++i]);
    else if (argv[i] === '--work') o.work = path.resolve(argv[++i]);
    else if (argv[i] === '--install-check') o.installCheck = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const pkg = require('../package.json');
  const mode = process.env.STARKLLM_SIGN;
  if (mode !== 'certum' && mode !== 'test') throw new Error('set STARKLLM_SIGN=certum (release) or STARKLLM_SIGN=test (dry run)');
  const names = sig.configuredPublisherNames(pkg);

  step(0, `Preflight (${mode}, version ${pkg.version})`);
  if (mode === 'certum') {
    if (process.platform !== 'win32') throw new Error('STARKLLM_SIGN=certum needs Windows with SimplySign Desktop');
    if (!names.length) throw new Error('publisherName is not set in package.json. Run: node build/check-publisher.js --from-store <thumbprint>, put the line into package.json, build the unsigned app folder again.');
    sign.signArgs('certum', 'x.exe'); // validates the thumbprint / subject settings
    sig.signtoolPath();
  }
  let expectedNames = names;
  if (mode === 'test') {
    if (!process.env.STARKLLM_SIGN_PFX) {
      const c = makeTestCert(path.join(o.work, 'test-cert'));
      process.env.STARKLLM_SIGN_PFX = c.pfx;
      process.env.STARKLLM_SIGN_PFX_PASSWORD = c.password;
      if (c.pem) process.env.STARKLLM_TEST_CA = c.pem;
      if (c.cer && process.env.CI) trustOnThisPc(c.cer);
      console.log(`test certificate made: ${c.cn}`);
    }
    if (!expectedNames.length) expectedNames = [require('./make-test-cert').TEST_CN];
  }
  if (!fs.existsSync(path.join(o.app, 'StarkLLM.exe'))) throw new Error(`${o.app} has no StarkLLM.exe: build the unsigned app first (npx electron-builder --win nsis --x64 --publish never)`);
  const updateYml = path.join(o.app, 'resources', 'app-update.yml');
  if (!fs.existsSync(updateYml) && !process.env.STARKLLM_PACK_CMD) throw new Error('resources/app-update.yml is missing: the app could not find updates');

  const countFile = path.join(o.work, 'signatures.count');
  fs.mkdirSync(o.work, { recursive: true });
  fs.writeFileSync(countFile, '');
  process.env.STARKLLM_SIGN_COUNT_FILE = countFile;
  // signed copies of unchanged files are reused by the next build (sign.js): STARKLLM_SIGN_CACHE=off turns it off
  if (process.env.STARKLLM_SIGN_CACHE === 'off') delete process.env.STARKLLM_SIGN_CACHE;
  else process.env.STARKLLM_SIGN_CACHE = process.env.STARKLLM_SIGN_CACHE || path.join(require('os').homedir(), '.starkllm-signed-files');
  if (names.length && fs.existsSync(updateYml)) {
    // app-update.yml is written by electron-builder from package.json: an app folder built before publisherName was set has none
    const have = [].concat(require('js-yaml').load(fs.readFileSync(updateYml, 'utf8')).publisherName || []);
    if (JSON.stringify(have) !== JSON.stringify(names)) throw new Error(`app-update.yml has publisherName ${JSON.stringify(have)}, package.json ${JSON.stringify(names)}: build the unsigned app folder again after changing package.json`);
  }

  const appDir = path.join(o.work, 'app');
  const outDir = path.join(o.work, 'out');
  fs.rmSync(appDir, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  step(1, `Copy the app folder to ${appDir}`);
  fs.cpSync(o.app, appDir, { recursive: true });

  step(2, 'Sign every file of the app folder');
  const files = sig.listPeFiles(appDir);
  console.log(`${files.length} program files`);
  const signed = sign.signFiles(files);
  console.log(`${signed} signed now`);

  step(3, 'Pack the installer from the signed folder (electron-builder signs the uninstaller and the installer itself)');
  const q = (p) => `"${p}"`;
  const template = process.env.STARKLLM_PACK_CMD ||
    'npx electron-builder --win nsis --x64 --prepackaged {app} --publish never --config.directories.output={out}';
  const cmd = template.replace('{app}', q(appDir)).replace('{out}', q(outDir));
  const pack = spawnSync(cmd, { cwd: root, shell: true, stdio: 'inherit', env: process.env });
  if (pack.status !== 0) throw new Error(`packing failed (exit ${pack.status})`);
  const installers = fs.readdirSync(outDir).filter((f) => /-Setup\.exe$/i.test(f));
  if (installers.length !== 1) throw new Error(`expected one *-Setup.exe in ${outDir}, found ${installers.length}`);
  const installer = path.join(outDir, installers[0]);

  step(4, 'Sign the installer (kept if electron-builder already did)');
  console.log(`${sign.signFiles([installer])} signed now`);

  step(5, 'latest.yml and blockmap from the signed installer');
  const r = await refreshUpdateInfo(outDir);
  console.log(`${r.name}: size ${r.size}, sha512 ${r.sha512}${r.changed ? ' (updated)' : ' (unchanged)'}`);

  step(6, 'Check: every file we own is signed');
  const opts = { publishers: expectedNames, requireTimestamp: mode === 'certum' };
  let { rows, failures } = checkTree([appDir, installer], opts);
  rows.forEach((x) => console.log(`${x.ok ? 'ok  ' : 'FAIL'} ${x.rel}  ${x.note}`));
  if (failures.length) throw new Error(`${failures.length} files are not signed as required`);

  step(7, 'Check: publisherName matches the signature');
  if (names.length) {
    const p = checkPublisher(installer, pkg);
    console.log(p.message);
    if (!p.ok) throw new Error('publisherName check failed');
  } else {
    console.log('publisherName is not set (allowed in a dry run only)');
  }

  if (o.installCheck) {
    step(8, 'Install silently, check the installed files incl. the uninstaller, uninstall');
    if (process.platform !== 'win32') throw new Error('--install-check needs Windows');
    const dir = path.join(process.env.LOCALAPPDATA, 'Programs', 'StarkLLM');
    const inst = spawnSync(installer, ['/S', '/currentuser'], { windowsHide: true });
    if (inst.status !== 0) throw new Error(`installer exit code ${inst.status}`);
    const deadline = Date.now() + 6 * 60 * 1000;
    while (!fs.existsSync(path.join(dir, 'StarkLLM.exe')) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    const c = checkTree([dir], opts);
    c.rows.forEach((x) => console.log(`${x.ok ? 'ok  ' : 'FAIL'} ${x.rel}  ${x.note}`));
    const un = fs.readdirSync(dir).find((f) => /^Uninstall.*\.exe$/i.test(f));
    if (un) spawnSync(path.join(dir, un), ['/S', '/currentuser'], { windowsHide: true });
    if (!c.rows.some((x) => /^Uninstall/i.test(x.rel))) throw new Error('no uninstaller found in the install folder');
    if (c.failures.length) throw new Error(`${c.failures.length} installed files are not signed as required`);
  }

  step('Done', `signatures made in this run (all programs, including the ones electron-builder signed): ${fs.statSync(countFile).size}`);
  for (const f of [installer, `${installer}.blockmap`, path.join(outDir, 'latest.yml')]) {
    console.log(`${sha256(f)}  ${path.basename(f)}  (${fs.statSync(f).size} bytes)`);
  }
  console.log(`\nUpload these three files from ${outDir} to the draft GitHub release.`);
}

main().catch((e) => { console.error(`\nFAILED: ${e.message}`); process.exit(1); });
