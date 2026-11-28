// The hardware of this PC for the model picker (StarkLLM 2.7): memory, graphics cards with their video memory, the
// processor and the free disk space where Ollama keeps its models. Detected at every start and written to
// <data>/hardware.json, where the engine reads it (backend/app/services/model_fit.py): the engine in Docker cannot see
// the PC's graphics card itself.
//
// Graphics cards:
// - NVIDIA through nvidia-smi (name, total and free video memory).
// - every other card (AMD, Intel) from the display adapters in the registry: the name (DriverDesc) and the video
//   memory the driver reports (HardwareInformation.qwMemorySize, or the older 32-bit MemorySize). No PowerShell
//   window, no admin rights (reg.exe reads HKLM).
// - integrated graphics (AMD Radeon 780M, Intel Iris/Arc 140V ...) share the PC's memory: they count only when Ollama
//   uses them (igpu.js), with the share of the memory the model choice allows them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const integratedGpu = require('./igpu');

const GIB = 1024 ** 3;
const DISPLAY_CLASS = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
const NOT_A_GPU = /basic (display|render)|remote|virtual|mirror|parsec|citrix|hyper-v|indirect display|spacedesk|displaylink/i;

const vendorOf = (name) => (/nvidia|geforce|quadro|rtx|tesla/i.test(name) ? 'NVIDIA'
  : /\bamd\b|radeon|ati\b/i.test(name) ? 'AMD' : /intel/i.test(name) ? 'Intel' : '');

// Integrated graphics by name; a card with less than 2 GB of its own memory counts as integrated too.
function isIntegrated(name, vram) {
  if (/intel/i.test(name) && !/arc(\(tm\))?\s*[ab]\d{3}/i.test(name)) return true; // Arc A770 / B580 are cards
  if (/radeon(\(tm\))?\s+graphics|radeon\s+\d{3,4}m\b|vega\s*\d+\s*graphics/i.test(name)) return true;
  return vendorOf(name) !== 'NVIDIA' && vram > 0 && vram < 2 * GIB;
}

// `nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits` (MiB)
function parseNvidiaSmi(lines) {
  const gpus = [];
  for (const line of lines || []) {
    const parts = String(line).split(',').map((s) => s.trim());
    if (parts.length < 3) continue;
    const total = parseInt(parts[1], 10);
    const free = parseInt(parts[2], 10);
    if (!Number.isFinite(total)) continue;
    gpus.push({ name: parts[0], vendor: 'NVIDIA', kind: 'discrete', vram_total: total * 1024 * 1024, vram_free: Number.isFinite(free) ? free * 1024 * 1024 : null });
  }
  return gpus;
}

// Lines of `reg query <display class> /s /v <value>`: { '<full key path>': { type, value } }
function parseRegQuery(lines, valueName) {
  const out = {};
  let key = null;
  for (const raw of lines || []) {
    const line = String(raw);
    if (/^HKEY_/i.test(line.trim())) { key = line.trim().toUpperCase(); continue; }
    const m = line.trim().match(/^(\S+)\s+(REG_\w+)\s+(.*)$/);
    if (key && m && m[1].toLowerCase() === valueName.toLowerCase()) out[key] = { type: m[2], value: m[3].trim() };
  }
  return out;
}

// REG_QWORD 0x400000000, REG_DWORD 0x80000000, REG_BINARY 00000080 (little endian)
function regNumber(entry) {
  if (!entry) return 0;
  if (entry.type === 'REG_BINARY') {
    const bytes = entry.value.replace(/\s+/g, '').match(/../g) || [];
    return bytes.reverse().reduce((n, b) => n * 256 + parseInt(b, 16), 0);
  }
  const n = Number(entry.value.startsWith('0x') ? BigInt(entry.value) : entry.value);
  return Number.isFinite(n) ? n : 0;
}

