// The model picker (StarkLLM 2.7): hardware detection, the hardware tiers and the first start on a new PC, with fake
// hardware profiles (no graphics card, integrated graphics, 8/12/16/24 GB cards from NVIDIA and AMD).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const hardware = require('../hardware');
const tiers = require('../model-tiers');
const { chooseModels } = require('../models');
const { createSpeedMeter, durationParts } = require('../progress');

const GIB = 1024 ** 3;
const TIERS = tiers.loadTiers(tiers.tiersFile(path.join(__dirname, '..', '..')));

const profile = (ramGb, gpus = []) => ({ ram_total: ramGb * GIB, ram_free: ramGb * GIB / 2, cpu: { name: 'cpu', cores: 8 }, gpus, disk_free: 500e9 });
const card = (gb, vendor = 'NVIDIA') => ({ name: `${vendor} card`, vendor, kind: 'discrete', vram_total: gb * GIB, vram_free: null });
const igpu = (gb) => ({ name: 'AMD Radeon 780M Graphics', vendor: 'AMD', kind: 'integrated', vram_total: gb * GIB, vram_free: null });

// ------------------------------------------------------------------ tiers

test('the tiers come from the one data file of the engine', () => {
  assert.ok(TIERS, 'backend/app/core/model_tiers.json was not found');
  assert.deepStrictEqual(TIERS.map((t) => t.id), ['cpu', 'gpu_8', 'gpu_12', 'gpu_24']);
  assert.ok(TIERS.every((t) => t.text && t.vision), 'every tier names a chat model and an image model');
});

test('one recommended model per hardware tier', () => {
  const tier = (hw) => tiers.chooseTier(hw, TIERS).id;
  assert.strictEqual(tier(profile(8)), 'cpu');
  assert.strictEqual(tier(profile(16)), 'cpu');
  assert.strictEqual(tier(profile(24, [igpu(9.6)])), 'cpu'); // integrated graphics share the memory
  assert.strictEqual(tier(profile(16, [card(8)])), 'gpu_8');
  assert.strictEqual(tier(profile(32, [card(12)])), 'gpu_12');
  assert.strictEqual(tier(profile(32, [card(16, 'AMD')])), 'gpu_12');
  assert.strictEqual(tier(profile(64, [card(24)])), 'gpu_24');
  assert.strictEqual(tier(profile(64, [igpu(2), card(4), card(24)])), 'gpu_24'); // the largest card counts
  assert.strictEqual(tier(profile(16, [card(4)])), 'cpu'); // too small a card: the processor tier
});

test('the desktop app and the engine pick the same sizes as the plan', () => {
  const params = (name) => parseFloat(name.split(':')[1]);
  assert.ok(params(tiers.chooseTier(profile(16), TIERS).text) <= 4);
  assert.ok(params(tiers.chooseTier(profile(16, [card(8)]), TIERS).text) <= 4);
  const mid = params(tiers.chooseTier(profile(32, [card(12)]), TIERS).text);
  assert.ok(mid >= 7 && mid <= 9);
  const big = params(tiers.chooseTier(profile(64, [card(24)]), TIERS).text);
  assert.ok(big >= 14 && big <= 27);
});

test('a missing or broken tier file keeps the older defaults', () => {
  assert.strictEqual(tiers.loadTiers(path.join(__dirname, 'no-such-file.json')), null);
  assert.strictEqual(tiers.chooseTier(profile(16), null), null);
  const c = chooseModels({ installed: [], hw: { ramBytes: 16 * GIB }, recommended: null });
  assert.strictEqual(c.text, 'qwen2.5:7b');
  assert.strictEqual(c.recommendedText, false);
});

// ------------------------------------------------------------------ first start

test('on a new PC the recommended model of its tier is preselected and downloaded', () => {
  const hw = profile(32, [card(12)]);
  const tier = tiers.chooseTier(hw, TIERS);
  const c = chooseModels({ installed: [], hw: hardware.forModelChoice(hw), recommended: tier });
  assert.strictEqual(c.text, 'qwen3:8b');
  assert.strictEqual(c.vision, 'qwen2.5vl:7b'); // downloaded with the first image, not now
  assert.deepStrictEqual(c.pull, ['nomic-embed-text', 'qwen3:8b']);
  assert.strictEqual(c.recommendedText, true);
});

