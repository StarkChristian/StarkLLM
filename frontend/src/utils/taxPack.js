// The yearly package for the tax advisor (StarkLLM 2.8, option 11): the review list and the request for the ZIP.
// No texts here (the dialog translates); the functions are pure so node --test can check them.

export const MIN_PASSWORD = 8;
export const CATEGORY_IDS = ['tax', 'insurance', 'housing', 'work', 'health', 'other'];

// The year a tax advisor asks for: the one before this year.
export function defaultYear(today = new Date()) {
  return today.getFullYear() - 1;
}

// The years to offer: the ones with letters (newest first), plus the default year, without duplicates.
export function yearChoices(years, today = new Date()) {
  const all = new Set([defaultYear(today), today.getFullYear(), ...(years || []).map(Number)]);
  return [...all].filter((y) => Number.isInteger(y) && y > 1969 && y < 2101).sort((a, b) => b - a);
}

// The list as the user sees it: StarkLLM's rows with the user's changes ({ key: { category, included, source } }).
export function effectiveRows(rows, changes) {
  return (rows || []).map((r) => {
    const c = (changes || {})[r.key] || {};
    const moved = CATEGORY_IDS.includes(c.category) && c.category !== r.category;
    const category = moved ? c.category : r.category;
    const included = typeof c.included === 'boolean' ? c.included : r.included;
    const source = moved ? (c.source === 'model' ? 'model' : 'user') : r.category_source;
    return { ...r, category, included, category_source: source, changed: moved || included !== r.included };
  });
}

// What the export request sends: only the rows the user changed.
export function overridesFrom(rows, changes) {
  const out = [];
  for (const r of rows || []) {
    const c = (changes || {})[r.key];
    if (!c) continue;
    const o = { key: r.key };
    if (CATEGORY_IDS.includes(c.category) && c.category !== r.category) {
      o.category = c.category;
      o.source = c.source === 'model' ? 'model' : 'user';
    }
    if (typeof c.included === 'boolean' && c.included !== r.included) o.included = c.included;
    if (Object.keys(o).length > 1) out.push(o);
  }
  return out;
}

// null when the password can be used (or none is wanted), else 'short' or 'different'.
export function passwordProblem(password, repeated) {
  if (!password && !repeated) return null;
  if ((password || '').length < MIN_PASSWORD) return 'short';
  if (password !== repeated) return 'different';
  return null;
}

// How many documents go into the package, per category, and how many stay out.
export function counts(rows) {
  const byCategory = Object.fromEntries(CATEGORY_IDS.map((c) => [c, 0]));
  let included = 0;
  let excluded = 0;
  for (const r of rows || []) {
    if (r.included) {
      included += 1;
      byCategory[r.category] = (byCategory[r.category] || 0) + 1;
    } else excluded += 1;
  }
  return { included, excluded, byCategory };
}

// The file name the server gave in Content-Disposition (filename*=UTF-8''...), else the fallback.
export function nameFromDisposition(header, fallback) {
  const m = /filename\*=UTF-8''([^;]+)/i.exec(header || '');
  if (m) {
    try { return decodeURIComponent(m[1]); } catch (_) { /* fall back */ }
  }
  return fallback;
}

// Save the ZIP where the user chooses: the desktop app's save dialog, else the browser's file picker, else a
// normal download. -> true when saved, null when the user cancelled, false when it failed.
export async function saveZip(blob, name) {
  const desktop = typeof window !== 'undefined' && window.starkllmDesktop && window.starkllmDesktop.saveFile;
  if (desktop) {
    const r = await window.starkllmDesktop.saveFile(name, new Uint8Array(await blob.arrayBuffer()));
    if (r && r.canceled) return null;
    return Boolean(r && r.ok);
  }
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }] });
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      handle = null;
    }
    if (handle) {
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}
