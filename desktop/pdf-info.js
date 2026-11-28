// The document information of a PDF (Producer, Creator, Keywords ...), written by StarkLLM itself: Electron's
// printToPDF sets "Skia/PDF" and "Chromium" and offers no way to change them. The EU AI Act (Article 50(2)) asks for
// a machine-readable marking of AI-generated content, so the exported PDF says "AI-generated" in its properties.
//
// No library: the change is a standard incremental update (ISO 32000-1, 7.5.6). The bytes of the printed PDF stay as
// they are; a new information dictionary, a short cross-reference section and a trailer that points to it (and,
// with /Prev, to the old one) are appended. Every PDF reader reads the newest trailer.
// Chromium writes a classic cross-reference table; a PDF with a cross-reference stream is left unchanged.

// the keys of the old information dictionary that are kept when not given anew
const KEEP = ['Title', 'Author', 'Subject', 'CreationDate', 'ModDate', 'Producer', 'Creator', 'Keywords'];
// a PDF string: (literal) with escapes, or <hex> (also UTF-16BE with a byte order mark for other characters)
const STRING_TOKEN = String.raw`(\((?:\\[\s\S]|[^\\()])*\)|<[0-9A-Fa-f\s]*>)`;

/** A text as a PDF string: printable ASCII as a literal string, anything else as UTF-16BE hex with a byte order mark. */
function pdfString(text) {
  const s = String(text == null ? '' : text);
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/[\\()]/g, '\\$&')})`;
  const be = Buffer.from(s, 'utf16le');
  be.swap16();
  return `<FEFF${be.toString('hex').toUpperCase()}>`;
}

/** The text of a PDF string token (for tests and for reading the information back). */
function decodePdfString(token) {
  if (!token) return '';
  if (token.startsWith('<')) {
    const hex = token.slice(1, -1).replace(/\s+/g, '');
    const bytes = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      const le = Buffer.from(bytes.subarray(2));
      le.swap16();
      return le.toString('utf16le');
    }
    return bytes.toString('latin1');
  }
  return token.slice(1, -1).replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e) => {
    const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
    return e in map ? map[e] : String.fromCharCode(parseInt(e, 8));
  });
}

function lastMatch(re, text) {
  let m;
  let last = null;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  while ((m = g.exec(text))) last = m;
  return last;
}

/** The newest trailer: { offset of the xref section, dictionary text }, or null when there is none to read. */
function lastTrailer(text) {
  const sx = lastMatch(/startxref\s+(\d+)\s+%%EOF/, text);
  if (!sx) return null;
  const xref = Number(sx[1]);
  if (text.slice(xref, xref + 4) !== 'xref') return null; // a cross-reference stream (not written by Chromium)
  const at = text.indexOf('trailer', xref);
  if (at < 0 || at > sx.index) return null;
  const dict = text.slice(at, sx.index);
  return { xref, dict };
}

/** The entries of an object's dictionary ("12 0 obj << ... >> endobj"), the newest definition. */
function objectDict(text, num, gen) {
  const m = lastMatch(new RegExp(String.raw`(?:^|[\s>])${num}\s+${gen}\s+obj\s*<<([\s\S]*?)>>\s*endobj`), text);
  return m ? m[1] : '';
}

function infoRef(dict) {
  const m = /\/Info\s+(\d+)\s+(\d+)\s+R/.exec(dict);
  return m ? [m[1], m[2]] : null;
}

/** The document information of a PDF as { Title, Producer, ... } (texts), {} when it has none. */
function readPdfInfo(pdf) {
  const text = Buffer.from(pdf).toString('latin1');
  const tr = lastTrailer(text);
  const ref = tr && infoRef(tr.dict);
  if (!ref) return {};
  const body = objectDict(text, ref[0], ref[1]);
  const out = {};
  const re = new RegExp(String.raw`/(\w+)\s*${STRING_TOKEN}`, 'g');
  let m;
  while ((m = re.exec(body))) out[m[1]] = decodePdfString(m[2]);
  return out;
}

/**
 * The PDF with a new document information dictionary: the old entries (title, dates ...) are kept, the given ones
 * are set. info: { Producer, Creator, Keywords, ... } (texts). Returns the original bytes when the file cannot be
 * updated safely (no classic trailer).
 */
function setPdfInfo(pdf, info) {
  const buf = Buffer.from(pdf);
  const text = buf.toString('latin1');
  const tr = lastTrailer(text);
  if (!tr) return buf;
  const size = /\/Size\s+(\d+)/.exec(tr.dict);
  const root = /\/Root\s+(\d+\s+\d+\s+R)/.exec(tr.dict);
  if (!size || !root) return buf;
  const id = /\/ID\s*\[[^\]]*\]/.exec(tr.dict);

  const entries = {};
  const ref = infoRef(tr.dict);
  if (ref) {
    const body = objectDict(text, ref[0], ref[1]);
    for (const key of KEEP) {
      const m = new RegExp(String.raw`/${key}\s*${STRING_TOKEN}`).exec(body);
      if (m) entries[key] = m[1];
    }
  }
  for (const [key, value] of Object.entries(info || {})) {
    if (/^[A-Za-z]+$/.test(key) && value != null) entries[key] = pdfString(value);
  }

  const num = Number(size[1]);
  const dict = Object.entries(entries).map(([k, v]) => `/${k} ${v}`).join(' ');
  const obj = `\n${num} 0 obj\n<< ${dict} >>\nendobj\n`;
  const objOffset = buf.length + 1;
  const xrefOffset = buf.length + Buffer.byteLength(obj, 'latin1');
  const tail = `xref\n${num} 1\n${String(objOffset).padStart(10, '0')} 00000 n \n`
    + `trailer\n<< /Size ${num + 1} /Root ${root[1]} /Info ${num} 0 R /Prev ${tr.xref}${id ? ` ${id[0]}` : ''} >>\n`
    + `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.concat([buf, Buffer.from(obj + tail, 'latin1')]);
}

module.exports = { setPdfInfo, readPdfInfo, pdfString, decodePdfString };
