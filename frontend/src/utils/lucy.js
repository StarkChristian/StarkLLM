// Lucy, the StarkLLM robot: what is remembered about her (hidden once, first-start guide done) and the steps of the
// guide. No network, no cookies: only the browser's local storage, wrapped so a blocked storage never breaks a page.
export const HIDDEN_KEY = 'starkllm_lucy_hidden';
export const GUIDE_KEY = 'starkllm_lucy_guide_done';
export const CHANGE_EVENT = 'starkllm-lucy';

const storageOf = () => {
  try { return globalThis.localStorage; } catch (_) { return null; }
};

function read(key, storage = storageOf()) {
  try { return storage?.getItem(key) === '1'; } catch (_) { return false; }
}

function write(key, value, storage = storageOf()) {
  try { storage?.setItem(key, value ? '1' : '0'); } catch (_) { /* storage may be blocked: she shows again next time */ }
}

export const isHidden = (storage) => read(HIDDEN_KEY, storage);
export const guideDone = (storage) => read(GUIDE_KEY, storage);

export function setHidden(hidden, storage) {
  write(HIDDEN_KEY, hidden, storage);
  try { globalThis.dispatchEvent?.(new Event(CHANGE_EVENT)); } catch (_) { /* not in a browser */ }
}

export function setGuideDone(done, storage) {
  write(GUIDE_KEY, done, storage);
  try { globalThis.dispatchEvent?.(new Event(CHANGE_EVENT)); } catch (_) { /* not in a browser */ }
}

/** The pose of a guide step, in order: she waves, points, then explains. */
export const GUIDE_POSES = ['wave', 'point', 'talk'];

/** Next or previous step, never outside 0..total-1. */
export function stepAfter(index, total, direction) {
  return Math.max(0, Math.min(total - 1, index + direction));
}
