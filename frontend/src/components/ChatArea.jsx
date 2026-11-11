import React, { useEffect, useRef, useState, useCallback } from 'react';
import styles from './ChatArea.module.css';
import { 
  User, Bot, Volume2, Square, Database, Copy, Check, Globe, RefreshCw, 
  Edit2, Download, FileText, AlertTriangle, Sparkles, Code, BookOpen, Upload, CalendarClock,
  ThumbsUp, ThumbsDown, Zap, Cloud
} from 'lucide-react';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { useToast } from './Toast';
import ToolCallCard from './ToolCallCard';
import { serverDate } from '../utils/time';
import { citedSources, readableSource } from '../utils/sources';
import SourcesModal from './SourcesModal';
import DocumentViewerModal from './DocumentViewerModal';
import DocumentWarnings from './DocumentWarnings';
import { UI_LOCALE } from '../utils/locale';
import { t } from '../i18n';
import { UPLOAD_ACCEPT } from '../utils/uploadTypes';
import { blockRemoteImages, escapeHtml } from '../utils/markdown';

// The start page of a chat: what StarkLLM is for. The first card opens the file picker, the others ask about the
// documents of this workspace.
const STARTER_PROMPTS = [
  {
    icon: Upload,
    title: t('Add a letter or document'),
    desc: t('A photo, a scan or a file: StarkLLM reads it on this PC'),
    upload: true
  },
  {
    icon: FileText,
    title: t('What does this letter want from me?'),
    desc: t('Sender, request and deadline, in simple words'),
    prompt: t('Explain my newest document in simple words: who sent it, what it wants from me, and by when. Name the page you read it on.'),
    // with the newest file's name, so the model does not have to guess which document is meant
    promptFor: (name) => t('Explain the document "{name}" in simple words: who sent it, what it wants from me, and by when.', { name })
  },
  {
    icon: CalendarClock,
    title: t('My deadlines and payments'),
    desc: t('Every date and amount in my documents'),
    prompt: t('List every deadline, due date and payment in my documents, sorted by date, with the amount and the document it comes from.')
  },
  {
    icon: BookOpen,
    title: t('Overview of my documents'),
    desc: t('What each document is about, by sender'),
    prompt: t('Give me a short overview of my documents: what each one is about, grouped by sender.')
  }
];

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  highlight: function (str, lang) {
    const validLang = lang && hljs.getLanguage(lang) ? lang : '';
    const displayLang = validLang || 'code';
    let highlightedCode = '';
    
    if (validLang) {
      try {
        highlightedCode = hljs.highlight(str, { language: validLang, ignoreIllegals: true }).value;
      } catch (__) {
        highlightedCode = md.utils.escapeHtml(str);
      }
    } else {
      highlightedCode = md.utils.escapeHtml(str);
    }

    const encoded = encodeURIComponent(str);
    const isRunnable = ['python', 'py', 'python3'].includes((validLang || '').toLowerCase());
    const runBtn = isRunnable ? `<button class="run-code-btn" data-lang="${validLang}" data-code="${encoded}" title="${escapeHtml(t('Run code in local Python sandbox'))}"><svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>${escapeHtml(t('Run'))}</span></button>` : '';

    return `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-block-lang">${displayLang}</span><div class="code-block-actions">${runBtn}<button class="copy-code-btn" data-code="${encoded}" title="${escapeHtml(t('Copy code'))}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>${escapeHtml(t('Copy'))}</span></button></div></div><pre><code class="hljs ${validLang}">${highlightedCode}</code></pre></div>`;
  }
});
// Only real links: with fuzzy links on, a file name like 'card.md' became http://card.md (a Moldovan domain).
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
blockRemoteImages(md);


// ---------------------------------------------------------------------------
// Robust language detector — no external library needed.
// ---------------------------------------------------------------------------

const GERMAN_WORDS = [
  'ich', 'du', 'er', 'sie', 'es', 'wir', 'ihr',
  'mein', 'dein', 'sein', 'unser',
  'der', 'die', 'das', 'den', 'dem', 'des',
  'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'ist', 'sind', 'war', 'waren', 'wird', 'werden', 'wurde', 'wurden',
  'haben', 'hat', 'hatte', 'kann', 'können', 'muss', 'müssen', 'soll', 'sollen',
  'und', 'nicht', 'oder', 'aber', 'auch', 'wenn', 'dann', 'dass', 'weil',
  'mit', 'von', 'zu', 'auf', 'bei', 'nach', 'seit', 'für',
  'hier', 'dort', 'bitte', 'danke', 'dank', 'vielen', 'ja', 'nein', 'doch', 'hallo',
  'heute', 'immer', 'jetzt', 'schon', 'sehr', 'wie', 'was', 'wer', 'wo', 'warum'
];

