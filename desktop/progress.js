// Overall progress for downloads on the start screen. Found on a real Windows PC (8 Nov 2026): while the engine was
// downloaded, the screen showed one line per image layer ("80db5eaed612 Downloading 44.04MB"), changing many times a
// second, with no total; the progress line was only an animation.

const UNITS = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

// "44.04MB", "512kB", "1.2 GB" -> bytes (Docker prints decimal units)
function parseSize(text) {
  const m = String(text || '').trim().match(/^([0-9.]+)\s*([kKMGT]?B)$/);
  if (!m) return null;
  return parseFloat(m[1]) * UNITS[m[2].toUpperCase()];
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  return Math.max(0, Math.round(bytes / 1e6)) + ' MB';
}

const DONE = /^(download complete|pull complete|already exists|extracting|verifying checksum)/i;

// Follows `docker compose pull` output. layerSizes: Map(short layer id (12 hex) -> compressed size in bytes), from the
// registry manifests; without it only the downloaded amount is known.
function createPullProgress(layerSizes = new Map()) {
  const done = new Map();
  const total = [...layerSizes.values()].reduce((a, b) => a + b, 0);
  return {
    feed(line) {
      const m = String(line).match(/\b([0-9a-f]{12})\s+([A-Za-z ]+?)\s*(?:\[[^\]]*\]\s*)?([0-9.]+\s*[kKMGT]?B)?(?:\s*\/\s*[0-9.]+\s*[kKMGT]?B)?\s*$/);
      if (!m) return false;
      const [, id, state, amount] = m;
      const size = layerSizes.get(id);
      if (/^downloading/i.test(state)) {
        const now = parseSize(amount);
        if (now == null) return false;
        done.set(id, size ? Math.min(now, size) : now);
        return true;
      }
      if (DONE.test(state)) {
        if (size) done.set(id, size);
        return true;
      }
      return false;
    },
    downloaded: () => [...done.values()].reduce((a, b) => a + b, 0),
    total: () => total,
    // 0..1, or null when the total is unknown
    fraction() {
      return total > 0 ? Math.min(1, this.downloaded() / total) : null;
    },
    text(label) {
      const f = this.fraction();
      return f == null
        ? `${label} (${formatBytes(this.downloaded())} so far)`
        : `${label}: ${Math.floor(f * 100)} % (${formatBytes(this.downloaded())} of ${formatBytes(total)})`;
    },
  };
}

// Ollama sends progress per file of a model (a few small ones and one large one); this sums them up.
function createModelProgress() {
  const files = new Map();
  return {
    feed(msg) {
      if (!msg || !msg.digest || !msg.total) return false;
      files.set(msg.digest, { total: msg.total, completed: Math.min(msg.completed || 0, msg.total) });
      return true;
    },
    fraction() {
      let t = 0;
      let c = 0;
      for (const f of files.values()) {
        t += f.total;
        c += f.completed;
      }
      return t > 0 ? c / t : null;
    },
    totals() {
      let t = 0;
      let c = 0;
      for (const f of files.values()) {
        t += f.total;
        c += f.completed;
      }
      return { total: t, completed: c };
    },
  };
}

// Calls fn at most every `ms` milliseconds; the last call is never lost.
function throttle(fn, ms = 250) {
  let last = 0;
  let timer = null;
  let pending = null;
  return (...args) => {
    pending = args;
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...pending);
      pending = null;
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        if (pending) fn(...pending);
        pending = null;
      }, ms - (now - last));
    }
  };
}

module.exports = { parseSize, formatBytes, createPullProgress, createModelProgress, throttle };
