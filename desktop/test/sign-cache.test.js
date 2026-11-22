// Signatures kept for the next build (build/sign.js reuseKept / keepSigned): the same unsigned bytes get the same
// signed copy, a changed file is signed again, an invalid kept copy is never used.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reuseKept, keepSigned } = require('../build/sign');

// a stand-in for a signature: a file is "valid" when it ends with the marker
const MARK = Buffer.from('#signed');
const isValid = (f) => fs.readFileSync(f).subarray(-MARK.length).equals(MARK);
const fakeSign = (f) => fs.appendFileSync(f, MARK);

test('a file signed once is not signed again in the next build; a changed file is', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'starkllm-signcache-'));
  const cache = path.join(tmp, 'cache');
  const build = (n, content) => {
    const dir = path.join(tmp, `build${n}`);
    fs.mkdirSync(dir);
    for (const [name, text] of Object.entries(content)) fs.writeFileSync(path.join(dir, name), text);
    return Object.keys(content).map((name) => path.join(dir, name));
  };
  // build 1: nothing kept yet, both files are signed and kept
  const one = build(1, { 'engine.dll': 'same bytes', 'app.exe': 'version 1' });
  let r = reuseKept(one, cache, isValid, () => {});
  assert.strictEqual(r.reused, 0);
  assert.strictEqual(r.pending.length, 2);
  r.pending.forEach(fakeSign);
  assert.strictEqual(keepSigned(r.keys, cache, isValid), 2);
  // build 2: the engine file is the same, the app changed
  const two = build(2, { 'engine.dll': 'same bytes', 'app.exe': 'version 2' });
  r = reuseKept(two, cache, isValid, () => {});
  assert.strictEqual(r.reused, 1);
  assert.deepStrictEqual(r.pending.map((f) => path.basename(f)), ['app.exe']);
  assert.ok(isValid(two[0]));
  assert.strictEqual(fs.readFileSync(two[0], 'utf8'), 'same bytes#signed');
  // an invalid kept copy (for example an expired signature) is not used
  const key = [...r.keys.values()][0];
  fs.writeFileSync(path.join(cache, key), 'broken');
  fs.rmSync(path.join(cache, key));
  const three = build(3, { 'engine.dll': 'same bytes' });
  fs.writeFileSync(path.join(cache, [...reuseKept(build(4, { 'x.dll': 'x' }), cache, isValid, () => {}).keys.values()][0]), 'not signed');
  const four = build(5, { 'x.dll': 'x' });
  r = reuseKept(four, cache, isValid, () => {});
  assert.strictEqual(r.reused, 0);
  assert.strictEqual(fs.readFileSync(four[0], 'utf8'), 'x'); // the original stays
  assert.ok(!fs.existsSync(`${four[0]}.kept`));
  assert.ok(three.length === 1);
});

test('no cache folder: nothing changes', () => {
  const r = reuseKept(['a', 'b'], '', isValid, () => {});
  assert.deepStrictEqual(r.pending, ['a', 'b']);
  assert.strictEqual(keepSigned(r.keys, '', isValid), 0);
});