const ENGLISH_WORDS = [
  'the', 'of', 'to', 'and', 'a', 'in', 'is', 'it', 'you', 'that',
  'he', 'was', 'for', 'on', 'are', 'as', 'with', 'his', 'they', 'i',
  'at', 'be', 'this', 'have', 'from', 'or', 'one', 'had', 'by', 'word',
  'but', 'not', 'what', 'all', 'were', 'we', 'when', 'your', 'can',
  'said', 'there', 'use', 'an', 'each', 'which', 'she', 'do', 'how',
  'their', 'if', 'would', 'about', 'who', 'get', 'go', 'me', 'my', 'them',
  'your', 'youre', 'theyre', 'please', 'thanks'
];

const GERMAN_UMLAUT_RE = /[äöüÄÖÜß]/;

function detectVoice(text) {
  if (GERMAN_UMLAUT_RE.test(text)) return 'de_DE-thorsten-medium';

  const tokens = text.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 'en_US-lessac-medium';

  let deScore = 0;
  let enScore = 0;

  for (const token of tokens) {
    if (GERMAN_WORDS.includes(token)) deScore++;
    if (ENGLISH_WORDS.includes(token)) enScore++;
  }

  if (enScore >= deScore) return 'en_US-lessac-medium';
  if (deScore === 0) return 'en_US-lessac-medium';

  const ratio = deScore / tokens.length;
  return ratio >= 0.20 ? 'de_DE-thorsten-medium' : 'en_US-lessac-medium';
}

function isRTL(text) {
  if (!text) return false;
  const rtlRegex = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g;
  const ltrMatches = text.match(/[a-zA-Z]/g) || [];
  const rtlMatches = text.match(rtlRegex) || [];
  return rtlMatches.length > 0 && rtlMatches.length >= ltrMatches.length;
}

function parseContentWithToolCalls(content) {
  if (!content || typeof content !== 'string') return [{ type: 'text', text: '' }];

  // Tight fence: ```tool_call\n{...}\n``` or <tool_call>{...}</tool_call>
  const toolRegex = /(?:```(?:tool_call)\s*\n?([\s\S]*?)\n?```|<tool_call>\s*([\s\S]*?)\s*<\/tool_call>)/;
  const match = content.match(toolRegex);

  if (!match) {
    return [{ type: 'text', text: content }];
  }

  const rawJson = (match[1] || match[2] || '').trim();
  const index = match.index;
  const matchLength = match[0].length;

  const before = content.slice(0, index);
  const after = content.slice(index + matchLength);

  let parsed = null;
  let isBroken = false;

  if (!rawJson || (!rawJson.startsWith('{') && !rawJson.endsWith('}'))) {
    isBroken = true;
  } else {
    try {
      parsed = JSON.parse(rawJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.name || typeof parsed.name !== 'string') {
        isBroken = true;
      }
    } catch {
      isBroken = true;
    }
  }

  const segments = [];
  if (before) segments.push({ type: 'text', text: before });
  segments.push({
    type: 'tool_call',
    raw: rawJson,
    parsed: parsed,
    isBroken: isBroken
  });
  if (after) {
    segments.push(...parseContentWithToolCalls(after));
  }

  return segments;
}

