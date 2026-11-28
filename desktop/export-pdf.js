// Chats and answers as PDF (docs/roadmap-2026-12.md, R1): the chat page builds a printable HTML page, this file
// prints it with Electron's own PDF printer and asks where to save it. No new library and no network: the page is
// loaded in a hidden window without scripts, and its session refuses every request that is not the page itself.
const { app, BrowserWindow, dialog, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { t } = require('./i18n');
const { setPdfInfo } = require('./pdf-info');

// EU AI Act, Article 50: the exported PDF is marked as AI-generated, in its document information (for machines) and
// with a line at the foot of every page (for people). The page sends that line in the user's language.
const AI_NOTE = 'Created with AI assistance (StarkLLM)';

const unescapeHtml = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The AI note of the page (meta starkllm-ai-note), else the English one. */
function aiNoteOf(html) {
  const m = /<meta name="starkllm-ai-note" content="([^"]*)">/.exec(String(html));
  const note = m ? unescapeHtml(m[1]).trim() : '';
  return note.slice(0, 200) || AI_NOTE;
}

/** The page for the printer and the foot of every page: the note goes into the page footer, so the one line at the
 * end of the page (for the browser's print dialog) is left out here, else the last page would have it twice. */
function withPageFooter(html) {
  const note = aiNoteOf(html);
  return {
    html: String(html).replace(/<footer class="ai-note">[\s\S]*?<\/footer>/, ''),
    footerTemplate: `<div style="width:100%;text-align:center;font-size:8px;color:#777;font-family:'Segoe UI',Arial,sans-serif">${escapeHtml(note)}</div>`,
  };
}

/** The document information of an exported PDF (machine-readable marking of AI-generated content). */
function aiPdfInfo(version) {
  const generator = `StarkLLM${version ? ` ${version}` : ''} (AI-generated content)`;
  return { Producer: generator, Creator: generator, Keywords: 'AI-generated', Subject: 'AI-generated content, created with StarkLLM' };
}

const PARTITION = 'starkllm-export'; // in memory only: nothing is kept
let ready = false;

function exportSession() {
  const ses = session.fromPartition(PARTITION);
  if (!ready) {
    ready = true;
    // the page is a local file; pictures or fonts from the internet are not loaded
    ses.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !/^(file|data|about|blob):/i.test(details.url) }));
    ses.setPermissionRequestHandler((_wc, _p, callback) => callback(false));
  }
  return ses;
}

// a file name without characters Windows does not allow
function safeName(name) {
  const base = String(name || 'StarkLLM').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'StarkLLM';
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
}

async function htmlToPdf(html) {
  const tmp = path.join(os.tmpdir(), `starkllm-export-${process.pid}-${Date.now()}.html`);
  const page = withPageFooter(html);
  fs.writeFileSync(tmp, page.html, 'utf8');
  const win = new BrowserWindow({
    show: false,
    webPreferences: { session: exportSession(), javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({
      printBackground: true, pageSize: 'A4', margins: { marginType: 'default' },
      displayHeaderFooter: true, headerTemplate: '<span></span>', footerTemplate: page.footerTemplate,
    });
    return setPdfInfo(pdf, aiPdfInfo(app.getVersion()));
  } finally {
    win.destroy();
    fs.rm(tmp, { force: true }, () => {});
  }
}

const SAVE_TYPES = { docx: 'Word', md: 'Markdown', html: 'HTML', json: 'JSON', txt: 'Text', zip: 'ZIP' };
// the tax advisor package (a year of letters) may be larger than a chat export
const MAX_SAVE = { zip: 500 * 1024 * 1024 };

function register(ipcMain, { fromApp }) {
  // a file the chat page made (Word, Markdown ...): the save dialog of the app, then written where the user chose
  ipcMain.handle('export:save', async (event, name, data) => {
    if (!fromApp(event)) return { error: 'not-allowed' };
    const ext = String(name || '').split('.').pop().toLowerCase();
    if (!SAVE_TYPES[ext] || !(data instanceof Uint8Array) || data.length > (MAX_SAVE[ext] || 100 * 1024 * 1024)) return { error: 'invalid' };
    try {
      const parent = BrowserWindow.fromWebContents(event.sender);
      const base = String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 120) || `StarkLLM.${ext}`;
      const r = await dialog.showSaveDialog(parent, {
        title: t('Save'),
        defaultPath: path.join(app.getPath('documents'), base), // not the folder of the last dialog (the terminal folder)
        filters: [{ name: SAVE_TYPES[ext], extensions: [ext] }],
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      fs.writeFileSync(r.filePath, Buffer.from(data));
      return { ok: true, name: path.basename(r.filePath) };
    } catch (e) {
      return { error: 'failed', message: e.message };
    }
  });

  ipcMain.handle('export:pdf', async (event, html, name) => {
    if (!fromApp(event)) return { error: 'not-allowed' };
    if (typeof html !== 'string' || !html || html.length > 30 * 1024 * 1024) return { error: 'invalid' };
    try {
      const pdf = await htmlToPdf(html);
      const parent = BrowserWindow.fromWebContents(event.sender);
      const r = await dialog.showSaveDialog(parent, {
        title: t('Save as PDF'),
        defaultPath: path.join(app.getPath('documents'), safeName(name)),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      fs.writeFileSync(r.filePath, pdf);
      return { ok: true, name: path.basename(r.filePath) };
    } catch (e) {
      return { error: 'failed', message: e.message };
    }
  });
}

module.exports = { register, safeName, htmlToPdf, withPageFooter, aiNoteOf, aiPdfInfo, AI_NOTE };
