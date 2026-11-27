// Which box a finding of document_checks.py goes into (DocumentWarnings.jsx):
//   serious:  red, several signs of a scam, a note to AI assistants or hidden text in a file that also has them,
//             and one sender with two bank accounts
//   cautions: yellow, a note to AI assistants or hidden text alone. StarkLLM ignored it and the answer treats the
//             letter as a normal bill, so the app must not call it a scam either (2.6.1, test laptop with 2.6.0)
//   notes:    yellow, a sender announces a new bank account
export function sortWarnings(warnings) {
  const list = warnings || [];
  const scamFiles = new Set(list.filter((w) => w.kind === 'scam_signs').map((w) => w.file));
  const noteOnly = (w) => (w.kind === 'ai_instructions' || w.kind === 'hidden_text') && !scamFiles.has(w.file);
  return {
    serious: list.filter((w) => w.kind !== 'account_change' && !noteOnly(w)),
    cautions: list.filter(noteOnly),
    notes: list.filter((w) => w.kind === 'account_change'),
  };
}
