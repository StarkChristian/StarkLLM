// The checks around signing: publisher name as electron-updater compares it, files that must be signed, the allowed list.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sig = require('../build/signature');
const { checkTree } = require('../build/check-signed');
const { checkPublisher } = require('../build/check-publisher');

const CERTUM = 'CN="Open Source Developer, Christian Stark", O="Open Source Developer, Christian Stark", L=Berlin, C=DE';

test('publisher name: CN only, full DN, several names, comma in the name, other publisher', () => {
  assert.ok(sig.publisherMatches(['Open Source Developer, Christian Stark'], CERTUM));
  assert.ok(sig.publisherMatches(['CN="Open Source Developer, Christian Stark", C=DE'], CERTUM));
  assert.ok(sig.publisherMatches(['Old Name', 'Open Source Developer, Christian Stark'], CERTUM), 'both names listed for a certificate change');
  assert.ok(!sig.publisherMatches(['Open Source Developer, Christian Stark '], CERTUM), 'a trailing space is a different name');
  assert.ok(!sig.publisherMatches(['SignPath Foundation'], CERTUM));
  assert.ok(!sig.publisherMatches(['CN="Open Source Developer, Christian Stark", C=PL'], CERTUM));
  assert.ok(!sig.publisherMatches([], CERTUM));
  assert.ok(!sig.publisherMatches(['x'], null));
});

test('OpenSSL subject becomes the string PowerShell shows', () => {
  assert.strictEqual(sig.opensslSubjectToWindows('/CN=Open Source Developer, Christian Stark/O=Org/C=DE'), 'CN="Open Source Developer, Christian Stark", O=Org, C=DE');
  assert.strictEqual(sig.commonName(sig.opensslSubjectToWindows('/CN=A, B/C=DE')), 'A, B');
});

test('publisherName is read from build.win.signtoolOptions (string or list)', () => {
  assert.deepStrictEqual(sig.configuredPublisherNames({ build: { win: { signtoolOptions: { publisherName: 'A' } } } }), ['A']);
  assert.deepStrictEqual(sig.configuredPublisherNames({ build: { win: { signtoolOptions: { publisherName: ['A', 'B'] } } } }), ['A', 'B']);
  assert.deepStrictEqual(sig.configuredPublisherNames({ build: { win: {} } }), []);
});

const fake = (table) => (file) => table[path.basename(file)] || { state: 'unsigned', status: 'NotSigned', subject: null };
const ok = (subject = CERTUM, timestamped = true) => ({ state: 'valid', status: 'Valid', subject, timestamped });

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starkllm-sig-'));
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), 'x');
  }
  return dir;
}

test('check-signed: our unsigned file fails, allowed third-party files and Microsoft signatures pass', () => {
  const dir = tree(['StarkLLM.exe', 'ffmpeg.dll', 'resources/elevate.exe', 'd3dcompiler_47.dll', 'readme.txt', 'node_modules/x/native.node']);
  const names = ['Open Source Developer, Christian Stark'];
  const inspect = fake({ 'StarkLLM.exe': ok(), 'native.node': { state: 'unsigned', subject: null }, 'd3dcompiler_47.dll': ok('CN=Microsoft Corporation, C=US') });
  const r = checkTree([dir], { inspect, publishers: names });
  assert.strictEqual(r.rows.length, 5, 'readme.txt is not a program file');
  assert.deepStrictEqual(r.failures.map((x) => x.rel.replace(/\\/g, '/')), ['node_modules/x/native.node']);
  assert.match(r.rows.find((x) => x.rel === 'ffmpeg.dll').note, /allowed: Electron/);
});

test('check-signed: a file signed by someone else, a broken signature and a missing timestamp fail', () => {
  const dir = tree(['StarkLLM.exe', 'a.dll', 'b.dll']);
  const inspect = fake({ 'StarkLLM.exe': ok('CN=Someone Else'), 'a.dll': { state: 'invalid', status: 'HashMismatch', subject: CERTUM }, 'b.dll': ok(CERTUM, false) });
  const r = checkTree([dir], { inspect, publishers: ['Open Source Developer, Christian Stark'], requireTimestamp: true });
  assert.strictEqual(r.failures.length, 3);
  assert.match(r.rows.find((x) => x.rel === 'StarkLLM.exe').note, /another publisher/);
  assert.match(r.rows.find((x) => x.rel === 'a.dll').note, /not valid/);
  assert.match(r.rows.find((x) => x.rel === 'b.dll').note, /timestamp/);
});

test('check-signed: a single file (the installer) is checked by its name', () => {
  const dir = tree(['StarkLLM-v2.0.16-Setup.exe']);
  const f = path.join(dir, 'StarkLLM-v2.0.16-Setup.exe');
  assert.strictEqual(checkTree([f], { inspect: fake({}) }).failures.length, 1);
  assert.strictEqual(checkTree([f], { inspect: fake({ 'StarkLLM-v2.0.16-Setup.exe': ok() }) }).failures.length, 0);
});

test('the allowed list has a reason for every entry', () => {
  const a = sig.loadAllowlist();
  assert.ok(a.unsigned.length && a.foreign.length);
  for (const e of [...a.unsigned, ...a.foreign]) assert.ok(e.pattern && e.reason && e.reason.length > 15, e.pattern);
  assert.ok(!sig.findAllowed(a.unsigned, 'StarkLLM.exe'), 'our own program is never on the list');
  assert.ok(!sig.findAllowed(a.unsigned, 'Uninstall StarkLLM.exe'), 'our uninstaller is never on the list');
});

test('publisherName check: matching, differing, not configured, not signed', () => {
  const pkg = (n) => ({ build: { win: { signtoolOptions: { publisherName: n } } } });
  const good = () => ok();
  assert.ok(checkPublisher('S.exe', pkg(['Open Source Developer, Christian Stark']), good).ok);
  const bad = checkPublisher('S.exe', pkg(['Other Name']), good);
  assert.ok(!bad.ok && /does not match/.test(bad.message));
  const none = checkPublisher('S.exe', pkg(undefined), good);
  assert.ok(!none.ok && /not set/.test(none.message) && /suggested: "publisherName": \["Open Source Developer, Christian Stark"\]/.test(none.message));
  assert.ok(!checkPublisher('S.exe', pkg(['x']), () => ({ state: 'unsigned', status: 'NotSigned' })).ok);
  // several names (one release before a certificate change): either one is accepted
  assert.ok(checkPublisher('S.exe', pkg(['Old', 'Open Source Developer, Christian Stark']), good).ok);
});

test('check-signed: one more allowed file can be named with its reason (SignPath cannot sign the uninstaller)', () => {
  const dir = tree(['Uninstall StarkLLM.exe', 'StarkLLM.exe']);
  const inspect = fake({ 'StarkLLM.exe': ok() });
  assert.strictEqual(checkTree([dir], { inspect }).failures.length, 1);
  const r = checkTree([dir], { inspect, extraUnsigned: [{ pattern: 'Uninstall StarkLLM.exe', reason: 'written during the build' }] });
  assert.strictEqual(r.failures.length, 0);
});
