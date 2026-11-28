// Reply letters from the inbox (2.8, option 10): no reply letter for a scam letter, the export keeps the letter as
// written, deadlines only from the letter, and the texts are in every UI language.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPLY_KINDS, replyActionFor, letterExport, shownDeadlines, profileComplete } from '../src/utils/replyLetter.js';
import { printableHtml } from '../src/utils/exportDocs.js';

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('the five kinds of reply letters', () => {
  assert.deepEqual(REPLY_KINDS, ['cancel', 'objection', 'deferral', 'correction', 'sepa_revoke']);
});

test('a scam letter gets a warning and never the reply-letter action', () => {
  assert.equal(replyActionFor({ suspicious: true, facts: { letter: true, warnings: ['scam_signs'] } }), 'scam');
  assert.equal(replyActionFor({ suspicious: false, facts: { letter: true, warnings: ['ai_instructions'] } }), 'scam');
  assert.equal(replyActionFor({ suspicious: false, facts: { letter: true, warnings: [] } }), 'reply');
  assert.equal(replyActionFor({ suspicious: false, facts: { letter: false } }), null);   // a note, a table, a book
  assert.equal(replyActionFor(null), null);
});

test('the inbox shows the action only for "reply" and the warning for "scam"', () => {
  const inbox = fs.readFileSync(path.join(src, 'components', 'Inbox.jsx'), 'utf8');
  assert.match(inbox, /replyActionFor\(doc\) === 'reply' && !isEditing && \(\s*<button className=\{styles\.replyBtn\}/);
  assert.match(inbox, /replyActionFor\(doc\) === 'scam' && \(\s*<p className=\{styles\.scamNote\}/);
});

test('the export keeps the letter line by line as plain text', () => {
  const letter = 'Anna Beispiel\nGartenweg 5\n\nStadtwerke <AG>\n\nKündigung\r\n\nMit freundlichen Grüßen\n\n\nAnna Beispiel\n\n';
  const { title, items, words } = letterExport(letter, '  Kündigung   – Ihr Schreiben ', 'Antwortbrief (Entwurf)');
  assert.equal(title, 'Kündigung – Ihr Schreiben');
  assert.equal(items.length, 1);
  assert.equal(items[0].role, 'user');                         // the plain-text part of the exports: no Markdown
  assert.ok(items[0].content.endsWith('Anna Beispiel'));
  assert.ok(!items[0].content.includes('\r'));
  assert.equal(words.user, 'Antwortbrief (Entwurf)');
  const html = printableHtml(title, items, { ...words, sources: 'Quellen', exported: 'Exportiert' }, '', 'de');
  assert.match(html, /Anna Beispiel<br>Gartenweg 5<br><br>Stadtwerke &lt;AG&gt;/);
  assert.equal(letterExport('', '', 'x').title, 'StarkLLM');
});

test('deadlines come only from the draft (the letter), nearest first; none means none', () => {
  assert.deepEqual(shownDeadlines(null), []);
  assert.deepEqual(shownDeadlines({ deadlines: [] }), []);
  const d = shownDeadlines({ deadlines: [{ date: '2026-12-15', text: 'b' }, { date: null, literal: '03/04/2027', text: 'c' }, { date: '2026-12-01', text: 'a' }] });
  assert.deepEqual(d.map((x) => x.text), ['a', 'b', 'c']);
});

test('the profile is complete with name, street and town', () => {
  assert.equal(profileComplete({ full_name: 'Anna', street: 'Gartenweg 5', city: 'Zürich' }), true);
  assert.equal(profileComplete({ full_name: 'Anna', street: ' ', city: 'Zürich' }), false);
  assert.equal(profileComplete(null), false);
});

test('the reply-letter texts are translated into every UI language, the German one in the formal address', () => {
  const modal = fs.readFileSync(path.join(src, 'components', 'ReplyLetterModal.jsx'), 'utf8');
  const keys = [...modal.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
  assert.ok(keys.includes('Please check the deadline'));
  assert.ok(keys.includes('This is not legal advice. Check the letter and the deadlines yourself, or ask an advice centre or a lawyer.'));
  for (const code of ['de', 'fr', 'es', 'it', 'tr']) {
    const dict = JSON.parse(fs.readFileSync(path.join(src, 'i18n', `${code}.json`), 'utf8'));
    for (const k of keys) assert.ok(dict[k], `${code}: ${k}`);
  }
  const de = JSON.parse(fs.readFileSync(path.join(src, 'i18n', 'de.json'), 'utf8'));
  for (const k of keys) assert.doesNotMatch(de[k], /\b(du|dein|deine|dich|dir)\b/i, k);
  const fr = JSON.parse(fs.readFileSync(path.join(src, 'i18n', 'fr.json'), 'utf8'));
  for (const k of keys) assert.doesNotMatch(fr[k], /\b(tu|ton|ta|tes|toi)\b/i, k);
});
