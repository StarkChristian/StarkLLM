const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { refreshUpdateInfo } = require('../build/refresh-update-info');

test('latest.yml and the blockmap follow the signed installer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-'));
  const name = 'StarkLLM-v9.9.9-Setup.exe';
  const file = path.join(dir, name);
  fs.writeFileSync(file, crypto.randomBytes(300 * 1024));
  fs.writeFileSync(path.join(dir, 'latest.yml'),
    `version: 9.9.9\nfiles:\n  - url: ${name}\n    sha512: old\n    size: 1\npath: ${name}\nsha512: old\nreleaseDate: '2026-11-12T00:00:00.000Z'\n`);
  // "signing" appends bytes
  fs.appendFileSync(file, Buffer.from('signature'));

  const r = await refreshUpdateInfo(dir);
  const want = crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
  const yml = fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8');
  assert.strictEqual(r.sha512, want);
  assert.ok(r.changed);
  assert.match(yml, new RegExp(`sha512: ${want.replace(/[+/]/g, '\\$&')}`));
  assert.match(yml, new RegExp(`size: ${fs.statSync(file).size}`));
  assert.match(yml, /releaseDate: '2026-11-12T00:00:00.000Z'/);
  assert.ok(!yml.includes('old'));
  assert.ok(fs.statSync(`${file}.blockmap`).size > 0);
});

test('refuses a latest.yml without exactly one installer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refresh-'));
  fs.writeFileSync(path.join(dir, 'latest.yml'), 'version: 1.0.0\nfiles: []\n');
  await assert.rejects(refreshUpdateInfo(dir), /one installer/);
});
