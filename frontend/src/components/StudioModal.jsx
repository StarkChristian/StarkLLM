import React, { useState, useEffect, useRef } from 'react';
import styles from './StudioModal.module.css';
import { 
  Headphones, FileText, BookOpen, Layers, Play, Pause, 
  RotateCcw, Sparkles, Download, Copy, Check, Volume2, 
  VolumeX, HelpCircle, Eye, EyeOff 
} from 'lucide-react';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, typographer: true });

export default function StudioModal({
  isOpen,
  onClose,
  workspaceId,
  token,
  selectedModel = "qwen2.5:7b"
}) {
  const [activeTab, setActiveTab] = useState('podcast'); // 'podcast' | 'briefing' | 'study_guide' | 'comparison'
  const [focusQuery, setFocusQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Results cache per tab
  const [results, setResults] = useState({
    podcast: null,
    briefing: null,
    study_guide: null,
    comparison: null
  });

  // Podcast Audio Playback State
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTurnIndex, setCurrentTurnIndex] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [revealedQuiz, setRevealedQuiz] = useState({});
  const [copied, setCopied] = useState(false);

  const synthRef = useRef(window.speechSynthesis);
  const activeUtteranceRef = useRef(null);

  // Stop speech synthesis on modal close or unmount
  useEffect(() => {
    return () => {
      if (synthRef.current) {
        synthRef.current.cancel();
      }
    };
  }, []);

  const handleGenerate = async (typeOverride) => {
    const targetType = typeOverride || activeTab;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/v1/studio/${workspaceId}/synthesize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          type: targetType,
          model: selectedModel,
          focus: focusQuery.trim() || undefined
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || 'Failed to synthesize studio overview');
      }

      const data = await res.json();
      setResults(prev => ({
        ...prev,
        [targetType]: data.data || data.content || data.raw
      }));

      // Reset audio playback if podcast generated
      if (targetType === 'podcast') {
        if (synthRef.current) synthRef.current.cancel();
        setIsPlaying(false);
        setCurrentTurnIndex(0);
      }
    } catch (err) {
      setError(err.message || 'Generation failed');
    } finally {
      setLoading(false);
    }
  };

  // Speak turn sequentially
  const speakTurn = (index, dialogueList) => {
    if (!dialogueList || index >= dialogueList.length) {
      setIsPlaying(false);
      setCurrentTurnIndex(0);
      return;
    }

    if (!synthRef.current) return;
    synthRef.current.cancel();

    const turn = dialogueList[index];
    const utterance = new SpeechSynthesisUtterance(turn.text);
    utterance.rate = playbackSpeed;

    // Use distinct pitch for Alex vs Taylor
    if (turn.speaker === 'Taylor') {
      utterance.pitch = 1.15;
    } else {
      utterance.pitch = 0.95;
    }

    utterance.onend = () => {
      if (index + 1 < dialogueList.length) {
        setCurrentTurnIndex(index + 1);
        speakTurn(index + 1, dialogueList);
      } else {
        setIsPlaying(false);
        setCurrentTurnIndex(0);
      }
    };

    utterance.onerror = () => {
      setIsPlaying(false);
    };

    activeUtteranceRef.current = utterance;
    synthRef.current.speak(utterance);
  };

  const togglePlayPodcast = () => {
    const dialogue = results.podcast?.dialogue;
    if (!dialogue || dialogue.length === 0) return;

    if (isPlaying) {
      if (synthRef.current) synthRef.current.cancel();
      setIsPlaying(false);
    } else {
      setIsPlaying(true);
      speakTurn(currentTurnIndex, dialogue);
    }
  };

  const handleCopyText = (text) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadMarkdown = (content, filename) => {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.headerTitleArea}>
            <Sparkles size={22} color="#c084fc" />
            <h2 className={styles.title}>
              StarkLLM Studio
            </h2>
            <span className={styles.studioBadge}>AI Studio Mode</span>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div className={styles.tabBar}>
          <button
            className={`${styles.tabBtn} ${activeTab === 'podcast' ? styles.activeTab : ''}`}
            onClick={() => setActiveTab('podcast')}
          >
            <Headphones size={16} /> Audio Overview (Podcast)
          </button>
          <button
            className={`${styles.tabBtn} ${activeTab === 'briefing' ? styles.activeTab : ''}`}
            onClick={() => setActiveTab('briefing')}
          >
            <FileText size={16} /> Executive Briefing
          </button>
          <button
            className={`${styles.tabBtn} ${activeTab === 'study_guide' ? styles.activeTab : ''}`}
            onClick={() => setActiveTab('study_guide')}
          >
            <BookOpen size={16} /> Study Guide & Quiz
          </button>
          <button
            className={`${styles.tabBtn} ${activeTab === 'comparison' ? styles.activeTab : ''}`}
            onClick={() => setActiveTab('comparison')}
          >
            <Layers size={16} /> Comparative Analysis
          </button>
        </div>

        <div className={styles.body}>
          {/* Generation Focus Control */}
          <div className={styles.controlBar}>
            <input
              type="text"
              className={styles.focusInput}
              placeholder={`Optional: specific question or angle for this ${activeTab}...`}
              value={focusQuery}
              onChange={e => setFocusQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleGenerate()}
            />
            <button
              className={styles.genBtn}
              onClick={() => handleGenerate()}
              disabled={loading}
            >
              <Sparkles size={16} />
              {loading ? 'Synthesizing...' : `Generate ${activeTab.replace('_', ' ')}`}
            </button>
          </div>

          {error && (
            <div style={{ padding: '0.8rem 1rem', background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '8px', color: '#fca5a5', marginBottom: '1rem', fontSize: '0.88rem' }}>
              ⚠️ {error}
            </div>
          )}

          {/* TAB 1: PODCAST AUDIO OVERVIEW */}
          {activeTab === 'podcast' && (
            <div>
              {results.podcast?.dialogue ? (
                <>
                  <div className={styles.playerDeck}>
                    <div className={styles.playerHeader}>
                      <div className={styles.playerInfo}>
                        <div className={styles.playerTitle}>{results.podcast.title || 'Workspace Deep Dive'}</div>
                        <div className={styles.playerSubtitle}>{results.podcast.summary}</div>
                      </div>
                      <div className={styles.playerControls}>
                        {isPlaying && (
                          <div className={styles.waveform}>
                            <span className={styles.waveBar}></span>
                            <span className={styles.waveBar}></span>
                            <span className={styles.waveBar}></span>
                            <span className={styles.waveBar}></span>
                            <span className={styles.waveBar}></span>
                          </div>
                        )}
                        <select
                          className={styles.speedSelector}
                          value={playbackSpeed}
                          onChange={e => setPlaybackSpeed(parseFloat(e.target.value))}
                        >
                          <option value="0.9">0.9x Speed</option>
                          <option value="1.0">1.0x Normal</option>
                          <option value="1.2">1.2x Speed</option>
                          <option value="1.4">1.4x Fast</option>
                        </select>
                        <button className={styles.playPauseBtn} onClick={togglePlayPodcast} title={isPlaying ? "Pause" : "Play"}>
                          {isPlaying ? <Pause size={20} /> : <Play size={20} style={{ marginLeft: 2 }} />}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className={styles.transcriptFeed}>
                    {results.podcast.dialogue.map((turn, idx) => (
                      <div
                        key={idx}
                        className={`${styles.dialogueCard} ${currentTurnIndex === idx && isPlaying ? styles.activeDialogueCard : ''}`}
                        onClick={() => {
                          setCurrentTurnIndex(idx);
                          speakTurn(idx, results.podcast.dialogue);
                          setIsPlaying(true);
                        }}
                      >
                        <span className={`${styles.speakerBadge} ${turn.speaker === 'Alex' ? styles.speakerAlex : styles.speakerTaylor}`}>
                          {turn.speaker}
                        </span>
                        <p className={styles.dialogueText}>{turn.text}</p>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className={styles.emptyState}>
                  <Headphones size={48} color="#6366f1" />
                  <h3>Offline Audio Overview</h3>
                  <p style={{ maxWidth: 460 }}>
                    Transform your workspace documents into an engaging 2-speaker podcast discussion (Alex & Taylor) completely offline.
                  </p>
                  <button className={styles.genBtn} onClick={() => handleGenerate('podcast')} disabled={loading}>
                    <Sparkles size={16} /> Generate Audio Overview
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: EXECUTIVE BRIEFING */}
          {activeTab === 'briefing' && (
            <div>
              {results.briefing ? (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', marginBottom: '1rem' }}>
                    <button className={styles.tabBtn} onClick={() => handleCopyText(results.briefing)}>
                      {copied ? <Check size={14} color="#10b981" /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
                    </button>
                    <button className={styles.tabBtn} onClick={() => handleDownloadMarkdown(results.briefing, 'executive_briefing.md')}>
                      <Download size={14} /> Download .md
                    </button>
                  </div>
                  <div
                    className={styles.markdownContent}
                    dangerouslySetInnerHTML={{ __html: md.render(results.briefing) }}
                  />
                </div>
              ) : (
                <div className={styles.emptyState}>
                  <FileText size={48} color="#818cf8" />
                  <h3>Executive Strategic Briefing</h3>
                  <p style={{ maxWidth: 460 }}>
                    Synthesizes all workspace files into an executive briefing covering Strategic Highlights, Risk Matrix, and Action Items.
                  </p>
                  <button className={styles.genBtn} onClick={() => handleGenerate('briefing')} disabled={loading}>
                    <Sparkles size={16} /> Generate Briefing
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: STUDY GUIDE & QUIZ */}
          {activeTab === 'study_guide' && (
            <div>
              {results.study_guide?.quiz ? (
                <div>
                  <h3 style={{ color: '#fff', marginBottom: '0.4rem' }}>{results.study_guide.title || 'Interactive Master Study Guide'}</h3>
                  <p style={{ color: '#a1a1aa', fontSize: '0.9rem', marginBottom: '1.5rem' }}>{results.study_guide.overview}</p>

                  {results.study_guide.concepts?.length > 0 && (
                    <div style={{ marginBottom: '2rem' }}>
                      <h4 style={{ color: '#c084fc', marginBottom: '0.8rem' }}>Core Concepts & Glossary</h4>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
                        {results.study_guide.concepts.map((c, i) => (
                          <div key={i} style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: '10px', padding: '1rem' }}>
                            <strong style={{ color: '#fff' }}>{c.name}</strong>
                            <p style={{ margin: '0.4rem 0 0', color: '#a1a1aa', fontSize: '0.85rem' }}>{c.definition}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  <h4 style={{ color: '#38bdf8', marginBottom: '1rem' }}>Flashcard Self-Test Quiz</h4>
                  <div className={styles.quizGrid}>
                    {results.study_guide.quiz.map((q, idx) => (
                      <div key={idx} className={styles.quizCard}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#818cf8', textTransform: 'uppercase' }}>Question {idx + 1}</span>
                          <button
                            className={styles.revealBtn}
                            onClick={() => setRevealedQuiz(prev => ({ ...prev, [idx]: !prev[idx] }))}
                          >
                            {revealedQuiz[idx] ? <EyeOff size={14} /> : <Eye size={14} />} {revealedQuiz[idx] ? 'Hide' : 'Reveal Answer'}
                          </button>
                        </div>
                        <p className={styles.quizQuestion}>{q.question}</p>
                        {revealedQuiz[idx] && (
                          <p className={styles.quizAnswer}>{q.answer}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className={styles.emptyState}>
                  <BookOpen size={48} color="#38bdf8" />
                  <h3>Master Study Guide & Flashcard Quiz</h3>
                  <p style={{ maxWidth: 460 }}>
                    Generates core concept definitions and an interactive question-and-answer quiz derived strictly from your documents.
                  </p>
                  <button className={styles.genBtn} onClick={() => handleGenerate('study_guide')} disabled={loading}>
                    <Sparkles size={16} /> Generate Study Guide
                  </button>
                </div>
              )}
            </div>
          )}

          {/* TAB 4: COMPARATIVE ANALYSIS */}
          {activeTab === 'comparison' && (
            <div>
              {results.comparison ? (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem', marginBottom: '1rem' }}>
                    <button className={styles.tabBtn} onClick={() => handleCopyText(results.comparison)}>
                      {copied ? <Check size={14} color="#10b981" /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
                    </button>
                    <button className={styles.tabBtn} onClick={() => handleDownloadMarkdown(results.comparison, 'comparative_analysis.md')}>
                      <Download size={14} /> Download .md
                    </button>
                  </div>
                  <div
                    className={styles.markdownContent}
                    dangerouslySetInnerHTML={{ __html: md.render(results.comparison) }}
                  />
                </div>
              ) : (
                <div className={styles.emptyState}>
                  <Layers size={48} color="#4ade80" />
                  <h3>Cross-Document Comparative Analysis</h3>
                  <p style={{ maxWidth: 460 }}>
                    Examines divergent themes, conflicting facts, and synergies across all indexed documents in this workspace.
                  </p>
                  <button className={styles.genBtn} onClick={() => handleGenerate('comparison')} disabled={loading}>
                    <Sparkles size={16} /> Generate Comparison
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
