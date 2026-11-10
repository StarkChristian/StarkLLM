// Copies the NSIS toolset electron-builder builds the installer with, so CI can sign the plugin DLLs that end up inside
// the installer before the build. Windows Smart App Control checks these DLLs when the installer unpacks and loads them
// (seen 9 Nov 2026: unsigned plugins blocked the 2.0.8 update; System.dll comes with NSIS itself, StdUtils.dll,
// nsProcess.dll, UAC.dll, ... with electron-builder's NSIS resources).
//
// node build/copy-nsis-plugins.js <target folder>
//   <target>/nsis       the NSIS bundle with its Plugins          -> ELECTRON_BUILDER_NSIS_DIR
//   <target>/resources  electron-builder's NSIS resources/plugins -> ELECTRON_BUILDER_NSIS_RESOURCES_DIR
// Prints the plugin DLLs to sign, one per line, after a "DLLS" line.
const fs = require('fs');
const path = require('path');

function dllsIn(dir) {
  const found = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.dll$/i.test(e.name)) found.push(p);
  });
  walk(dir);
  return found;
}

async function main() {
  const target = path.resolve(process.argv[2] || 'nsis-toolset');
  const { getNsisPluginsPath, getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows');
  const config = require('../package.json').build || {};
  const nsisVersion = config.toolsets && config.toolsets.nsis;
  const customResources = config.nsis && config.nsis.customNsisResources;
  const customBinary = config.nsis && config.nsis.customNsisBinary;

  const make = await getMakeNsisPath(nsisVersion, customBinary);
  // legacy bundles say where they are in NSISDIR; newer ones have makensis(.cmd) at their root
  const nsisDir = (make.env && make.env.NSISDIR) || path.dirname(make.path);
  const pluginsDir = await getNsisPluginsPath(nsisVersion, customResources);

  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(nsisDir, path.join(target, 'nsis'), { recursive: true });
  fs.cpSync(pluginsDir, path.join(target, 'resources', 'plugins'), { recursive: true });

  const plugins = [
    ...dllsIn(path.join(target, 'nsis')).filter((p) => /[\\/]plugins[\\/]/i.test(p)),
    ...dllsIn(path.join(target, 'resources')),
  ];
  console.log(`NSIS from ${nsisDir}`);
  console.log(`NSIS resources from ${pluginsDir}`);
  console.log('DLLS');
  plugins.forEach((p) => console.log(p));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
