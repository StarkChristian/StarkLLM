// Every retrieved passage used to be listed as a source, even when the answer did not use it (a question about one
// file listed five). The answer names the files it used ("According to [Project card.md] ..."), so the chips show
// those files. If the answer names none of them, all retrieved sources are shown, as before.
const FILE = /^(.*?\.[A-Za-z0-9]{1,8})(?=\s*\(|$)/;

function fileName(label) {
  const m = String(label).match(FILE);
  return (m ? m[1] : String(label)).trim().toLowerCase();
}

export function citedSources(msg) {
  const ws = msg.wsSources || [];
  const kb = msg.kbSources || [];
  const text = (msg.content || '').toLowerCase();
  if (!text) return { ws, kb };
  const keep = (list) => list.filter((label) => text.includes(fileName(label)));
  const citedWs = keep(ws);
  const citedKb = keep(kb);
  if (citedWs.length + citedKb.length === 0) return { ws, kb };
  return { ws: citedWs, kb: citedKb };
}
