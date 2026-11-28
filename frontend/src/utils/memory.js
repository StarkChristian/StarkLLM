// Long-term memory in the app (2.8): pure helpers, so node can test them without a build tool. The texts are chosen
// in the components (t() needs the build), these helpers only decide which one.

/** The memories an answer used, from the X-Memory-Sources header (URL-encoded JSON). Never throws. */
export function parseMemoryHeader(value) {
  if (!value) return [];
  try {
    return memorySources(JSON.parse(decodeURIComponent(value)));
  } catch {
    return [];
  }
}

/** The memories of a saved answer (sources.memory) or of the header, cleaned: [{ id, text, pinned }]. */
export function memorySources(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m && typeof m.id === 'string' && typeof m.text === 'string' && m.text.trim())
    .map((m) => ({ id: m.id, text: m.text, pinned: Boolean(m.pinned) }));
}

/** Which provenance line an entry gets. kind: typed | userMessage | answer | chat | deletedChat | accepted |
 * acceptedFrom | suggested | suggestedFrom | legacy. chat: the chat title when the line names it. */
export function provenance(entry) {
  const e = entry || {};
  const chat = e.chat_id && e.chat_exists !== false && e.chat_title ? e.chat_title : null;
  const deleted = Boolean(e.chat_id) && e.chat_exists === false;
  if (e.status === 'suggested') return { kind: chat ? 'suggestedFrom' : 'suggested', chat };
  if (e.origin === 'legacy') return { kind: 'legacy', chat: null };
  if (e.origin === 'suggestion') return { kind: chat ? 'acceptedFrom' : 'accepted', chat };
  if (!e.chat_id) return { kind: 'typed', chat: null };
  if (deleted) return { kind: 'deletedChat', chat: null };
  if (e.from_role === 'user') return { kind: 'userMessage', chat };
  if (e.from_role === 'assistant') return { kind: 'answer', chat };
  return { kind: 'chat', chat };
}

/** The code of a refused memory (422 from the engine): "addresses_ai", "too_long", "empty", or null. */
export function rejectionCode(body) {
  const d = body && body.detail;
  return d && typeof d === 'object' && typeof d.code === 'string' ? d.code : null;
}

/** The text "Remember this" offers for a message: without the tool-call blocks, trimmed to the memory limit. */
export const MEMORY_MAX_CHARS = 1000;
export function rememberText(content) {
  const text = String(content || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<\/?tool_call>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > MEMORY_MAX_CHARS ? text.slice(0, MEMORY_MAX_CHARS).trimEnd() : text;
}

/** Pinned first, then the newest first (the order the engine sends; kept when the list changes in the app). */
export function sortMemories(list) {
  return [...(list || [])].sort((a, b) => (Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
    || String(b.created_at || '').localeCompare(String(a.created_at || '')));
}
