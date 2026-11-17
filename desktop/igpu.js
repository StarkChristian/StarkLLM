// Integrated graphics for the AI models (roadmap phase 1: Ollama on PCs without an NVIDIA card).
//
// Ollama 0.40 finds integrated graphics (AMD Radeon 780M, Intel Arc/Iris) through Vulkan, but leaves them out unless
// OLLAMA_IGPU_ENABLE=1 is set. Its server.log then says
//   msg="dropping integrated GPU; to enable, set OLLAMA_IGPU_ENABLE=1" ... description="AMD Radeon 780M Graphics"
// Measured on a Radeon 780M (17 Nov 2026, qwen2.5:3b, 24 GB RAM, Ollama 0.40.16): a 2,565-token document prompt at
// 545 tokens/s instead of 151 on the processor, answers at 33 instead of 22 tokens/s (5 s instead of 19 s in all).
//
// Owner decision (17 Nov 2026): turned on automatically, the user is told once, the tray menu turns it off.
// StarkLLM sets the variable for the Windows user (HKCU\Environment), so Ollama also uses the graphics when it starts
// with Windows, and restarts Ollama once to apply it, only while no model is loaded. A variable the user set
// themselves is never removed.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const VAR = 'OLLAMA_IGPU_ENABLE';
const SETTING = 'integratedGpu'; // in settings.json: { mode: 'auto' | 'off', setByStarkLLM, name }

// the part of server.log written by the last start of the Ollama server
function lastStart(text) {
  const s = String(text || '');
  const i = s.lastIndexOf('msg="server config"');
  return i >= 0 ? s.slice(i) : s;
}
const description = (line) => (line.match(/description="([^"]+)"/) || [])[1] || '';

// The name of integrated graphics Ollama found but left out at its last start, or null.
function droppedIntegratedGpu(logText) {
  const line = lastStart(logText).split(/\r?\n/).find((l) => l.includes('dropping integrated GPU'));
  return line ? (description(line) || 'integrated graphics') : null;
}

// { name, totalBytes } of integrated graphics Ollama uses since its last start, or null.
function usedIntegratedGpu(logText) {
  const line = lastStart(logText).split(/\r?\n/).find((l) => l.includes('msg="inference compute"') && /\btype=iGPU\b/.test(l));
  if (!line) return null;
  const total = line.match(/total="([\d.]+) GiB"/);
  return { name: description(line) || 'integrated graphics', totalBytes: total ? Math.round(parseFloat(total[1]) * 1024 ** 3) : 0 };
}

// Integrated graphics share the PC's memory: the model choice counts at most 40 % of the RAM as video memory
// (Ollama reports most of the RAM as available to them, 19.9 GiB of 24 GB on the 780M).
function videoMemoryFor(used, ramBytes) {
  if (!used || !used.totalBytes) return 0;
  return Math.min(used.totalBytes, Math.floor((ramBytes || 0) * 0.4));
}

function readSetting(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))[SETTING] || {};
    return { mode: s.mode === 'off' ? 'off' : 'auto', setByStarkLLM: Boolean(s.setByStarkLLM), name: s.name || '' };
  } catch (e) {
    return { mode: 'auto', setByStarkLLM: false, name: '' };
  }
}

function writeSetting(file, patch) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { /* new file */ }
  all[SETTING] = { ...readSetting(file), ...patch };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
  return all[SETTING];
}

// The variable for the Windows user, with reg.exe (no PowerShell window, no admin rights needed)
const userVar = {
  read() {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', VAR], { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = out.match(new RegExp(`${VAR}\\s+REG_\\w+\\s+(.*)`));
      return m ? m[1].trim() : null;
    } catch (e) {
      return null; // not set
    }
  },
  write(value) {
    const args = value == null ? ['delete', 'HKCU\\Environment', '/v', VAR, '/f'] : ['add', 'HKCU\\Environment', '/v', VAR, '/t', 'REG_SZ', '/d', value, '/f'];
    execFileSync('reg', args, { windowsHide: true, stdio: 'ignore' });
  }
};

// Called at every start once Ollama answers. deps:
//   settingsFile, readLog() -> server.log text, loadedModels() -> number, restartOllama() -> true when back,
//   reg (userVar), env (process.env, the Ollama app StarkLLM starts inherits it), log
// Returns { used } (graphics in use, for the model choice) and turnedOn (name) when it was switched on now.
async function applyIntegratedGpu({ settingsFile, readLog, loadedModels, restartOllama, reg = userVar, env = process.env, log = () => {} }) {
  const s = readSetting(settingsFile);
  const current = reg.read();
  if (s.mode === 'off') {
    if (current === '1' && s.setByStarkLLM) {
      if ((await loadedModels()) > 0) { log('integrated graphics: turning off waits, a model is loaded'); return { used: usedIntegratedGpu(readLog()) }; }
      reg.write(null);
      delete env[VAR];
      writeSetting(settingsFile, { setByStarkLLM: false });
      await restartOllama();
      log('integrated graphics: turned off (tray menu), Ollama restarted');
    }
    return { used: usedIntegratedGpu(readLog()) };
  }
  const dropped = droppedIntegratedGpu(readLog());
  if (!dropped) {
    const used = usedIntegratedGpu(readLog());
    if (used && !s.name) writeSetting(settingsFile, { name: used.name });
    return { used };
  }
  if ((await loadedModels()) > 0) {
    log(`integrated graphics: ${dropped} left out by Ollama; turning it on waits, a model is loaded`);
    return { used: null };
  }
  if (current !== '1') {
    reg.write('1');
    writeSetting(settingsFile, { setByStarkLLM: true });
  }
  env[VAR] = '1';
  writeSetting(settingsFile, { name: dropped });
  log(`integrated graphics: ${dropped} left out by Ollama; turning it on (${VAR}=1) and restarting Ollama`);
  if (!(await restartOllama())) {
    log('integrated graphics: Ollama did not come back after the restart');
    return { used: null };
  }
  const used = usedIntegratedGpu(readLog());
  log(used ? `integrated graphics: Ollama uses ${used.name}` : 'integrated graphics: Ollama still does not use them');
  return { used, turnedOn: used ? used.name : null };
}

module.exports = { VAR, SETTING, lastStart, droppedIntegratedGpu, usedIntegratedGpu, videoMemoryFor, readSetting, writeSetting, userVar, applyIntegratedGpu };