const ChatMessageRenderer = React.memo(({
  msg,
  i,
  isRTL,
  editingIndex,
  editText,
  setEditText,
  handleCancelEdit,
  handleSaveEdit,
  copiedIndex,
  handleCopy,
  handleStartEdit,
  onEdit,
  onRegenerate,
  playingIndex,
  playAudio,
  onRetryMessage,
  workspaceId,
  token,
  onSendToolResult,
  onFeedback,
  onInspectSources
}) => {
  const contentSegments = msg.role === 'assistant' ? parseContentWithToolCalls(msg.content) : null;
  const [localFeedback, setLocalFeedback] = useState(msg.feedback || null);

  const handleFeedback = useCallback(async (value) => {
    if (!msg.id || !token) return;
    const newVal = localFeedback === value ? null : value; // toggle off
    setLocalFeedback(newVal);
    try {
      await fetch(`/api/v1/chat/message/${msg.id}/feedback`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ feedback: newVal }),
      });
      if (onFeedback) onFeedback(msg.id, newVal);
    } catch (e) {
      console.error('Feedback error', e);
    }
  }, [msg.id, token, localFeedback, onFeedback]);

  const shown = citedSources(msg);

  return (
    <div className={`${styles.messageWrapper} ${msg.role === 'user' ? styles.user : ''} ${msg.role === 'system' ? styles.system : ''}`}>
      {msg.role !== 'system' && (
        <div className={`${styles.avatar} ${msg.role === 'assistant' ? styles.assistantAvatar : ''}`}>
          {msg.role === 'user' ? <User size={20} /> : <Bot size={20} color="white" />}
        </div>
      )}
      
      <div 
        className={`${styles.content} ${msg.role !== 'system' && isRTL(msg.content) ? styles.rtl : ''}`} 
        style={msg.role === 'system' ? { fontStyle: 'italic', color: 'var(--text-secondary)', background: 'transparent', border: 'none', margin: '0 auto' } : {}}
      >
        {msg.role !== 'system' ? (
          editingIndex === i ? (
            <div className={styles.editContainer}>
              <textarea 
                className={styles.editInput} 
                value={editText} 
                onChange={e => setEditText(e.target.value)}
                autoFocus
                rows={Math.min(10, editText.split('\n').length + 1)}
              />
              <div className={styles.editActions}>
                <button className={styles.editCancelBtn} onClick={handleCancelEdit}>{t('Cancel')}</button>
                <button className={styles.editSaveBtn} onClick={() => handleSaveEdit(i)}>{t('Save & Submit')}</button>
              </div>
            </div>
          ) : msg.role === 'assistant' && msg.content === '' ? (
            <div className={styles.thinking}>
              <span className={styles.dot}></span>
              <span className={styles.dot}></span>
              <span className={styles.dot}></span>
            </div>
          ) : (
            <>
              {msg.role === 'assistant' && msg.warnings && msg.warnings.length > 0 && (
                <DocumentWarnings warnings={msg.warnings} />
              )}
              {contentSegments ? (
                contentSegments.map((seg, sIdx) => {
                  if (seg.type === 'tool_call') {
                    return (
                      <ToolCallCard
                        key={sIdx}
                        parsedCall={seg.parsed}
                        isBrokenJson={seg.isBroken}
                        rawCallText={seg.raw}
                        workspaceId={workspaceId}
                        token={token}
                        onSendToolResult={onSendToolResult}
                      />
                    );
                  }
                  return seg.text ? (
                    <div key={sIdx} dangerouslySetInnerHTML={{ __html: md.render(seg.text) }} />
                  ) : null;
                })
              ) : (
                <div dangerouslySetInnerHTML={{ __html: md.render(msg.content) }} />
              )}

              {msg.role === 'assistant' && ((shown.ws && shown.ws.length > 0) || (shown.kb && shown.kb.length > 0) || (msg.webSources && msg.webSources.length > 0) || msg.cloudHost) && (
                <div className={styles.sourcesContainer}>
                  {msg.cloudHost && (
                    <div className={styles.sourceGroup} title={t('This answer was generated by a cloud model provider, not on this PC')}>
                      <Cloud size={11} className={styles.sourceIcon} />
                      <span>{t('Answered by {host} (cloud)', { host: msg.cloudHost })}</span>
                    </div>
                  )}
                  {shown.ws && shown.ws.length > 0 && (
                    <button
                      type="button"
                      className={styles.sourceGroup}
                      title={t('Show the passages this answer is based on')}
                      onClick={() => onInspectSources && onInspectSources(msg, shown.ws)}
                    >
                      <Database size={11} className={styles.sourceIcon} />
                      <span>{t('Documents')}: {shown.ws.map((l) => readableSource(l)).join(' | ')}</span>
                    </button>
                  )}
                  {shown.kb && shown.kb.length > 0 && (
                    <button
                      type="button"
                      className={styles.sourceGroup}
                      title={t('Show the passages this answer is based on')}
                      onClick={() => onInspectSources && onInspectSources(msg, shown.kb)}
                    >
                      <Database size={11} className={styles.sourceIcon} />
                      <span>{t('Knowledge base')}: {shown.kb.map((l) => readableSource(l)).join(' | ')}</span>
                    </button>
                  )}
                  {msg.webSources && msg.webSources.length > 0 && (
                    msg.webSources.map((src, si) => {
                      const title = typeof src === 'string' ? src : src.title;
                      const url = typeof src === 'string' ? '' : src.url;
                      let domain = '';
                      try { domain = new URL(url).hostname.replace('www.', ''); } catch {}
                      return url ? (
                        <a
                          key={si}
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={styles.webSourceLink}
                          title={url}
                        >
                          <Globe size={11} />
                          <span className={styles.webSourceTitle}>{title}</span>
                          {domain && <span className={styles.webSourceDomain}>{domain}</span>}
                        </a>
                      ) : (
                        <div key={si} className={styles.sourceGroup} style={{ backgroundColor: 'rgba(16, 185, 129, 0.06)', borderColor: 'rgba(16, 185, 129, 0.2)', color: 'var(--success)' }}>
                          <Globe size={11} style={{ color: 'var(--success)' }} />
                          <span>{title}</span>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </>
          )
        ) : (
          msg.content
        )}

        {msg.isError && (
          <div className={styles.chatErrorBox}>
            <AlertTriangle size={14} className={styles.chatErrorIcon} />
            <span style={{flex: 1}}>{msg.content}</span>
            {onRetryMessage && msg.failedText && (
              <button 
                className={styles.chatRetryBtn} 
                onClick={() => onRetryMessage(msg.failedText)}
              >
                <RefreshCw size={12} /> {t('Retry')}
              </button>
            )}
          </div>
        )}
        
        {msg.role !== 'system' && !msg.isError && msg.content.length > 0 && (
          <div className={styles.messageActions}>
              <button 
                className={`${styles.actionBtn} ${copiedIndex === i ? styles.success : ''}`}
                onClick={() => handleCopy(msg.content, i)}
                title={t('Copy to clipboard')}
              >
                {copiedIndex === i ? <Check size={14} /> : <Copy size={14} />}
              </button>
              
              {msg.role === 'user' && editingIndex !== i && onEdit && (
                <button 
                  className={styles.actionBtn} 
                  onClick={() => handleStartEdit(i, msg.content)}
                  title={t('Edit message')}
                >
                  <Edit2 size={14} />
                </button>
              )}

              {msg.role === 'assistant' && onRegenerate && (
                <button 
                  className={styles.actionBtn} 
                  onClick={() => onRegenerate(i)}
                  title={t('Regenerate response')}
                >
                  <RefreshCw size={14} />
                </button>
              )}

              {msg.role === 'assistant' && msg.content.length > 0 && (
                <>
                  <button
                    className={`${styles.actionBtn} ${localFeedback === 'positive' ? styles.feedbackActive : ''}`}
                    onClick={() => handleFeedback('positive')}
                    title={t('Good response')}
                    style={localFeedback === 'positive' ? { color: 'var(--success)', background: 'rgba(16,185,129,0.12)' } : {}}
                  >
                    <ThumbsUp size={14} />
                  </button>
                  <button
                    className={`${styles.actionBtn} ${localFeedback === 'negative' ? styles.feedbackActive : ''}`}
                    onClick={() => handleFeedback('negative')}
                    title={t('Bad response')}
                    style={localFeedback === 'negative' ? { color: 'var(--danger)', background: 'rgba(239,68,68,0.12)' } : {}}
                  >
                    <ThumbsDown size={14} />
                  </button>
                </>
              )}
              
              {msg.role === 'assistant' && !isRTL(msg.content) && (
                <button 
                  className={`${styles.actionBtn} ${playingIndex === i ? styles.playing : ''}`} 
                  onClick={() => playAudio(msg.content, i)}
                  title={playingIndex === i ? t('Stop audio') : t('Play audio')}
                >
                  {playingIndex === i ? <Square size={14} fill="currentColor" /> : <Volume2 size={14} />}
                </button>
              )}
            </div>
          )}
        </div>
      {msg.role !== 'system' && (
        <div className={styles.metaRow}>
          {msg.timestamp && (
            <span className={styles.timestamp}>
              {serverDate(msg.timestamp).toLocaleTimeString(UI_LOCALE, { hour: '2-digit', minute: '2-digit' })}
            </span>
          )}
          {msg.speedStats && msg.role === 'assistant' && (
            <span className={styles.speedBadge} title={`Speed: ${msg.speedStats.tokPerSec} tok/s | ~${msg.speedStats.tokens} tokens generated in ${msg.speedStats.timeSec}s`}>
              <Zap size={11} className={styles.speedZap} />
              <span>{msg.speedStats.tokPerSec} tok/s</span>
              <span className={styles.speedDot}>•</span>
              <span>{msg.speedStats.tokens} tok</span>
            </span>
          )}
          {msg.role === 'assistant' && msg.content && (() => {
            const wordCount = msg.content.trim().split(/\s+/).filter(Boolean).length;
            if (wordCount < 80) return null;
            return (
              <span className={styles.speedBadge} style={{ background: 'rgba(99,102,241,0.08)', borderColor: 'rgba(99,102,241,0.2)', color: 'var(--accent-bright)' }}>
                {t('{count} words', { count: wordCount.toLocaleString(UI_LOCALE) })}
              </span>
            );
          })()}
        </div>
      )}
    </div>
  );
});

export default function ChatArea({
  messages,
  onRegenerate,
  onEdit,
  onExport,
  onSummarize,
  onRetryMessage,
  onSelectStarter,
  workspaceId,
  chatId,
  onUpload,
  newestDocument,
  token
}) {
  const toast = useToast();
  const starterFileRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const messagesEndRef = useRef(null);
  
  const [playingIndex, setPlayingIndex] = useState(null);
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [editingIndex, setEditingIndex] = useState(null);
  const [editText, setEditText] = useState("");
  const [inspectingSource, setInspectingSource] = useState(null);
  const [viewing, setViewing] = useState(null);

  const loadEvidence = useCallback(async (msg) => {
    if (!chatId || !token) return null;
    const res = await fetch(`/api/v1/chat/session/${chatId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const data = await res.json();
    const answers = (data.messages || []).filter((m) => m.role === 'assistant' && m.sources && m.sources.evidence);
    const same = answers.filter((m) => (m.content || '').trim() === (msg.content || '').trim());
    const match = same[same.length - 1] || answers[answers.length - 1];
    return match ? match.sources.evidence : null;
  }, [chatId, token]);
  const currentAudioRef = useRef(null);
  const activePlayIndexRef = useRef(null);

  useEffect(() => {
    const handleCopyCodeClick = (e) => {
      const btn = e.target.closest('.copy-code-btn');
      if (!btn) return;
      const encoded = btn.getAttribute('data-code');
      if (!encoded) return;
      try {
        const code = decodeURIComponent(encoded);
        navigator.clipboard.writeText(code);
        const span = btn.querySelector('span');
        if (span) {
          const originalText = span.textContent;
          span.textContent = t('Copied!');
          btn.classList.add('copied');
          setTimeout(() => {
            span.textContent = originalText;
            btn.classList.remove('copied');
          }, 2000);
        }
      } catch (err) {
        console.error('Failed to copy code snippet:', err);
      }
    };

    const handleRunCodeClick = async (e) => {
      const btn = e.target.closest('.run-code-btn');
      if (!btn) return;
      const encoded = btn.getAttribute('data-code');
      const lang = btn.getAttribute('data-lang') || 'python';
      if (!encoded) return;

      const wrapper = btn.closest('.code-block-wrapper');
      if (!wrapper) return;

      const oldOutput = wrapper.querySelector('.code-output-box');
      if (oldOutput) oldOutput.remove();

      const span = btn.querySelector('span');
      const originalText = span ? span.textContent : 'Run';
      if (span) span.textContent = t('Running...');
      btn.disabled = true;

      try {
        const code = decodeURIComponent(encoded);
        const res = await fetch('/api/v1/system/execute-code', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {})
          },
          body: JSON.stringify({ code, language: lang })
        });
        const data = await res.json();
        
        const isSuccess = data.exit_code === 0;
        const outputText = data.stdout || data.stderr || '(No output returned)';
        const execTime = data.execution_time_ms ? `${data.execution_time_ms}ms` : '0ms';

        const outputEl = document.createElement('div');
        outputEl.className = `code-output-box ${isSuccess ? 'output-success' : 'output-error'}`;
        outputEl.innerHTML = `
          <div class="code-output-header">
            <div class="code-output-title-wrap">
              <span class="code-output-indicator"></span>
              <span>${escapeHtml(t('Output ({time})', { time: execTime }))}</span>
            </div>
            <button class="code-output-close" title="${escapeHtml(t('Close output'))}">✕</button>
          </div>
          <pre class="code-output-body">${escapeHtml(outputText)}</pre>
        `;

        wrapper.appendChild(outputEl);
      } catch (err) {
        console.error('Code execution failed:', err);
        const outputEl = document.createElement('div');
        outputEl.className = 'code-output-box output-error';
        outputEl.innerHTML = `
          <div class="code-output-header">
            <div class="code-output-title-wrap">
              <span class="code-output-indicator"></span>
              <span>${escapeHtml(t('Execution Error'))}</span>
            </div>
            <button class="code-output-close" title="${escapeHtml(t('Close output'))}">✕</button>
          </div>
          <pre class="code-output-body">${escapeHtml(err.message || err)}</pre>
        `;
        wrapper.appendChild(outputEl);
      } finally {
        if (span) span.textContent = originalText;
        btn.disabled = false;
      }
    };

    const handleCloseOutputClick = (e) => {
      const closeBtn = e.target.closest('.code-output-close');
      if (!closeBtn) return;
      const box = closeBtn.closest('.code-output-box');
      if (box) box.remove();
    };

    document.addEventListener('click', handleCopyCodeClick);
    document.addEventListener('click', handleRunCodeClick);
    document.addEventListener('click', handleCloseOutputClick);

    return () => {
      document.removeEventListener('click', handleCopyCodeClick);
      document.removeEventListener('click', handleRunCodeClick);
      document.removeEventListener('click', handleCloseOutputClick);
    };
  }, [token]);

  const handleStartEdit = (index, text) => {
    setEditingIndex(index);
    setEditText(text);
  };

  const handleCancelEdit = () => {
    setEditingIndex(null);
    setEditText("");
  };

  const handleSaveEdit = (index) => {
    if (editText.trim() && onEdit) {
      onEdit(index, editText);
    }
    setEditingIndex(null);
    setEditText("");
  };

  const handleCopy = async (text, index) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 2000);
    } catch (err) {
      console.error("Failed to copy text: ", err);
    }
  };

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
      const timer = setTimeout(() => {
        container.scrollTop = container.scrollHeight;
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [messages]);

  useEffect(() => {
    return () => {
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
      }
    };
  }, []);

  const playAudio = async (text, index) => {
    if (activePlayIndexRef.current === index) {
      if (currentAudioRef.current) {
        currentAudioRef.current.pause();
        currentAudioRef.current = null;
      }
      activePlayIndexRef.current = null;
      setPlayingIndex(null);
      return;
    }

    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }

    activePlayIndexRef.current = index;
    setPlayingIndex(index);

    const voice = detectVoice(text);
    try {
      const response = await fetch('/api/v1/voice/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ text, voice })
      });

      if (activePlayIndexRef.current !== index) {
        return;
      }

      if (!response.ok) {
        throw new Error("Failed to generate speech");
      }

      const blob = await response.blob();
      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      
      audio.onended = () => {
        if (activePlayIndexRef.current === index) {
          setPlayingIndex(null);
          activePlayIndexRef.current = null;
          currentAudioRef.current = null;
        }
      };

      currentAudioRef.current = audio;
      await audio.play();
    } catch (error) {
      console.error("Audio playback error:", error);
      if (activePlayIndexRef.current === index) {
        activePlayIndexRef.current = null;
        setPlayingIndex(null);
      }
      if (currentAudioRef.current) {
        currentAudioRef.current = null;
      }
      toast.error(t('Failed to play audio: ') + error.message);
    }
  };

  // The start page stays until the first question: upload notes ("… is ready") are shown on it, above the
  // suggestions, so "What does this letter want from me?" is one click away after adding a letter.
  const isWelcomeState = messages.every((m) => m.role === 'system');
  const notices = isWelcomeState ? messages : [];

  return (
    <div className={styles.container}>
      {isWelcomeState ? (
        <div className={styles.welcomeContainer}>
          <img src="/Logo.png" alt="StarkLLM" className={styles.welcomeLogo} />
          <h1 className={styles.welcomeTitle}>StarkLLM</h1>
          <p className={styles.welcomeSubtitle}>
            {t('Your private assistant for letters and documents, on this PC.')}
          </p>

          {notices.map((m, i) => (
            <p key={i} className={styles.welcomeNotice} role="status">{m.content}</p>
          ))}

          <div className={styles.suggestionsGrid}>
            {STARTER_PROMPTS.map((item, idx) => {
              const Icon = item.icon;
              return (
                <button
                  type="button"
                  key={idx}
                  className={styles.suggestionCard}
                  onClick={() => {
                    if (item.upload) starterFileRef.current && starterFileRef.current.click();
                    else if (onSelectStarter) onSelectStarter(item.promptFor && newestDocument ? item.promptFor(newestDocument) : item.prompt);
                  }}
                >
                  <div className={styles.suggestionHeader}>
                    <Icon size={16} className={styles.suggestionIcon} />
                    <span>{item.title}</span>
                  </div>
                  <div className={styles.suggestionDesc}>{item.desc}</div>
                </button>
              );
            })}
            <input
              ref={starterFileRef}
              type="file"
              multiple
              accept={UPLOAD_ACCEPT}
              hidden
              onChange={async (e) => {
                const files = [...(e.target.files || [])];
                e.target.value = '';
                for (const f of files) {
                  try { onUpload && (await onUpload(f)); } catch (_) { /* the chat shows the error */ }
                }
              }}
            />
          </div>
        </div>
      ) : (
        <>
          {(onExport || onSummarize) && messages.length > 1 && (
            <div className={styles.exportFloating}>
              {onSummarize && messages.length >= 3 && (
                <button
                  className={styles.exportBtn}
                  onClick={onSummarize}
                  title={t('Summarize this chat')}
                >
                  <FileText size={18} />
                </button>
              )}
              {onExport && (
                <>
                  <button
                    className={styles.exportBtn}
                    onClick={() => setShowExportMenu(!showExportMenu)}
                    title={t('Export chat')}
                  >
                    <Download size={18} />
                  </button>
                  {showExportMenu && (
                    <div className={styles.exportMenu}>
                      <button onClick={() => { onExport('md'); setShowExportMenu(false); }}>
                        {t('📄 Markdown (.md)')}
                      </button>
                      <button onClick={() => { onExport('html'); setShowExportMenu(false); }}>
                        {t('🖨️ Printable HTML / PDF (.html)')}
                      </button>
                      <button onClick={() => { onExport('json'); setShowExportMenu(false); }}>
                        {t('📋 Structured Data (.json)')}
                      </button>
                      <button onClick={() => { onExport('txt'); setShowExportMenu(false); }}>
                        {t('📝 Plain Text (.txt)')}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          <div className={styles.messages} ref={scrollContainerRef}>
          {messages.map((msg, i) => (
            <ChatMessageRenderer
              key={msg.id || i}
              msg={msg}
              i={i}
              isRTL={isRTL}
              editingIndex={editingIndex}
              editText={editText}
              setEditText={setEditText}
              handleCancelEdit={handleCancelEdit}
              handleSaveEdit={handleSaveEdit}
              copiedIndex={copiedIndex}
              handleCopy={handleCopy}
              handleStartEdit={handleStartEdit}
              onEdit={onEdit}
              onRegenerate={onRegenerate}
              playingIndex={playingIndex}
              playAudio={playAudio}
              onRetryMessage={onRetryMessage}
              workspaceId={workspaceId}
              token={token}
              onSendToolResult={onRetryMessage}
              onFeedback={null}
              onInspectSources={(source, labels) => setInspectingSource({ msg: source, labels })}
            />
          ))}
          <div ref={messagesEndRef} />
        </div>
        </>
      )}

      {inspectingSource && (
        <SourcesModal
          labels={inspectingSource.labels}
          evidence={inspectingSource.msg.evidence}
          loadEvidence={() => loadEvidence(inspectingSource.msg)}
          onClose={() => setInspectingSource(null)}
          onOpenDocument={(e) => setViewing({ documentId: e.document_id, page: e.page || 1, highlight: (e.passages || [])[0] })}
        />
      )}
      {viewing && (
        <DocumentViewerModal
          isOpen
          onClose={() => setViewing(null)}
          workspaceId={workspaceId}
          documentId={viewing.documentId}
          initialPage={viewing.page}
          highlight={viewing.highlight}
          token={token}
        />
      )}
    </div>
  );
}
