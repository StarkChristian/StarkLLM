// Checks for files that a phone uploads. Everything here treats the file as untrusted input:
// the PC never opens, unpacks or executes it; it only checks name, size, type and hash, and
// hands the bytes to the engine's normal ingestion after the user confirmed.
import { BLAKE2s } from 'salty-crypto';
import { fromUtf8, toHex } from './bytes.js';

export const UPLOAD_CHUNK_BYTES = 32 * 1024;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOAD_CHUNKS = Math.ceil(MAX_UPLOAD_BYTES / UPLOAD_CHUNK_BYTES);

/** Extensions StarkLLM can ingest as documents. Anything else is refused, whatever the content. */
export const DEFAULT_UPLOAD_EXTENSIONS = Object.freeze(['pdf', 'txt', 'md', 'docx', 'png', 'jpg', 'jpeg']);

const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// letters and digits of any script (German umlauts, Cyrillic, Greek, ...), space and . _ - ( )
const NAME_RE = /^[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M} ._()+-]*$/u;

/**
 * @param {string} name file name as sent by the phone (no path)
 * @param {readonly string[]} allowed
 * @returns {{ ok: true, ext: string, name: string } | { ok: false, reason: string }}
 */
export function checkFileName(name, allowed = DEFAULT_UPLOAD_EXTENSIONS) {
  if (typeof name !== 'string' || name.length < 3 || name.length > 120) return { ok: false, reason: 'The file name has an invalid length.' };
  if (name !== name.normalize('NFC')) return { ok: false, reason: 'The file name is not normalised.' };
  if (!NAME_RE.test(name) || name.includes('..') || /[. ]$/.test(name)) return { ok: false, reason: 'The file name contains characters that are not allowed.' };
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { ok: false, reason: 'The file name has no extension.' };
  const ext = name.slice(dot + 1).toLowerCase();
  if (!allowed.includes(ext)) return { ok: false, reason: `Files of type .${ext.slice(0, 10)} are not accepted.` };
  // a double extension such as "report.pdf.exe" can only end in an allowed one, but
  // "x.exe.pdf" style names are refused too: the stem must not end in an executable extension
  const stem = name.slice(0, dot);
  if (RESERVED_WINDOWS.test(stem.split('.')[0])) return { ok: false, reason: 'This file name is reserved.' };
  if (/\.(exe|dll|bat|cmd|com|msi|scr|ps1|vbs|js|jar|sh|app|apk|ipa|lnk|hta)$/i.test(stem)) return { ok: false, reason: 'The file name looks like an executable.' };
  return { ok: true, ext, name };
}

const startsWith = (b, sig, at = 0) => sig.every((v, i) => b[at + i] === v);

function includesAscii(b, text) {
  const t = [...text].map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i + t.length <= b.length; i++) {
    for (let j = 0; j < t.length; j++) if (b[i + j] !== t[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Checks that the content matches the extension (magic bytes). Executables, scripts and archives
 * pretending to be documents are refused. Nothing is parsed or unpacked.
 * @param {string} ext
 * @param {Uint8Array} b
 * @returns {{ ok: true, kind: string } | { ok: false, reason: string }}
 */
export function sniffFile(ext, b) {
  const bad = (reason) => ({ ok: /** @type {const} */ (false), reason });
  if (b.length === 0) return bad('The file is empty.');
  switch (ext) {
    case 'pdf':
      return startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]) ? { ok: true, kind: 'pdf' } : bad('The content is not a PDF file.');
    case 'png':
      return startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? { ok: true, kind: 'image' } : bad('The content is not a PNG image.');
    case 'jpg':
    case 'jpeg':
      return startsWith(b, [0xff, 0xd8, 0xff]) ? { ok: true, kind: 'image' } : bad('The content is not a JPEG image.');
    case 'docx':
      // a ZIP container that has the Word parts; it is not unpacked here
      return startsWith(b, [0x50, 0x4b, 0x03, 0x04]) && includesAscii(b.subarray(0, Math.min(b.length, 65536)), '[Content_Types].xml')
        ? { ok: true, kind: 'docx' }
        : bad('The content is not a Word document.');
    case 'txt':
    case 'md': {
      if (b.length > 5 * 1024 * 1024) return bad('Text files may be at most 5 MiB.');
      let text;
      try {
        text = fromUtf8(b);
      } catch {
        return bad('The text file is not valid UTF-8.');
      }
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) return bad('The text file contains control characters.');
      if (text.startsWith('#!') || text.startsWith('MZ') || text.startsWith('<?php') || /^\s*<script/i.test(text)) return bad('The text file looks like a script or program.');
      return { ok: true, kind: 'text' };
    }
    default:
      return bad('This file type is not accepted.');
  }
}

/** BLAKE2s-256 of the whole file as 64 hex characters (the hash the phone announces). */
export function fileHash(bytes) {
  const h = new BLAKE2s();
  for (let i = 0; i < bytes.length; i += 65536) h.update(bytes.subarray(i, Math.min(i + 65536, bytes.length)));
  return toHex(h.final());
}
