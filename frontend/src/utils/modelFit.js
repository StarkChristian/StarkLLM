// The model picker (StarkLLM 2.7): the parts without texts, so they can be tested with node --test.
// The engine judges whether a model fits this PC (backend/app/services/model_fit.py: fit "good" | "tight" | "no" with a
// reason code and the numbers); modelFitText.js turns that into one sentence in the user's language.

const GIB = 1024 ** 3;

/** Memory as Windows and the card makers show it: 12 GB for 12 GiB; one decimal below 10 GB. */
export function memoryText(bytes) {
  const gb = Math.max(0, Number(bytes) || 0) / GIB;
  if (gb >= 10) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${(Math.round(gb * 10) / 10).toString()} GB`;
  return `${Math.max(1, Math.round(gb * 1024))} MB`;
}

/** A download or file size in decimal units, as Ollama shows it: 5.2 GB, 274 MB. */
export function sizeText(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(n / 1e6))} MB`;
}

const FIT_ORDER = { good: 0, tight: 1, no: 2 };

/** The Model Hub list: the models recommended for this PC first (chat, then images), then by fit, else as listed. */
export function sortForThisPc(models) {
  const rank = (m) => (m.recommended === 'text' ? 0 : m.recommended === 'vision' ? 1 : 2);
  return models
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m) - rank(b.m)
      || (FIT_ORDER[a.m.fit?.fit] ?? 1) - (FIT_ORDER[b.m.fit?.fit] ?? 1)
      || a.i - b.i)
    .map((x) => x.m);
}

/** 42 -> { unit: 's', n: 42 }; from 2 minutes on rounded up to whole minutes; from an hour on hours and minutes. */
export function durationParts(seconds) {
  const s = Math.max(1, Math.round(seconds));
  if (s < 120) return { unit: 's', n: s };
  const minutes = Math.ceil(s / 60);
  if (minutes < 60) return { unit: 'min', n: minutes };
  return { unit: 'h', h: Math.floor(minutes / 60), m: minutes % 60 };
}

export const SPEED_WARMUP_MS = 3000;

/**
 * Follows the progress lines of an Ollama download ({ digest, total, completed } per file of the model) and measures
 * the speed from the download itself: no extra request to test the speed. The time left is known only after the
 * first seconds (warmupMs); until then only the size is shown. Bytes already on the PC when a download is resumed
 * do not count as speed.
 */
export function createDownloadTracker({ warmupMs = SPEED_WARMUP_MS } = {}) {
  const files = new Map();
  let start = null;
  let last = null;
  const totals = () => {
    let total = 0;
    let completed = 0;
    for (const f of files.values()) {
      total += f.total;
      completed += f.completed;
    }
    return { total, completed };
  };
  return {
    feed(msg, now = Date.now()) {
      if (!msg || !msg.digest || !(msg.total > 0)) return false;
      files.set(msg.digest, { total: msg.total, completed: Math.min(msg.completed || 0, msg.total) });
      const { total, completed } = totals();
      if (!start) start = { at: now, bytes: completed };
      last = { at: now, bytes: completed, total };
      return true;
    },
    state() {
      const { total, completed } = totals();
      let secondsLeft = null;
      if (start && last && last.at - start.at >= warmupMs && last.bytes > start.bytes) {
        const speed = (last.bytes - start.bytes) / ((last.at - start.at) / 1000);
        secondsLeft = Math.max(0, Math.round((total - completed) / speed));
      }
      return { total, completed, percent: total > 0 ? Math.floor((completed / total) * 100) : 0, secondsLeft };
    },
  };
}

/** Name of the graphics card the fit is judged by, or '' (the engine's hardware: gpus with kind and vram_total). */
export function mainGraphics(hw) {
  const gpus = (hw && hw.gpus) || [];
  const cards = gpus.filter((g) => g.kind !== 'integrated' && g.vram_total > 0);
  const pick = cards.length ? cards : gpus.filter((g) => g.vram_total > 0);
  return pick.reduce((best, g) => (!best || g.vram_total > best.vram_total ? g : best), null);
}
