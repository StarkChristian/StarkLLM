// Chats as Word and PDF (docs/roadmap-2026-12.md, R1): the printable page is safe and keeps the formatting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { markdownToHtml, printableHtml, exportItems, fileBase } from '../src/utils/exportDocs.js';

test('Markdown becomes HTML: headings, lists, tables, code, quotes, links', () => {
  const html = markdownToHtml('## Bill\n\nThe bill is **84 EUR**, due *15 Dec*. Ref `INV-1`.\n\n1. Check\n2. Pay\n   - by transfer\n\n| A | B |\n| --- | --- |\n| x | y |\n\n> quoted\n\n```\nlet a = 1 < 2;\n```\n\n[site](https://example.com)');
  assert.match(html, /<h3>Bill<\/h3>/);
  assert.match(html, /<strong>84 EUR<\/strong>/);
  assert.match(html, /<em>15 Dec<\/em>/);
  assert.match(html, /<code>INV-1<\/code>/);
  assert.match(html.replace(/\n/g, ''), /<ol start="1"><li>Check<\/li><li>Pay<\/li><ul><li>by transfer<\/li><\/ul><\/ol>/);
  assert.match(html, /<th>A<\/th><th>B<\/th>/);
  assert.match(html, /<td>x<\/td><td>y<\/td>/);
  assert.match(html, /<blockquote>quoted<\/blockquote>/);
  assert.match(html, /let a = 1 &lt; 2;/);
  assert.match(html, /<a href="https:\/\/example.com">site<\/a>/);
});

test('nothing of the text becomes a tag or a script', () => {
  const html = markdownToHtml('<img src=x onerror=alert(1)> **<script>alert(1)</script>** [x](javascript:alert(1)) [y](https://a.example/" onclick="x)');
  assert.doesNotMatch(html, /<img|<script|href="javascript/i);
  assert.doesNotMatch(html, /" onclick="/);
  const page = printableHtml('<b>Title</b>', [{ role: 'user', content: '<i>q</i>' }], { user: 'You', assistant: 'StarkLLM', sources: 'Sources', exported: 'Exported' }, '');
  assert.doesNotMatch(page, /<b>Title|<i>q/);
  assert.match(page, /Content-Security-Policy" content="default-src 'none'/);
});

test('the export has the chat messages with their sources, not the system notes', () => {
  const items = exportItems([
    { role: 'system', content: 'Uploading…' },
    { role: 'user', content: 'What is due?' },
    { role: 'assistant', content: 'The bill.', wsSources: ['bill.pdf'], webSources: [{ title: 'Supplier', url: 'https://s.example' }] },
    { role: 'assistant', content: '' },
  ], 'en');
  assert.equal(items.length, 2);
  assert.deepEqual(items[1].sources, ['bill.pdf', 'Supplier (https://s.example)']);
  assert.equal(fileBase('Bills: Q4/2026?'), 'Bills Q42026');
});

test('times of messages from the engine (UTC without a zone) are shown in local time', () => {
  const utc = (v) => new Date(String(v) + 'Z');
  const [item] = exportItems([{ role: 'user', content: 'x', timestamp: '2026-11-22T10:24:00' }], 'en-GB', utc);
  const local = new Date(Date.UTC(2026, 10, 22, 10, 24)).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' });
  assert.equal(item.time, local);
});

test('a file name does not end in a dot', () => {
  assert.equal(fileBase('How many people live in Bologna.'), 'How many people live in Bologna');
  assert.equal(fileBase('...'), 'StarkLLM');
});

test('the export: readable source places and no picture icon', () => {
  const [q, a] = exportItems([
    { role: 'user', content: 'What is due?\n\n\u{1F5BC} letter-de.png' },
    { role: 'assistant', content: 'x', wsSources: ['meeting-de.wav (Time 00:00:09)'] },
  ], 'en', undefined, (s) => s.replace(/ \(Time (.*)\)$/, ' · at $1'));
  assert.equal(q.content, 'What is due?\n\n(letter-de.png)');
  assert.deepEqual(a.sources, ['meeting-de.wav · at 00:00:09']);
});