// Display adapters from the registry outputs: [{ name, vendor, kind, vram_total }]
function parseDisplayAdapters({ desc = [], qw = [], dw = [] } = {}) {
  const names = parseRegQuery(desc, 'DriverDesc');
  const qwords = parseRegQuery(qw, 'HardwareInformation.qwMemorySize');
  const dwords = parseRegQuery(dw, 'HardwareInformation.MemorySize');
  const seen = new Set();
  const gpus = [];
  for (const [key, entry] of Object.entries(names)) {
    const name = entry.value;
    if (!name || NOT_A_GPU.test(name) || seen.has(name)) continue;
    seen.add(name);
    const vram = regNumber(qwords[key]) || regNumber(dwords[key]);
    gpus.push({ name, vendor: vendorOf(name), kind: isIntegrated(name, vram) ? 'integrated' : 'discrete', vram_total: vram, vram_free: null });
  }
  return gpus;
}

// Free disk space where Ollama keeps its models (OLLAMA_MODELS, else %USERPROFILE%\.ollama\models), or null.
function modelsDiskFree({ env = process.env, home = os.homedir(), statfs = fs.statfsSync } = {}) {
  let dir = env.OLLAMA_MODELS || path.join(home, '.ollama', 'models');
  for (let i = 0; i < 10; i++) {
    try {
      const s = statfs(dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch (e) {
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up; // not created yet: the drive it will be on
    }
  }
  return null;
}

/**
 * deps.run(cmd, args, opts) -> { code, lines }; deps.integrated: { name, totalBytes } Ollama uses (igpu.js) or null.
 * Returns { source, detected_at, ram_total, ram_free, cpu: { name, cores }, gpus: [...], disk_free }.
 */
async function detectHardware({ run, integrated = null, platform = process.platform, env = process.env, osmod = os, statfs, now = () => new Date() } = {}) {
  const ramTotal = osmod.totalmem();
  const cpus = osmod.cpus() || [];
  const hw = {
    source: 'desktop',
    detected_at: now().toISOString(),
    ram_total: ramTotal,
    ram_free: osmod.freemem(),
    cpu: { name: ((cpus[0] && cpus[0].model) || '').trim(), cores: cpus.length || null },
    gpus: [],
    disk_free: modelsDiskFree({ env, home: osmod.homedir(), statfs }),
  };
  const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'], { timeoutMs: 8000 });
  if (smi.code === 0) hw.gpus.push(...parseNvidiaSmi(smi.lines));
  if (platform === 'win32') {
    const query = (value) => run('reg', ['query', DISPLAY_CLASS, '/s', '/v', value], { timeoutMs: 8000 }).then((r) => r.lines || [], () => []);
    const [desc, qw, dw] = [await query('DriverDesc'), await query('HardwareInformation.qwMemorySize'), await query('HardwareInformation.MemorySize')];
    for (const g of parseDisplayAdapters({ desc, qw, dw })) {
      if (g.vendor === 'NVIDIA' && hw.gpus.some((n) => n.vendor === 'NVIDIA')) continue; // nvidia-smi knows better
      if (g.kind === 'integrated') g.vram_total = 0; // counts only when Ollama uses it (below)
      hw.gpus.push(g);
    }
  }
  if (integrated) {
    const usable = integratedGpu.videoMemoryFor(integrated, ramTotal);
    const known = hw.gpus.find((g) => g.kind === 'integrated');
    if (known) Object.assign(known, { vram_total: usable });
    else hw.gpus.push({ name: integrated.name, vendor: vendorOf(integrated.name), kind: 'integrated', vram_total: usable, vram_free: null });
  }
  return hw;
}

// What the older model choice (models.js) needs: the memory and the video memory the models can use.
function forModelChoice(hw) {
  const cards = hw.gpus.filter((g) => g.kind !== 'integrated').map((g) => g.vram_total);
  const igpu = hw.gpus.filter((g) => g.kind === 'integrated').map((g) => g.vram_total);
  return { ramBytes: hw.ram_total, vramBytes: Math.max(0, ...cards) || Math.max(0, ...igpu) };
}

function writeHardwareFile(dataDir, hw) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'hardware.json'), JSON.stringify(hw, null, 2));
}

module.exports = { detectHardware, parseNvidiaSmi, parseDisplayAdapters, parseRegQuery, regNumber, isIntegrated, modelsDiskFree, forModelChoice, writeHardwareFile, DISPLAY_CLASS };
