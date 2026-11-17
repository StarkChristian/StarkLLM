// Integrated graphics (igpu.js): lines from Ollama 0.40.16's server.log on a GEEKOM with a Radeon 780M (17 Nov 2026).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const g = require('../igpu');

const CONFIG = 'time=2026-11-17T17:57:39.931+01:00 level=INFO source=routes.go:2474 msg="server config" env="map[OLLAMA_IGPU_ENABLE: OLLAMA_VULKAN:true]"';
const DROPPED = 'time=2026-11-17T17:57:45.823+01:00 level=INFO source=runner.go:405 msg="dropping integrated GPU; to enable, set OLLAMA_IGPU_ENABLE=1" id=0 library=Vulkan compute=0.0 name=Vulkan0 description="AMD Radeon 780M Graphics" pci_id=""';
const CPU = 'time=2026-11-17T17:57:45.823+01:00 level=INFO source=types.go:50 msg="inference compute" id=cpu library=cpu compute="" name=cpu description=cpu libdirs=ollama driver="" pci_id="" type="" total="23.8 GiB" available="6.2 GiB"';
const USED = 'time=2026-11-17T18:10:11.661+01:00 level=INFO source=types.go:32 msg="inference compute" id=0 filter_id=0 library=Vulkan compute=0.0 name=Vulkan0 description="AMD Radeon 780M Graphics" libdirs=ollama,vulkan driver=0.0 pci_id="" type=iGPU total="19.9 GiB" available="18.9 GiB"';
const GB = 1024 ** 3;

test('reads which integrated graphics Ollama left out or uses, from its last start only', () => {
  const left = [CONFIG, DROPPED, CPU].join('\n');
  assert.equal(g.droppedIntegratedGpu(left), 'AMD Radeon 780M Graphics');
  assert.equal(g.usedIntegratedGpu(left), null);
  const after = [left, CONFIG.replace('IGPU_ENABLE:', 'IGPU_ENABLE:1'), USED].join('\n');
  assert.equal(g.droppedIntegratedGpu(after), null, 'the earlier start does not count');
  assert.deepEqual(g.usedIntegratedGpu(after), { name: 'AMD Radeon 780M Graphics', totalBytes: Math.round(19.9 * GB) });
});

test('integrated graphics count with at most 40 % of the RAM for the model choice', () => {
  assert.equal(g.videoMemoryFor({ totalBytes: 19.9 * GB }, 24 * GB), Math.floor(24 * GB * 0.4));
  assert.equal(g.videoMemoryFor({ totalBytes: 2 * GB }, 24 * GB), 2 * GB);
  assert.equal(g.videoMemoryFor(null, 24 * GB), 0);
});

function setup({ log, loaded = 0, current = null, setting } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starkllm-igpu-'));
  const settingsFile = path.join(dir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ engine: 'native', ...(setting ? { integratedGpu: setting } : {}) }));
  const state = { log, value: current, restarts: 0, env: {}, lines: [] };
  const deps = {
    settingsFile,
    readLog: () => state.log,
    loadedModels: async () => loaded,
    restartOllama: async () => { state.restarts++; state.log = [state.log, CONFIG, state.value === '1' ? USED : DROPPED].join('\n'); return true; },
    reg: { read: () => state.value, write: (v) => { state.value = v; } },
    env: state.env,
    log: (l) => state.lines.push(l)
  };
  return { deps, state, settingsFile };
}

test('left out: turned on once, Ollama restarted, the user is told; the next start changes nothing', async () => {
  const { deps, state, settingsFile } = setup({ log: [CONFIG, DROPPED, CPU].join('\n') });
  const r = await g.applyIntegratedGpu(deps);
  assert.equal(r.turnedOn, 'AMD Radeon 780M Graphics');
  assert.equal(state.value, '1');
  assert.equal(state.env.OLLAMA_IGPU_ENABLE, '1', 'the Ollama app StarkLLM starts inherits it');
  assert.equal(state.restarts, 1);
  assert.deepEqual(g.readSetting(settingsFile), { mode: 'auto', setByStarkLLM: true, name: 'AMD Radeon 780M Graphics' });
  assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).engine, 'native', 'other settings stay');
  const again = await g.applyIntegratedGpu(deps);
  assert.equal(again.turnedOn, undefined);
  assert.equal(again.used.name, 'AMD Radeon 780M Graphics');
  assert.equal(state.restarts, 1);
});

test('nothing is restarted while a model is loaded', async () => {
  const { deps, state } = setup({ log: [CONFIG, DROPPED].join('\n'), loaded: 1 });
  const r = await g.applyIntegratedGpu(deps);
  assert.equal(r.turnedOn, undefined);
  assert.equal(state.restarts, 0);
  assert.equal(state.value, null);
});

test('turned off in the tray menu: StarkLLM removes only its own variable', async () => {
  const ours = setup({ log: [CONFIG, USED].join('\n'), current: '1', setting: { mode: 'off', setByStarkLLM: true, name: 'AMD Radeon 780M Graphics' } });
  await g.applyIntegratedGpu(ours.deps);
  assert.equal(ours.state.value, null);
  assert.equal(ours.state.restarts, 1);
  const theirs = setup({ log: [CONFIG, USED].join('\n'), current: '1', setting: { mode: 'off', setByStarkLLM: false, name: 'x' } });
  await g.applyIntegratedGpu(theirs.deps);
  assert.equal(theirs.state.value, '1', 'a variable the user set is never removed');
  assert.equal(theirs.state.restarts, 0);
});

test('a PC without integrated graphics: nothing happens', async () => {
  const { deps, state } = setup({ log: [CONFIG, CPU].join('\n') });
  const r = await g.applyIntegratedGpu(deps);
  assert.deepEqual(r, { used: null });
  assert.equal(state.restarts, 0);
  assert.equal(state.value, null);
});
