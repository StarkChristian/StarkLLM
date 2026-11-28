// Every export says that its content was made with AI (EU AI Act, Article 50): for machines and for people.
import test from 'node:test';
import assert from 'node:assert/strict';
import { printableHtml, AI_NOTE } from '../src/utils/exportDocs.js';
import { buildChatExport } from '../src/utils/chatExport.js';

const MESSAGES = [
  { role: 'system', content: 'Uploading…' },
  { role: 'user', content: 'What does the letter want?', timestamp: '2026-11-28T10:00:00Z' },
  { role: 'assistant', content: 'It is a **bill**.', wsSources: ['bill.pdf'] },
];
const DE_NOTE = 'Mit KI-Unterstützung erstellt (StarkLLM)';
const opts = { locale: 'de-DE', aiNote: DE_NOTE, now: new Date('2026-11-28T12:00:00Z') };

test('PDF page: meta tags for machines and the note in the user\'s language at the foot', () => {
  const html = printableHtml('Bills', [{ role: 'assistant', content: 'Hi', sources: [] }],
    { user: 'Sie', assistant: 'StarkLLM', sources: 'Quellen', exported: 'Exportiert', ai_note: DE_NOTE }, '28.11.2026', 'de');
  assert.match(html, /<meta name="ai-generated" content="true">/);
  assert.match(html, /<meta name="keywords" content="AI-generated">/);
  assert.match(html, /<meta name="generator" content="StarkLLM \(AI-generated content\)">/);
  assert.ok(html.includes(`<meta name="starkllm-ai-note" content="${DE_NOTE}">`));
  assert.match(html, /<footer class="ai-note">Mit KI-Unterstützung erstellt \(StarkLLM\)<\/footer>\s*<\/body>/);
});

test('PDF page: the English note when the page sends none, and the note cannot become a tag', () => {
  const words = { user: 'You', assistant: 'StarkLLM', sources: 'Sources', exported: 'Exported' };
  assert.ok(printableHtml('x', [], words, '').includes(`<footer class="ai-note">${AI_NOTE}</footer>`));
  const evil = printableHtml('x', [], { ...words, ai_note: '"><script>alert(1)</script>' }, '');
  assert.ok(!evil.includes('<script>'));
});

test('Markdown: front matter ai_generated: true and the note', () => {
  const { content, ext, mimeType } = buildChatExport(MESSAGES, 'Bills "2026"', 'md', opts);
  assert.equal(ext, 'md');
  assert.equal(mimeType, 'text/markdown');
  assert.ok(content.startsWith('---\ntitle: "Bills \\"2026\\""\ngenerator: StarkLLM\nai_generated: true\n---\n\n# Bills'));
  assert.ok(content.includes(`> ${DE_NOTE}`));
  assert.ok(!content.includes('Uploading'));
});

test('JSON: fields ai_generated and generator', () => {
  const { content, ext } = buildChatExport(MESSAGES, 'Bills', 'json', opts);
  assert.equal(ext, 'json');
  const data = JSON.parse(content);
  assert.equal(data.ai_generated, true);
  assert.equal(data.generator, 'StarkLLM');
  assert.equal(data.ai_note, DE_NOTE);
  assert.equal(data.messages.length, 2);
});

test('HTML: meta tags, the visible note, and a title that cannot become a tag', () => {
  const { content, ext } = buildChatExport(MESSAGES, '<img src=x onerror=alert(1)>', 'html', opts);
  assert.equal(ext, 'html');
  assert.match(content, /<meta name="ai-generated" content="true">/);
  assert.match(content, /<meta name="generator" content="StarkLLM \(AI-generated content\)">/);
  assert.ok(content.includes(`<footer class="ai-note">${DE_NOTE}</footer>`));
  assert.ok(!content.includes('<img src=x'));
});

test('Text: the note and ai_generated: true in the head', () => {
  const { content, ext } = buildChatExport(MESSAGES, 'Bills', 'txt', opts);
  assert.equal(ext, 'txt');
  const head = content.split('='.repeat(50))[0];
  assert.ok(head.includes(DE_NOTE) && head.includes('ai_generated: true'));
});

test('without options: the English note', () => {
  const { content } = buildChatExport(MESSAGES, 'Bills', 'md');
  assert.ok(content.includes('> Created with AI assistance (StarkLLM)'));
});
