// Reply letters from the inbox (2.8, option 10; backend: services/reply_letters.py). No i18n import here, so the
// node tests can load this file; the labels are in ReplyLetterModal.jsx.

// the kinds of reply letters, in the order the menu shows them
export const REPLY_KINDS = ['cancel', 'objection', 'deferral', 'correction', 'sepa_revoke'];

// What the inbox offers for a document: 'scam' (a warning, never a reply letter), 'reply' (the action) or null
// (no letter: a note, a table, a book).
export function replyActionFor(doc) {
  if (!doc) return null;
  if (doc.suspicious || (doc.facts?.warnings || []).length > 0) return 'scam';
  if (!doc.facts?.letter) return null;
  return 'reply';
}

// The draft for the existing Word and PDF exports: one plain-text part (its lines are kept as they are), named after
// the subject of the letter.
export function letterExport(text, subject, label) {
  return {
    title: String(subject || '').replace(/\s+/g, ' ').trim() || 'StarkLLM',
    items: [{ role: 'user', content: String(text || '').replace(/\r\n/g, '\n').replace(/\s+$/, ''), time: '', sources: [] }],
    words: { user: label, assistant: label },
  };
}

// The deadlines of the draft view, nearest first; each keeps the sentence and page it was read from. An empty list
// means the letter states no deadline: the view then says "Please check the deadline" and never makes one up.
export function shownDeadlines(draft) {
  return [...(draft?.deadlines || [])].sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));
}

// The profile is complete when a letter can carry the user's name and address.
export function profileComplete(p) {
  return Boolean(p && String(p.full_name || '').trim() && String(p.street || '').trim() && String(p.city || '').trim());
}