test('a PC without a graphics card gets a small model', () => {
  const hw = profile(16);
  const c = chooseModels({ installed: [], hw: hardware.forModelChoice(hw), recommended: tiers.chooseTier(hw, TIERS) });
  assert.strictEqual(c.text, 'qwen3:4b');
  assert.strictEqual(c.vision, 'gemma3:4b');
});

test('a suitable installed model still wins over the recommendation', () => {
  const installed = [{ name: 'qwen3:14b', size: 9.3e9, family: 'qwen3', parameterSize: '14.8B', capabilities: ['completion'] }];
  const hw = profile(64, [card(24)]);
  const c = chooseModels({ installed, hw: hardware.forModelChoice(hw), recommended: tiers.chooseTier(hw, TIERS) });
  assert.strictEqual(c.text, 'qwen3:14b');
  assert.strictEqual(c.recommendedText, false);
});

// ------------------------------------------------------------------ hardware detection

const REG_DESC = [
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0000',
  '    DriverDesc    REG_SZ    AMD Radeon RX 7800 XT',
  '',
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0001',
  '    DriverDesc    REG_SZ    AMD Radeon(TM) Graphics',
  '',
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0002',
  '    DriverDesc    REG_SZ    Microsoft Basic Display Adapter',
  '',
  'End of search: 3 match(es) found.',
];
const REG_QW = [
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0000',
  '    HardwareInformation.qwMemorySize    REG_QWORD    0x400000000',
  'End of search: 1 match(es) found.',
];
const REG_DW = [
  'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0001',
  '    HardwareInformation.MemorySize    REG_BINARY    00000020',
  'End of search: 1 match(es) found.',
];

test('AMD and Intel cards are read from the display adapters in the registry', () => {
  const gpus = hardware.parseDisplayAdapters({ desc: REG_DESC, qw: REG_QW, dw: REG_DW });
  assert.deepStrictEqual(gpus.map((g) => [g.name, g.vendor, g.kind, g.vram_total]), [
    ['AMD Radeon RX 7800 XT', 'AMD', 'discrete', 16 * GIB],
    ['AMD Radeon(TM) Graphics', 'AMD', 'integrated', 512 * 1024 * 1024],
  ]);
});

test('integrated graphics are told apart from cards by name and memory', () => {
  assert.ok(hardware.isIntegrated('Intel(R) Iris(R) Xe Graphics', 128 * 1024 * 1024));
  assert.ok(hardware.isIntegrated('Intel(R) Arc(TM) 140V GPU', 0));
  assert.ok(!hardware.isIntegrated('Intel(R) Arc(TM) A770 Graphics', 16 * GIB));
  assert.ok(hardware.isIntegrated('AMD Radeon 890M Graphics', 512 * 1024 * 1024));
  assert.ok(!hardware.isIntegrated('NVIDIA GeForce RTX 4060 Laptop GPU', 8 * GIB));
});

const fakeOs = (ramGb) => ({ totalmem: () => ramGb * GIB, freemem: () => ramGb * GIB / 2, cpus: () => Array(16).fill({ model: 'AMD Ryzen 7 7840HS ' }), homedir: () => 'C:\\Users\\x' });
const statfs = () => ({ bavail: 100, bsize: 1e9 });

test('an NVIDIA PC: nvidia-smi gives the card, the registry copy of it is not counted twice', async () => {
  const run = async (cmd, args) => {
    if (cmd === 'nvidia-smi') return { code: 0, lines: ['NVIDIA GeForce RTX 4070, 12282, 11000'] };
    const v = args[args.length - 1];
    if (v === 'DriverDesc') return { code: 0, lines: ['HKEY_LOCAL_MACHINE\\X\\0000', '    DriverDesc    REG_SZ    NVIDIA GeForce RTX 4070', 'HKEY_LOCAL_MACHINE\\X\\0001', '    DriverDesc    REG_SZ    Intel(R) UHD Graphics 770'] };
    return { code: 1, lines: [] };
  };
  const hw = await hardware.detectHardware({ run, platform: 'win32', osmod: fakeOs(32), statfs, env: {}, now: () => new Date('2026-11-28T10:00:00Z') });
  assert.deepStrictEqual(hw.gpus.map((g) => [g.name, g.kind]), [['NVIDIA GeForce RTX 4070', 'discrete'], ['Intel(R) UHD Graphics 770', 'integrated']]);
  assert.strictEqual(hw.gpus[0].vram_total, 12282 * 1024 * 1024);
  assert.strictEqual(hw.gpus[1].vram_total, 0); // Ollama does not use it
  assert.strictEqual(hw.cpu.name, 'AMD Ryzen 7 7840HS');
  assert.strictEqual(hw.cpu.cores, 16);
  assert.strictEqual(hw.disk_free, 100e9);
  assert.strictEqual(hardware.forModelChoice(hw).vramBytes, 12282 * 1024 * 1024);
  assert.strictEqual(tiers.chooseTier(hw, TIERS).id, 'gpu_12');
});

