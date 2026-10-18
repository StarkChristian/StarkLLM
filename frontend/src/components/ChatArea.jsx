import React, { useEffect, useRef, useState, useCallback } from 'react';
import styles from './ChatArea.module.css';
import { 
  User, Bot, Volume2, Square, Database, Copy, Check, Globe, RefreshCw, 
  Edit2, Download, FileText, AlertTriangle, Sparkles, Code, BookOpen,
  ThumbsUp, ThumbsDown
} from 'lucide-react';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import 'highlight.js/styles/github-dark.css';
import { useToast } from './Toast';
import ToolCallCard from './ToolCallCard';

const STARTER_PROMPTS = [
  {
    icon: Sparkles,
    title: "Deep Tech Explainer",
    desc: "Explain Homomorphic Encryption & ZK Proofs simply",
    prompt: "Can you explain how Homomorphic Encryption and Zero-Knowledge Proofs work together to preserve privacy in modern AI, in simple terms?"
  },
  {
    icon: Code,
    title: "Code Architecture & Review",
    desc: "Analyze code for performance bottlenecks & security",
    prompt: "Act as a principal software architect. Review my codebase architecture and suggest optimizations for concurrency and memory usage."
  },
  {
    icon: BookOpen,
    title: "Workspace Knowledge Query",
    desc: "Synthesize insights and answers from indexed documents",
    prompt: "Based on my indexed workspace documents and knowledge base, what are the primary takeaways and key insights?"
  },
  {
    icon: FileText,
    title: "Executive Strategic Briefing",
    desc: "Draft a concise summary on local open-source AI",
    prompt: "Draft an executive briefing summarizing recent advancements in open-weight models, local inference speed, and private enterprise AI."
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
    return `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-block-lang">${displayLang}</span><button class="copy-code-btn" data-code="${encoded}" title="Copy code"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>Copy</span></button></div><pre><code class="hljs ${validLang}">${highlightedCode}</code></pre></div>`;
  }
});

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
  onFeedback
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
                <button className={styles.editCancelBtn} onClick={handleCancelEdit}>Cancel</button>
                <button className={styles.editSaveBtn} onClick={() => handleSaveEdit(i)}>Save & Submit</button>
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

              {msg.role === 'assistant' && ((msg.wsSources && msg.wsSources.length > 0) || (msg.kbSources && msg.kbSources.length > 0) || (msg.webSources && msg.webSources.length > 0)) && (
                <div className={styles.sourcesContainer}>
                  {msg.wsSources && msg.wsSources.length > 0 && (
                    <div className={styles.sourceGroup} title="Retrieved from Workspace Documents">
                      <Database size={11} className={styles.sourceIcon} />
                      <span>Workspace: {msg.wsSources.join(', ')}</span>
                    </div>
                  )}
                  {msg.kbSources && msg.kbSources.length > 0 && (
                    <div className={styles.sourceGroup} title="Retrieved from Personal Knowledge Base">
                      <Database size={11} className={styles.sourceIcon} />
                      <span>Personal KB: {msg.kbSources.join(', ')}</span>
                    </div>
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
                <RefreshCw size={12} /> Retry
              </button>
            )}
          </div>
        )}
        
        {msg.role !== 'system' && !msg.isError && msg.content.length > 0 && (
          <div className={styles.messageActions}>
              <button 
                className={`${styles.actionBtn} ${copiedIndex === i ? styles.success : ''}`}
                onClick={() => handleCopy(msg.content, i)}
                title="Copy to clipboard"
              >
                {copiedIndex === i ? <Check size={14} /> : <Copy size={14} />}
              </button>
              
              {msg.role === 'user' && editingIndex !== i && onEdit && (
                <button 
                  className={styles.actionBtn} 
                  onClick={() => handleStartEdit(i, msg.content)}
                  title="Edit message"
                >
                  <Edit2 size={14} />
                </button>
              )}

              {msg.role === 'assistant' && onRegenerate && (
                <button 
                  className={styles.actionBtn} 
                  onClick={() => onRegenerate(i)}
                  title="Regenerate response"
                >
                  <RefreshCw size={14} />
                </button>
              )}

              {msg.role === 'assistant' && msg.content.length > 0 && (
                <>
                  <button
                    className={`${styles.actionBtn} ${localFeedback === 'positive' ? styles.feedbackActive : ''}`}
                    onClick={() => handleFeedback('positive')}
                    title="Good response"
                    style={localFeedback === 'positive' ? { color: 'var(--success)', background: 'rgba(16,185,129,0.12)' } : {}}
                  >
                    <ThumbsUp size={14} />
                  </button>
                  <button
                    className={`${styles.actionBtn} ${localFeedback === 'negative' ? styles.feedbackActive : ''}`}
                    onClick={() => handleFeedback('negative')}
                    title="Bad response"
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
                  title={playingIndex === i ? "Stop audio" : "Play audio"}
                >
                  {playingIndex === i ? <Square size={14} fill="currentColor" /> : <Volume2 size={14} />}
                </button>
              )}
            </div>
          )}
        </div>
      {msg.role !== 'system' && msg.timestamp && (
        <span className={styles.timestamp}>
          {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
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
  token
}) {
  const toast = useToast();
  const scrollContainerRef = useRef(null);
  const messagesEndRef = useRef(null);
  
  const [playingIndex, setPlayingIndex] = useState(null);
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [editingIndex, setEditingIndex] = useState(null);
  const [editText, setEditText] = useState("");
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
          span.textContent = 'Copied!';
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

    document.addEventListener('click', handleCopyCodeClick);
    return () => document.removeEventListener('click', handleCopyCodeClick);
  }, []);

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
        headers: { 'Content-Type': 'application/json' },
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
      toast.error("Failed to play audio: " + error.message);
    }
  };

  const isWelcomeState = messages.length === 0 || (messages.length === 1 && (
    messages[0].content.includes('Start a new chat') || 
    messages[0].content.includes('Welcome') || 
    messages[0].content.includes('created')
  ));

  return (
    <div className={styles.container}>
      {isWelcomeState ? (
        <div className={styles.welcomeContainer}>
          <img src="/Logo.png" alt="StarkLLM" className={styles.welcomeLogo} />
          <h1 className={styles.welcomeTitle}>StarkLLM</h1>
          <p className={styles.welcomeSubtitle}>
            Private AI assistant with personal Knowledge Base and RAG retrieval.
          </p>

          <div className={styles.suggestionsGrid}>
            {STARTER_PROMPTS.map((item, idx) => {
              const Icon = item.icon;
              return (
                <div 
                  key={idx} 
                  className={styles.suggestionCard}
                  onClick={() => onSelectStarter && onSelectStarter(item.prompt)}
                  role="button"
                  tabIndex={0}
                >
                  <div className={styles.suggestionHeader}>
                    <Icon size={16} className={styles.suggestionIcon} />
                    <span>{item.title}</span>
                  </div>
                  <div className={styles.suggestionDesc}>{item.desc}</div>
                </div>
              );
            })}
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
                  title="Summarize this chat"
                >
                  <FileText size={18} />
                </button>
              )}
              {onExport && (
                <>
                  <button
                    className={styles.exportBtn}
                    onClick={() => setShowExportMenu(!showExportMenu)}
                    title="Export chat"
                  >
                    <Download size={18} />
                  </button>
                  {showExportMenu && (
                    <div className={styles.exportMenu}>
                      <button onClick={() => { onExport('md'); setShowExportMenu(false); }}>
                        📄 Markdown (.md)
                      </button>
                      <button onClick={() => { onExport('html'); setShowExportMenu(false); }}>
                        🖨️ Printable HTML / PDF (.html)
                      </button>
                      <button onClick={() => { onExport('json'); setShowExportMenu(false); }}>
                        📋 Structured Data (.json)
                      </button>
                      <button onClick={() => { onExport('txt'); setShowExportMenu(false); }}>
                        📝 Plain Text (.txt)
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
            />
          ))}
          <div ref={messagesEndRef} />
        </div>
        </>
      )}
    </div>
  );
}
