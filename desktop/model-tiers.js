// One recommended chat model and image model per hardware tier (StarkLLM 2.7, model picker). The tiers are in one
// data file, backend/app/core/model_tiers.json, which the engine uses for the Model Hub and the desktop app uses at the
// first start; it ships with the engine files (package.json, extraResources "app/**/*"). Same rule as
// backend/app/services/model_fit.py choose_tier: the highest tier the PC reaches, by the video memory of a graphics
// card of its own, else by the memory (integrated graphics share the memory and count as the processor tier).
const fs = require('fs');
const path = require('path');

const GIB = 1024 ** 3;

const tiersFile = (engineDir) => path.join(engineDir, 'backend', 'app', 'core', 'model_tiers.json');

// The tiers, or null when the file is missing or broken (the start then keeps the older default models).
function loadTiers(file) {
  try {
    const tiers = JSON.parse(fs.readFileSync(file, 'utf8')).tiers;
    return Array.isArray(tiers) && tiers.length && tiers.every((t) => t.id && t.text && t.vision) ? tiers : null;
  } catch (e) {
    return null;
  }
}

function graphicsCard(hw) {
  const cards = (hw.gpus || []).filter((g) => g.kind !== 'integrated' && g.vram_total > 0);
  return cards.length ? cards.reduce((a, b) => (b.vram_total > a.vram_total ? b : a)) : null;
}

function chooseTier(hw, tiers) {
  if (!tiers || !tiers.length) return null;
  const card = graphicsCard(hw || {});
  const vramGb = card ? card.vram_total / GIB : 0;
  const ramGb = ((hw && hw.ram_total) || 0) / GIB;
  let reached = tiers.filter((t) => (t.kind === 'gpu' && card && vramGb >= (t.gpu_gb || 0)) || (t.kind === 'cpu' && ramGb >= (t.ram_gb || 0)));
  if (!reached.length) reached = tiers.filter((t) => t.kind === 'cpu');
  if (!reached.length) reached = tiers.slice(0, 1);
  const rank = (t) => [t.kind === 'gpu' ? 1 : 0, t.gpu_gb || 0, t.ram_gb || 0];
  return reached.reduce((best, t) => {
    const a = rank(best);
    const b = rank(t);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i] > a[i] ? t : best;
    return best;
  });
}

module.exports = { tiersFile, loadTiers, chooseTier, graphicsCard };
