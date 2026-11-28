// Small helpers of the "Document health" view and the "no good source" notice (2.7). Pure, so tests can import them.

/** "1, 2, 3, 7" and, for long lists, "1, 2, 3 … (+12)". */
export function pageList(pages, max = 12) {
  const list = (pages || []).filter((p) => Number.isFinite(p));
  if (list.length <= max) return list.join(', ');
  return `${list.slice(0, max).join(', ')} … (+${list.length - max})`;
}

/** Bytes as whole megabytes, the way download sizes are shown ("358 MB"). */
export function megabytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/** What the "no good source" notice suggests: check the document, rephrase, and web search unless it was on. */
export function noSourceActions(warning) {
  return warning && warning.web ? ['check', 'rephrase'] : ['check', 'rephrase', 'web'];
}

/** Warnings of an answer split for display: serious ones (red), notes (yellow) and the "no good source" notice. */
export function splitWarnings(warnings) {
  const all = warnings || [];
  return {
    noSource: all.find((w) => w.kind === 'no_good_source') || null,
    serious: all.filter((w) => w.kind !== 'account_change' && w.kind !== 'no_good_source'),
    notes: all.filter((w) => w.kind === 'account_change'),
  };
}

/** Download progress of the reranker in percent (0-100), or null when nothing is downloading. */
export function downloadPercent(download) {
  if (!download || download.state !== 'downloading' || !download.total) return null;
  return Math.min(100, Math.floor((download.done / download.total) * 100));
}
