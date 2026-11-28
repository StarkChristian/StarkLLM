// The runtimes StarkLLM brings for connections, so the user installs nothing (docs/connections.md):
//  * uv (Astral) installs Python servers into StarkLLM's own folder, with a Python that uv manages there;
//  * Node.js (with npm) installs and runs Node servers.
// Both are put into the installer by build/fetch-runtimes.js (pinned versions, SHA-256 checked) under resources/runtime.
// This module only builds the commands; connections.js runs them through the network layer. No Electron here.
const fs = require('fs');
const path = require('path');

// where the package downloads go: shown in docs/privacy-network.md, announced to netguard before each step
const HOSTS = {
  npm: 'https://registry.npmjs.org/',
  pypi: 'https://pypi.org/simple/',
  python: 'https://github.com/astral-sh/python-build-standalone/releases',
};

function runtimePaths({ resourcesPath, userData, platform = process.platform }) {
  const exe = platform === 'win32' ? '.exe' : '';
  const rt = path.join(resourcesPath || '', 'runtime');
  const base = path.join(userData, 'connections');
  return {
    platform,
    exe,
    uv: path.join(rt, 'uv', `uv${exe}`),
    node: platform === 'win32' ? path.join(rt, 'node', 'node.exe') : path.join(rt, 'node', 'bin', 'node'),
    npmCli: platform === 'win32' ? path.join(rt, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js') : path.join(rt, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    base,
    uvTools: path.join(base, 'uv', 'tools'),
    uvBin: path.join(base, 'uv', 'bin'),
    uvPython: path.join(base, 'uv', 'python'),
    uvCache: path.join(base, 'uv', 'cache'),
    npmRoot: path.join(base, 'npm'),
    npmCache: path.join(base, 'npm-cache'),
    mcpb: path.join(base, 'mcpb'),
  };
}

// uv works only inside StarkLLM's folder: its own tools, Python and cache; the user's uv settings are not read
function uvEnv(p) {
  return {
    UV_TOOL_DIR: p.uvTools,
    UV_TOOL_BIN_DIR: p.uvBin,
    UV_PYTHON_INSTALL_DIR: p.uvPython,
    UV_CACHE_DIR: p.uvCache,
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_NO_CONFIG: '1',
    UV_NO_PROGRESS: '1',
  };
}

function npmEnv(p) {
  return {
    npm_config_cache: p.npmCache,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_registry: HOSTS.npm,
    npm_config_userconfig: path.join(p.base, 'npmrc-none'),
  };
}

const npmDir = (p, entryId) => path.join(p.npmRoot, entryId);

// The steps that install a catalog entry: [{ command, args, env, host, purpose, capture? }]
// host: the address the step downloads from (announced to netguard; refused while fully offline).
function installSteps(entry, p) {
  const pkg = entry.package || {};
  const steps = [];
  if (pkg.runtime === 'uv') {
    const spec = `${pkg.name}==${pkg.version}`;
    steps.push({ command: p.uv, args: ['python', 'install', pkg.python], env: uvEnv(p), host: HOSTS.python, purpose: `Python ${pkg.python} for ${entry.id}` });
    steps.push({ command: p.uv, args: ['tool', 'install', '--force', '--python', pkg.python, spec], env: uvEnv(p), host: HOSTS.pypi, purpose: spec });
  } else if (pkg.runtime === 'npm') {
    const spec = `${pkg.name}@${pkg.version}`;
    if (pkg.python) {
      steps.push({ command: p.uv, args: ['python', 'install', pkg.python], env: uvEnv(p), host: HOSTS.python, purpose: `Python ${pkg.python} for ${entry.id}` });
      steps.push({ command: p.uv, args: ['python', 'find', pkg.python], env: uvEnv(p), capture: 'python' });
    }
    // --ignore-scripts: no install script of the package (or of its dependencies) runs
    steps.push({ command: p.node, args: [p.npmCli, 'install', '--prefix', npmDir(p, entry.id), '--no-audit', '--no-fund', '--ignore-scripts', '--omit=dev', '--no-save', spec], env: npmEnv(p), host: HOSTS.npm, purpose: spec });
  }
  return steps;
}

// the program a stdio entry starts (after installation): { command, args } before the entry's own arguments
function launchCommand(entry, p, { electronPath = process.execPath, connectorsDir = path.join(__dirname, 'connectors') } = {}) {
  const pkg = entry.package || {};
  if (pkg.runtime === 'uv') return { command: path.join(p.uvBin, `${pkg.bin}${p.exe}`), args: [] };
  if (pkg.runtime === 'npm') return { command: p.node, args: [npmBinPath(npmDir(p, entry.id), pkg.name, pkg.bin)] };
  if (pkg.runtime === 'builtin') {
    // Electron as Node (ELECTRON_RUN_AS_NODE): the connector is unpacked next to app.asar (package.json asarUnpack)
    const script = path.join(connectorsDir, pkg.script).replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
    return { command: electronPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return null;
}

// <prefix>/node_modules/<name>/<the file of its "bin" entry>; the path must stay inside the package
function npmBinPath(prefix, name, bin) {
  const dir = path.join(prefix, 'node_modules', ...name.split('/'));
  let rel = '';
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    rel = typeof pj.bin === 'string' ? pj.bin : (pj.bin && (pj.bin[bin] || Object.values(pj.bin)[0])) || '';
  } catch (e) {
    return path.join(dir, 'package.json.missing');
  }
  const full = path.resolve(dir, rel);
  if (!full.startsWith(path.resolve(dir) + path.sep)) throw new Error('the package points outside its folder');
  return full;
}

// after installation: the setup commands of the entry (the Blender add-on, the GIMP plug-in ...)
function setupSteps(entry, p, extraEnv = {}) {
  const launch = launchCommand(entry, p);
  if (!launch) return [];
  const pkg = entry.package || {};
  // a setup that downloads packages itself (DaVinci Resolve's helper builds its Python environment from PyPI)
  const host = pkg.setupDownloads === 'pypi' ? HOSTS.pypi : '';
  return (pkg.setup || []).map((a) => ({ command: launch.command, args: [...launch.args, ...a], setupArgs: a, env: { ...(launch.env || {}), ...extraEnv }, host, purpose: `setup of ${entry.id}` }));
}

function uninstallSteps(entry, p) {
  const pkg = entry.package || {};
  if (pkg.runtime === 'uv') return [{ command: p.uv, args: ['tool', 'uninstall', pkg.name.replace(/\[.*\]$/, '')], env: uvEnv(p) }];
  return [];
}

module.exports = { HOSTS, runtimePaths, uvEnv, npmEnv, installSteps, launchCommand, npmBinPath, setupSteps, uninstallSteps, npmDir };
