// Chooses the AI models from what is already installed in Ollama, so the first start downloads only what is
// missing. Found on a real Windows PC (8 Nov 2026): qwen3:14b, a Qwen 3.5 model and qwen3-embedding were
// installed, but the app downloaded qwen2.5:7b and llava (about 9 GB) because it only looked for exact names.

const DEFAULTS = { text: 'qwen2.5:7b', embedding: 'nomic-embed-text', vision: 'llava' };

// Higher is better. Matched against the model name and its Ollama family, first match wins.
const TEXT_RANK = [
  [/qwen3\.5|qwen35/, 90],
  [/qwen3(?!-?embed)/, 80],
  [/gemma4/, 78],
  [/gemma3/, 70],
  [/llama3\.3|llama4/, 68],
  [/mistral-small|mistral-nemo|ministral/, 62],
  [/llama3\.[12]|llama3(?!\.)/, 60],
  [/phi4/, 58],
  [/qwen2\.5/, 55],
  [/mistral/, 50],
  [/deepseek-r1/, 50],
];
const EMBED_RANK = [
  [/qwen3-?embed/, 90],
  [/bge-m3/, 85],
  [/embeddinggemma/, 80],
  [/snowflake-arctic-embed2/, 75],
  [/mxbai-embed/, 65],
  [/nomic-embed/, 60],
];
const VISION_RANK = [
  [/qwen3\.5|qwen35/, 90],
  [/qwen3-?vl/, 88],
  [/qwen2\.5-?vl|qwen2\.5vl/, 80],
  [/minicpm-v/, 78],
  [/gemma4|gemma3/, 75],
  [/llama3\.2-vision|llama4/, 65],
  [/llava/, 40],
];

const rank = (table, m) => {
  const key = `${m.name} ${m.family || ''}`.toLowerCase();
  for (const [re, score] of table) if (re.test(key)) return score;
  return 10;
};

// Ollama ":cloud" models run on Ollama's servers, not on this PC.
const isCloud = (m) => /(^|[:-])cloud(\b|$)/i.test(m.name) || /-cloud$/i.test(m.name.split(':')[1] || '');
const isEmbedding = (m) => (m.capabilities || []).includes('embedding') || /embed|bge-|nomic-bert|bert/i.test(`${m.name} ${m.family || ''}`);
const canChat = (m) => !isEmbedding(m) && (!m.capabilities || m.capabilities.length === 0 || m.capabilities.includes('completion'));
const canSee = (m) => (m.capabilities || []).includes('vision') || /llava|-vl|vl:|vision|minicpm-v/i.test(m.name);

const GB = 1024 ** 3;

// A model fits on the graphics card if its file needs at most 90 % of the video memory; without a usable card it
// must fit in half of the RAM (the rest is for Windows, Docker and the app), and runs slower.
function fit(m, hw) {
  const vram = hw.vramBytes || 0;
  if (vram >= 4 * GB && m.size <= vram * 0.9) return 'gpu';
  if (m.size <= (hw.ramBytes || 8 * GB) * 0.5) return 'ram';
  return null;
}

// Billions of parameters from Ollama's "14.8B" / "751.63M"; without it, estimated from the file size.
const paramsB = (m) => {
  const match = String(m.parameterSize || '').trim().match(/^([0-9.]+)\s*([KMBT])?/i);
  if (!match) return m.size / 1e9;
  const unit = { K: 1e-6, M: 1e-3, B: 1, T: 1e3 }[(match[2] || 'B').toUpperCase()];
  return parseFloat(match[1]) * unit;
};

// Models below 3 billion parameters answer too poorly from documents; they only win when nothing larger fits.
const TINY_B = 3;

function best(candidates, table, hw, { penalizeTiny = false, penalizeVisionOnly = false } = {}) {
  const scored = candidates
    .map((m) => ({ m, where: fit(m, hw) }))
    .filter((x) => x.where)
    .map((x) => ({
      ...x,
      score: (x.where === 'gpu' ? 1000 : 0) + rank(table, x.m) * 10 + Math.min(paramsB(x.m), 40) * 3
        - (penalizeTiny && paramsB(x.m) < TINY_B ? 400 : 0)
        - (penalizeVisionOnly && /vl\b|vl:|-vl|vision|llava/i.test(x.m.name) ? 30 : 0),
    }))
    .sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

/**
 * installed: [{ name, size, family, parameterSize, capabilities }]
 * hw: { ramBytes, vramBytes }
 * saved: the previous choice ({ text, embedding, vision }) or null
 * existingIndex: documents were indexed before (the embedding model must then stay the same)
 * Returns { text, embedding, vision, pull: [names to download now], notes: [lines for the log] }
 */
function chooseModels({ installed = [], hw = {}, saved = null, existingIndex = false }) {
  const local = installed.filter((m) => !isCloud(m));
  const has = (name) => local.some((m) => m.name === name || m.name === `${name}:latest` || `${m.name}:latest` === name);
  const notes = [];
  const pull = [];

  // Search model: fixed once documents exist, because the stored vectors only match the model that made them.
  let embedding;
  if (saved && saved.embedding) {
    embedding = saved.embedding;
  } else if (existingIndex) {
    embedding = DEFAULTS.embedding;
    notes.push(`documents already indexed: keeping the search model ${embedding}`);
  } else {
    const e = best(local.filter(isEmbedding), EMBED_RANK, { ...hw, vramBytes: 0, ramBytes: Math.max(hw.ramBytes || 0, 16 * GB) });
    embedding = e ? e.m.name : DEFAULTS.embedding;
    notes.push(e ? `search model ${embedding} is installed` : `no search model installed: ${embedding} will be downloaded`);
  }
  if (!has(embedding)) pull.push(embedding);

  // Chat model: the previous choice while it is still installed, otherwise the best installed one that fits.
  let text;
  if (saved && saved.text && has(saved.text)) {
    text = saved.text;
  } else {
    const t = best(local.filter(canChat), TEXT_RANK, hw, { penalizeTiny: true, penalizeVisionOnly: true });
    if (t && paramsB(t.m) < TINY_B) notes.push(`installed chat models are small (largest fitting: ${t.m.name})`);
    if (t && paramsB(t.m) >= TINY_B) {
      text = t.m.name;
      notes.push(`chat model ${text} is installed (${t.where === 'gpu' ? 'fits the graphics card' : 'runs on the processor'})`);
    } else {
      text = DEFAULTS.text;
      notes.push(`no suitable chat model installed: ${text} will be downloaded`);
      pull.push(text);
    }
  }

  // Image model: an installed model that can see; otherwise llava, downloaded on the first image (not now).
  let vision;
  if (saved && saved.vision && has(saved.vision)) {
    vision = saved.vision;
  } else {
    const v = best(local.filter(canSee), VISION_RANK, hw);
    vision = v ? v.m.name : DEFAULTS.vision;
    notes.push(v ? `image model ${vision} is installed` : `no image model installed: ${vision} is downloaded with the first image`);
  }

  return { text, embedding, vision, pull, notes };
}

module.exports = { chooseModels, DEFAULTS };
