/**
 * Chat Export Utility
 * Handles exporting chat history to Markdown, JSON, HTML, or Plain Text.
 * Every format is marked as AI-generated (EU AI Act, Article 50): for machines (Markdown front matter, JSON fields,
 * HTML meta tags) and for people (a short note in the user's language).
 * No import of the i18n module here: the page passes the locale and the note, so node can test this file.
 */

export const AI_NOTE = 'Created with AI assistance (StarkLLM)';
export const GENERATOR = 'StarkLLM';

const escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** -> { content, ext, mimeType } of a chat export. options: { locale, aiNote, now } */
export function buildChatExport(messages, chatTitle, format = 'md', options = {}) {
  const locale = options.locale || undefined;
  const aiNote = options.aiNote || AI_NOTE;
  const exportDate = (options.now || new Date()).toLocaleString(locale);
  const UI_LOCALE = locale;

  let content = '';
  let ext = format;
  let mimeType = 'text/plain';

  if (format === 'json') {
    ext = 'json';
    mimeType = 'application/json';
    content = JSON.stringify({
      title: chatTitle,
      exported_at: exportDate,
      ai_generated: true,
      generator: GENERATOR,
      ai_note: aiNote,
      messages: messages.filter(m => m.role !== 'system')
    }, null, 2);
  } else if (format === 'html') {
    ext = 'html';
    mimeType = 'text/html';
    const renderedMessages = messages.filter(m => m.role !== 'system').map(msg => {
      const isUser = msg.role === 'user';
      const roleLabel = isUser ? 'User' : 'StarkLLM Assistant';
      const roleBg = isUser ? '#6366f1' : '#10b981';
      const msgBg = isUser ? 'rgba(99, 102, 241, 0.08)' : 'rgba(255, 255, 255, 0.03)';
      const safeContent = (msg.content || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br/>');
      const timeStr = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString(UI_LOCALE) : '';

      return `
      <div class="message-card" style="background: ${msgBg}; border-left: 4px solid ${roleBg};">
        <div class="message-header">
          <span class="role-badge" style="background: ${roleBg};">${roleLabel}</span>
          <span class="timestamp">${timeStr}</span>
        </div>
        <div class="message-body">${safeContent}</div>
      </div>`;
    }).join('\n');

    content = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="generator" content="${GENERATOR} (AI-generated content)">
  <meta name="ai-generated" content="true">
  <meta name="keywords" content="AI-generated">
  <title>${escHtml(chatTitle)} - StarkLLM Export</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      line-height: 1.6;
      margin: 0;
      padding: 40px 20px;
    }
    .container {
      max-width: 800px;
      margin: 0 auto;
    }
    header {
      border-bottom: 1px solid rgba(255,255,255,0.1);
      padding-bottom: 20px;
      margin-bottom: 30px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    h1 { margin: 0 0 8px 0; font-size: 1.8rem; color: #fff; }
    .meta { font-size: 0.85rem; color: #94a3b8; }
    .print-btn {
      background: #6366f1;
      color: #fff;
      border: none;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-weight: 500;
    }
    .print-btn:hover { background: #4f46e5; }
    .message-card {
      border-radius: 8px;
      padding: 16px 20px;
      margin-bottom: 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    }
    .message-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }
    .role-badge {
      color: #fff;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .timestamp { font-size: 0.75rem; color: #94a3b8; }
    .message-body { font-size: 1rem; word-break: break-word; }
    .ai-note { font-size: 0.75rem; color: #94a3b8; text-align: center; margin-top: 24px; }
    @media print {
      body { background: #fff; color: #000; padding: 0; }
      .print-btn { display: none; }
      .message-card { border: 1px solid #e2e8f0; box-shadow: none; background: #fff !important; }
      .role-badge { color: #000; border: 1px solid #000; background: transparent !important; }
      .timestamp { color: #666; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>${escHtml(chatTitle)}</h1>
        <div class="meta">Exported from StarkLLM on ${exportDate}</div>
      </div>
      <button class="print-btn" onclick="window.print()">🖨️ Print / Save to PDF</button>
    </header>
    ${renderedMessages}
    <footer class="ai-note">${escHtml(aiNote)}</footer>
  </div>
</body>
</html>`;
  } else if (format === 'md') {
    ext = 'md';
    mimeType = 'text/markdown';
    // front matter for machines (a JSON string is a valid YAML string), the note for people
    content += `---\ntitle: ${JSON.stringify(String(chatTitle))}\ngenerator: ${GENERATOR}\nai_generated: true\n---\n\n`;
    content += `# ${chatTitle}\n\n`;
    content += `> Exported from StarkLLM on ${exportDate}\n>\n> ${aiNote}\n\n---\n\n`;

    messages.forEach(msg => {
      if (msg.role === 'system') return;

      const role = msg.role === 'user' ? '🧑 **User**' : '🤖 **Assistant**';
      const timestamp = msg.timestamp
        ? new Date(msg.timestamp).toLocaleTimeString(UI_LOCALE, { hour: '2-digit', minute: '2-digit' })
        : '';

      content += `### ${role}${timestamp ? `  ·  ${timestamp}` : ''}\n\n`;
      content += `${msg.content}\n\n`;

      if (msg.role === 'assistant') {
        const sources = [];
        if (msg.wsSources?.length) sources.push(`📂 Workspace: ${msg.wsSources.join(', ')}`);
        if (msg.kbSources?.length) sources.push(`📚 Knowledge Base: ${msg.kbSources.join(', ')}`);
        if (msg.webSources?.length) {
          msg.webSources.forEach(src => {
            const title = typeof src === 'string' ? src : src.title;
            const url = typeof src === 'string' ? '' : src.url;
            sources.push(url ? `🌐 [${title}](${url})` : `🌐 ${title}`);
          });
        }
        if (sources.length > 0) {
          content += `> **Sources:**\n`;
          sources.forEach(s => { content += `> - ${s}\n`; });
          content += '\n';
        }
      }

      content += `---\n\n`;
    });
  } else {
    // Plain text format
    ext = 'txt';
    mimeType = 'text/plain';
    content += `${chatTitle}\n`;
    content += `Exported from StarkLLM on ${exportDate}\n`;
    content += `${aiNote}\n`;
    content += `ai_generated: true\n`;
    content += `${'='.repeat(50)}\n\n`;

    messages.forEach(msg => {
      if (msg.role === 'system') return;

      const role = msg.role === 'user' ? 'User' : 'Assistant';
      const timestamp = msg.timestamp
        ? new Date(msg.timestamp).toLocaleTimeString(UI_LOCALE, { hour: '2-digit', minute: '2-digit' })
        : '';

      content += `[${role}]${timestamp ? `  ${timestamp}` : ''}\n`;
      content += `${msg.content}\n`;

      if (msg.role === 'assistant') {
        const sources = [];
        if (msg.wsSources?.length) sources.push(`Workspace: ${msg.wsSources.join(', ')}`);
        if (msg.kbSources?.length) sources.push(`Knowledge Base: ${msg.kbSources.join(', ')}`);
        if (msg.webSources?.length) {
          msg.webSources.forEach(src => {
            const title = typeof src === 'string' ? src : src.title;
            const url = typeof src === 'string' ? '' : src.url;
            sources.push(url ? `${title} (${url})` : title);
          });
        }
        if (sources.length > 0) {
          content += `\nSources:\n`;
          sources.forEach(s => { content += `  - ${s}\n`; });
        }
      }

      content += `${'-'.repeat(40)}\n\n`;
    });
  }

  return { content, ext, mimeType };
}

/** options: { locale, aiNote } (the page passes them in the user's language) */
export function exportChat(messages, chats, activeChatId, format = 'md', options = {}) {
  if (!messages || messages.length === 0) return;

  const activeChat = chats.find(c => c.id === activeChatId);
  const chatTitle = activeChat?.title || 'StarkLLM Chat';
  const { content, ext, mimeType } = buildChatExport(messages, chatTitle, format, options);

  const safeTitle = chatTitle.replace(/[^a-zA-Z0-9_\- ]/g, '').trim().replace(/\s+/g, '_');
  const filename = `${safeTitle}_${new Date().toISOString().slice(0, 10)}.${ext}`;

  const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
