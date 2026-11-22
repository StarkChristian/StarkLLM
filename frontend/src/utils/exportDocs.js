// Chats and single answers as Word and PDF (docs/roadmap-2026-12.md, R1). Word: the engine writes the .docx on this
// PC (POST /api/v1/chat/export/docx). PDF: the desktop app prints a light HTML page with its own PDF printer; in the
// browser version the browser's print dialog ("Save as PDF") opens instead.

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Markdown of one line -> HTML, after escaping (so nothing of the text can become a tag or a script)
function inline(text) {
  let s = esc(text);
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/\*\*(.+?)\*\*|__(.+?)__/g, (_, a, b) => `<strong>${a || b}</strong>`);
  s = s.replace(/(^|[^\w*])\*([^*\n]+?)\*(?![\w*])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^\w_])_([^_\n]+?)_(?![\w_])/g, '$1<em>$2</em>');
  // only web and mail addresses become links
  s = s.replace(/\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^)\s]+)\)/gi, (_, label, url) => `<a href="${url}">${label}</a>`);
  s = s.replace(/\u0000(\d+)\u0000/g, (_, k) => `<code>${codes[Number(k)]}</code>`);
  return s;
}

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

export function markdownToHtml(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const listStack = [];
  const closeLists = () => { while (listStack.length) out.push(`</${listStack.pop()}>`); };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      closeLists();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!line.trim()) { closeLists(); i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) { closeLists(); const lv = Math.min(h[1].length + 1, 6); out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { closeLists(); out.push('<hr>'); i++; continue; }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      closeLists();
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + head.map((_, k) => `<td>${inline(r[k] || '')}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    const b = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const n = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (b || n) {
      const depth = Math.min(Math.floor((b || n)[1].replace(/\t/g, '    ').length / 2), 3);
      const tag = b ? 'ul' : 'ol';
      while (listStack.length > depth + 1) out.push(`</${listStack.pop()}>`);
      if (listStack.length === depth + 1 && listStack[depth] !== tag) out.push(`</${listStack.pop()}>`);
      while (listStack.length < depth + 1) {
        out.push(tag === 'ol' && listStack.length === depth ? `<ol start="${Number(n[2])}">` : `<${tag}>`);
        listStack.push(tag);
      }
      out.push(`<li>${inline(b ? b[2] : n[3])}</li>`);
      i++;
      continue;
    }
    closeLists();
    if (/^\s*>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|[-*+]\s|\d+[.)]\s|>)/.test(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))) para.push(lines[i++].trim());
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  closeLists();
  return out.join('\n');
}

// The sources of an answer as short texts (file names, knowledge base, web pages)
export function sourcesOf(msg, readable = (x) => x) {
  const s = [];
  for (const x of msg.wsSources || []) s.push(typeof x === 'string' ? x : x.filename || x.title || '');
  for (const x of msg.kbSources || []) s.push(typeof x === 'string' ? x : x.filename || x.title || '');
  for (const x of msg.webSources || []) s.push(typeof x === 'string' ? x : (x.url ? `${x.title || x.url} (${x.url})` : x.title || ''));
  return s.filter(Boolean).map(readable);
}

// the messages of a chat (or of one question and its answer) for an export: no system notes, no empty answers
export function exportItems(messages, locale, toDate = (v) => new Date(v), readable = (x) => x) {
  return (messages || [])
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .map((m) => ({
      role: m.role,
      // an image question ends with "🖼 name": the icon is left out (the PDF fonts have no picture for it)
      content: String(m.content).replace(/\n\n\u{1F5BC}\uFE0F? ([^\n]+)$/u, '\n\n($1)'),
      time: m.timestamp ? toDate(m.timestamp).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) : '',
      sources: m.role === 'assistant' ? sourcesOf(m, readable) : [],
    }));
}

// A light page for printing: the same parts as the Word file
export function printableHtml(title, items, words, dateText, lang = 'en', dir = 'ltr') {
  const body = items.map((m) => `
<section class="${m.role}">
  <div class="who">${esc(m.role === 'user' ? words.user : words.assistant)}${m.time ? ` <span class="time">${esc(m.time)}</span>` : ''}</div>
  <div class="text">${m.role === 'user' ? `<p>${esc(m.content).replace(/\n/g, '<br>')}</p>` : markdownToHtml(m.content)}</div>
  ${m.sources && m.sources.length ? `<div class="sources">${esc(words.sources)}: ${m.sources.map(esc).join('; ')}</div>` : ''}
</section>`).join('\n');
  return `<!DOCTYPE html>
<html lang="${esc(lang)}" dir="${dir === 'rtl' ? 'rtl' : 'ltr'}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${esc(title)}</title>
<style>
  body { font-family: "Segoe UI", Calibri, Arial, "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", sans-serif; color: #111; line-height: 1.5; margin: 0; font-size: 11pt; }
  h1 { font-size: 18pt; margin: 0 0 2pt; }
  .meta { color: #666; font-size: 9pt; margin-bottom: 14pt; }
  section { border-top: 1px solid #ddd; padding: 8pt 0; page-break-inside: auto; }
  .who { font-weight: 600; color: #059669; margin-bottom: 4pt; }
  .user .who { color: #4f46e5; }
  .time { color: #888; font-weight: 400; font-size: 9pt; }
  .text p { margin: 0 0 6pt; }
  pre { background: #f3f4f6; padding: 6pt 8pt; border-radius: 4pt; white-space: pre-wrap; font-size: 9pt; }
  code { font-family: Consolas, monospace; font-size: 9.5pt; background: #f3f4f6; padding: 0 2pt; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; margin: 6pt 0; }
  th, td { border: 1px solid #bbb; padding: 3pt 6pt; text-align: start; vertical-align: top; }
  th { background: #f3f4f6; }
  blockquote { margin: 6pt 0; padding-inline-start: 10pt; border-inline-start: 3px solid #ccc; color: #444; }
  a { color: #1f4fbf; }
  .sources { font-size: 9pt; font-style: italic; color: #555; margin-top: 4pt; }
</style>
</head>
<body>
<h1>${esc(title)}</h1>
<div class="meta">${esc(words.exported)}${dateText ? ` · ${esc(dateText)}` : ''}</div>
${body}
</body>
</html>`;
}

// the title of an exported chat: no picture icons (an image question starts its chat title with "🖼 name")
export function exportTitle(title) {
  return String(title || '').replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/\s+/g, ' ').trim() || 'StarkLLM';
}

export function fileBase(title) {
  // Windows keeps no dots or spaces at the end of a name ("Bologna." + ".docx" gave "Bologna..docx"); a cut title
  // ends with no comma either ("…population of Aachen,.pdf")
  const base = exportTitle(title).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return base.replace(/[.,;:!\s\-–—]+$/u, '') || 'StarkLLM';
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60000); // the browser may still read it after a save dialog
}

// -> true when the file was made (or the print dialog opened), false when it failed, null when the user cancelled
export async function saveAsWord({ title, items, words, dateText, headers }) {
  const res = await fetch('/api/v1/chat/export/docx', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, messages: items, labels: words, date_text: dateText }),
  });
  if (!res.ok) return false;
  const blob = await res.blob();
  const name = `${fileBase(title)}.docx`;
  const desktop = typeof window !== 'undefined' && window.starkllmDesktop && window.starkllmDesktop.saveFile;
  if (desktop) {
    // the desktop app: its own save dialog (a browser download stayed a .tmp file in Downloads, MSI test 2.5.0)
    const r = await window.starkllmDesktop.saveFile(name, new Uint8Array(await blob.arrayBuffer()));
    if (r && r.canceled) return null;
    return Boolean(r && r.ok);
  }
  download(blob, name);
  return true;
}

export async function saveAsPdf({ title, items, words, dateText, lang, dir }) {
  const html = printableHtml(title, items, words, dateText, lang, dir);
  const desktop = typeof window !== 'undefined' && window.starkllmDesktop && window.starkllmDesktop.exportPdf;
  if (desktop) {
    const r = await window.starkllmDesktop.exportPdf(html, `${fileBase(title)}.pdf`);
    if (r && r.canceled) return null;
    return Boolean(r && r.ok);
  }
  // the browser version: the browser's print dialog, where "Save as PDF" is one of the printers
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  frame.setAttribute('sandbox', 'allow-modals allow-same-origin');
  document.body.appendChild(frame);
  frame.srcdoc = html;
  await new Promise((resolve) => { frame.onload = resolve; });
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => frame.remove(), 60000);
  return true;
}
