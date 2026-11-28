// What a screen reader says about the chat (docs/accessibility.md). The message list is a log that is not read
// aloud while the answer streams in (one announcement per word would be unusable); instead one status line says that
// StarkLLM is writing, and the finished answer is read once, as plain text.

/** Plain text of a Markdown answer for speech: no tool calls, code fences, link targets, emphasis marks or tables. */
export function spokenText(markdown, max = 1500) {
  let s = String(markdown || '');
  s = s.replace(/```tool_call[\s\S]*?```/g, ' ').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, ' ');
  s = s.replace(/```[\s\S]*?```/g, ' ');                  // code blocks stay on screen
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');         // images: their text
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');          // links: their text
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');              // headings
  s = s.replace(/^\s*[-*+]\s+/gm, '');                    // list marks
  s = s.replace(/^\s*>\s?/gm, '');                        // quotes
  s = s.replace(/^\s*\|?\s*:?-{3,}.*$/gm, '');            // table rule lines
  s = s.replace(/\|/g, ' ');
  s = s.replace(/(\*\*|__|\*|_|~~|`)/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) s = `${s.slice(0, max).replace(/\s+\S*$/, '')} …`;
  return s;
}

/**
 * The status line for the chat, from the state before and now: null when nothing is to be said.
 * busy: an answer is being written; last: the newest message.
 */
export function chatAnnouncement(wasBusy, busy, last, text) {
  if (busy && !wasBusy) return text.writing;
  if (!busy && wasBusy && last) {
    if (last.isError) return spokenText(last.content);
    if (last.role === 'assistant') {
      const said = spokenText(last.content);
      return said ? text.answer.replace('{answer}', said) : null;
    }
  }
  return null;
}
