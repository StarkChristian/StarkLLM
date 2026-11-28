// The PDF export is marked as AI-generated (EU AI Act, Article 50): document information and a line on every page.
const test = require('node:test');
const assert = require('node:assert');
const { setPdfInfo, readPdfInfo, pdfString, decodePdfString } = require('../pdf-info');
const { withPageFooter, aiNoteOf, aiPdfInfo, AI_NOTE } = require('../export-pdf');

// A small PDF the way Chromium's printer (Skia) writes one: classic cross-reference table, /Info in the trailer.
function samplePdf({ title = '(Bills \\(2026\\))', withInfo = true } = {}) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>',
    `<< /Title ${title} /Creator (Chromium) /Producer (Skia/PDF m142) /CreationDate (D:20261128120000+00'00') >>`,
  ];
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${withInfo ? ' /Info 4 0 R' : ''} /ID [<AB12> <AB12>] >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('a PDF string: ASCII as a literal with escapes, other text as UTF-16 with a byte order mark', () => {
  assert.strictEqual(pdfString('a (b) \\ c'), '(a \\(b\\) \\\\ c)');
  assert.strictEqual(pdfString('ü'), '<FEFF00FC>');
  assert.strictEqual(decodePdfString(pdfString('Mit KI-Unterstützung erstellt')), 'Mit KI-Unterstützung erstellt');
  assert.strictEqual(decodePdfString('(a \\(b\\))'), 'a (b)');
});

test('the exported PDF says in its document information that it is AI-generated', () => {
  const before = samplePdf();
  assert.strictEqual(readPdfInfo(before).Producer, 'Skia/PDF m142');
  const after = setPdfInfo(before, aiPdfInfo('2.7.0'));
  const info = readPdfInfo(after);
  assert.strictEqual(info.Producer, 'StarkLLM 2.7.0 (AI-generated content)');
  assert.strictEqual(info.Creator, 'StarkLLM 2.7.0 (AI-generated content)');
  assert.strictEqual(info.Keywords, 'AI-generated');
  assert.match(info.Subject, /AI-generated/);
  // the title and the date of the printer are kept
  assert.strictEqual(info.Title, 'Bills (2026)');
  assert.strictEqual(info.CreationDate, "D:20261128120000+00'00'");
});

test('the update is appended: the printed bytes stay, the new trailer points to the old one and to the new object', () => {
  const before = samplePdf();
  const after = setPdfInfo(before, { Keywords: 'AI-generated' });
  assert.ok(after.subarray(0, before.length).equals(before));
  const tail = after.subarray(before.length).toString('latin1');
  const oldXref = /startxref\n(\d+)/.exec(before.toString('latin1'))[1];
  assert.match(tail, new RegExp(`/Size 6 /Root 1 0 R /Info 5 0 R /Prev ${oldXref} /ID \\[<AB12> <AB12>\\]`));
  // the cross-reference entry and startxref point exactly at the new object and the new xref section
  const text = after.toString('latin1');
  const entry = /xref\n5 1\n(\d{10}) 00000 n \n/.exec(tail);
  assert.ok(entry);
  assert.strictEqual(text.slice(Number(entry[1]), Number(entry[1]) + 9), '5 0 obj\n<');
  const sx = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)[1]);
  assert.strictEqual(text.slice(sx, sx + 4), 'xref');
  assert.strictEqual(Buffer.from('0000000000 00000 n \n').length, 20); // the fixed size of a cross-reference entry
});

test('a PDF without information and one updated twice', () => {
  const a = setPdfInfo(samplePdf({ withInfo: false }), { Keywords: 'AI-generated' });
  assert.deepStrictEqual(readPdfInfo(a), { Keywords: 'AI-generated' });
  const b = setPdfInfo(a, { Producer: 'StarkLLM' });
  assert.deepStrictEqual(readPdfInfo(b), { Keywords: 'AI-generated', Producer: 'StarkLLM' });
});

test('a file that cannot be updated safely is left as it is', () => {
  const odd = Buffer.from('%PDF-1.5\n1 0 obj\n<< /Type /XRef >>\nstream\nendstream\nendobj\nstartxref\n9\n%%EOF\n', 'latin1');
  assert.ok(setPdfInfo(odd, { Keywords: 'AI-generated' }).equals(odd));
  assert.ok(setPdfInfo(Buffer.from('not a pdf'), { Keywords: 'x' }).equals(Buffer.from('not a pdf')));
});

test('the note of the page goes to the foot of every page, in the user\'s language', () => {
  const html = '<html><head><meta name="starkllm-ai-note" content="Mit KI-Unterstützung &amp; Sorgfalt"></head>'
    + '<body><p>x</p>\n<footer class="ai-note">Mit KI</footer>\n</body></html>';
  const page = withPageFooter(html);
  assert.ok(!page.html.includes('<footer class="ai-note">'));
  assert.ok(page.html.includes('<p>x</p>'));
  assert.match(page.footerTemplate, /Mit KI-Unterstützung &amp; Sorgfalt/);
  // no note in the page: the English one; nothing of the page becomes a tag in the footer
  assert.strictEqual(aiNoteOf('<html></html>'), AI_NOTE);
  assert.ok(!withPageFooter('<meta name="starkllm-ai-note" content="&lt;img src=x&gt;">').footerTemplate.includes('<img'));
});
