// Signing the installer after the build changes its bytes. electron-updater checks the downloaded installer
// against the sha512 and size in latest.yml, and uses the .blockmap for differential downloads, so both are
// computed again from the signed file.
//
// Usage: node build/refresh-update-info.js <dist folder>
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { serializeToYaml } = require('builder-util');
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');

async function refreshUpdateInfo(dir) {
  const latestFile = path.join(dir, 'latest.yml');
  const info = yaml.load(fs.readFileSync(latestFile, 'utf8'));
  const installers = (info.files || []).map((f) => f.url);
  if (installers.length !== 1) throw new Error(`latest.yml should list one installer, found ${installers.length}`);
  const name = installers[0];
  const installer = path.join(dir, name);
  const blockmap = await buildBlockMap(installer, 'gzip', `${installer}.blockmap`);
  const size = fs.statSync(installer).size;
  if (blockmap.size !== size) throw new Error(`blockmap size ${blockmap.size} differs from file size ${size}`);
  const before = info.files[0].sha512;
  info.files[0].sha512 = blockmap.sha512;
  info.files[0].size = size;
  if (info.path === name) info.sha512 = blockmap.sha512;
  fs.writeFileSync(latestFile, serializeToYaml(info));
  return { name, size, sha512: blockmap.sha512, changed: before !== blockmap.sha512 };
}

module.exports = { refreshUpdateInfo };

if (require.main === module) {
  refreshUpdateInfo(process.argv[2] || 'dist')
    .then((r) => console.log(`${r.name}: size ${r.size}, sha512 ${r.sha512}${r.changed ? ' (updated)' : ' (unchanged)'}`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