test('integrated graphics Ollama uses count with their share of the memory', async () => {
  const run = async (cmd, args) => (cmd === 'reg' && args[args.length - 1] === 'DriverDesc'
    ? { code: 0, lines: ['HKEY_LOCAL_MACHINE\\X\\0000', '    DriverDesc    REG_SZ    AMD Radeon 780M Graphics'] }
    : { code: 1, lines: [] });
  const hw = await hardware.detectHardware({ run, platform: 'win32', osmod: fakeOs(24), statfs, env: {}, integrated: { name: 'AMD Radeon 780M Graphics', totalBytes: 19.9 * GIB } });
  assert.strictEqual(hw.gpus.length, 1);
  assert.strictEqual(hw.gpus[0].kind, 'integrated');
  assert.strictEqual(hw.gpus[0].vram_total, Math.floor(24 * GIB * 0.4));
  assert.strictEqual(tiers.chooseTier(hw, TIERS).id, 'cpu');
});

test('without nvidia-smi and outside Windows only memory, processor and disk are known', async () => {
  const run = async () => ({ code: -1, lines: [], enoent: true });
  const hw = await hardware.detectHardware({ run, platform: 'linux', osmod: fakeOs(8), statfs: () => { throw new Error('no'); }, env: {} });
  assert.deepStrictEqual(hw.gpus, []);
  assert.strictEqual(hw.ram_total, 8 * GIB);
  assert.strictEqual(hw.disk_free, null);
});

test('the disk space is measured where Ollama will keep the models, also before that folder exists', () => {
  const seen = [];
  const free = hardware.modelsDiskFree({ env: { OLLAMA_MODELS: path.join('D:', 'models', 'ollama') }, home: 'C:', statfs: (dir) => {
    seen.push(dir);
    if (dir !== path.join('D:', 'models')) throw new Error('ENOENT');
    return { bavail: 2, bsize: 4096 };
  } });
  assert.strictEqual(free, 8192);
  assert.strictEqual(seen[0], path.join('D:', 'models', 'ollama'));
});

// ------------------------------------------------------------------ download time

test('the time left is measured from the download itself, only after its first seconds', () => {
  const s = createSpeedMeter();
  s.feed(0, 5e9, 0);
  s.feed(50e6, 5e9, 1000);
  assert.strictEqual(s.bytesPerSecond(), null); // the first seconds: only the size is shown
  assert.strictEqual(s.secondsLeft(), null);
  s.feed(300e6, 5e9, 3000);
  assert.strictEqual(s.bytesPerSecond(), 100e6);
  assert.strictEqual(s.secondsLeft(), 47);
});

test('a resumed download does not count the bytes it already had as speed', () => {
  const s = createSpeedMeter();
  s.feed(4e9, 5e9, 0);
  s.feed(4.1e9, 5e9, 4000);
  assert.strictEqual(s.bytesPerSecond(), 25e6);
  assert.strictEqual(s.secondsLeft(), 36);
});

test('durations read naturally', () => {
  assert.deepStrictEqual(durationParts(42), { key: '{n} s', values: { n: 42 } });
  assert.deepStrictEqual(durationParts(150), { key: '{n} min', values: { n: 3 } });
  assert.deepStrictEqual(durationParts(3 * 3600 + 120), { key: '{h} h {m} min', values: { h: 3, m: 2 } });
});
