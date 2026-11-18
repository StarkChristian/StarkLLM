// A question without an answer after it (MSI night test of 2.3.0, N42: StarkLLM was closed while it was answering;
// after the restart the chat showed the question alone, with no hint). A note with "Try again" is shown after it.
// Questions from the last few minutes are left alone: their answer may still be on its way.
// No imports: the tests run this file in Node.
export const STILL_ANSWERING_MS = 5 * 60 * 1000;

export function withInterruptedNotes(messages, note, now = Date.now()) {
  const out = [];
  (messages || []).forEach((m, i) => {
    out.push(m);
    if (m.role !== 'user') return;
    const next = messages[i + 1];
    if (next && next.role !== 'user') return;
    const at = Date.parse(m.created_at || m.timestamp || '');
    if (!next && (Number.isNaN(at) || now - at < STILL_ANSWERING_MS)) return;
    out.push({ role: 'assistant', content: note, isError: true, failedText: m.content, interrupted: true });
  });
  return out;
}
