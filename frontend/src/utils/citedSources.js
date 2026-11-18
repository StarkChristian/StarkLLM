// No imports: the tests run this file in Node (sources.js needs the Vite-only translations).
// Every retrieved passage used to be listed as a source, even when the answer did not use it (a question about one
// file listed five). The answer names the files it used ("According to [Project card.md] ..."), so the chips show
// those files. If the answer names none of them: for a question about the documents (sourcesMode "documents", or an
// older saved answer without a mode) all retrieved sources are shown, as before; for a message that only may be about
// them ("maybe": a coding task, a greeting, general knowledge) none, since the model names the file whenever it
// answers from one (a code answer listed every retrieved file as its source, MSI test §15).
const FILE = /^(.*?\.[A-Za-z0-9]{1,8})(?=\s*\(|$)/;

function fileName(label) {
  const m = String(label).match(FILE);
  return (m ? m[1] : String(label)).trim().toLowerCase();
}

export function citedSources(msg) {
  const ws = msg.wsSources || [];
  const kb = msg.kbSources || [];
  // the engine compared the finished answer with the passages and kept the documents it used (N36)
  if (msg.sourcesUsed) return { ws, kb };
  const text = (msg.content || '').toLowerCase();
  if (!text) return { ws, kb };
  const keep = (list) => list.filter((label) => text.includes(fileName(label)));
  const citedWs = keep(ws);
  const citedKb = keep(kb);
  if (citedWs.length + citedKb.length === 0) return msg.sourcesMode === 'maybe' ? { ws: [], kb: [] } : { ws, kb };
  return { ws: citedWs, kb: citedKb };
}
