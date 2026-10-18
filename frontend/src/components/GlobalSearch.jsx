import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import styles from './GlobalSearch.module.css';
import {
  Search, X, MessageCircle, FolderOpen, FileText, Database,
  ArrowRight, Loader, Command, PlusCircle, Settings, Cpu,
  Sparkles, Brain, Trash2, Layers
} from 'lucide-react';

function useDebounce(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

export default function GlobalSearch({
  token,
  workspaces = [],
  activeWorkspace = null,
  chats = [],
  currentModel = '',
  onClose,
  onNavigate,
  onNewChat,
  onSelectWorkspace,
  onOpenSettings,
  onOpenDocuments,
  onOpenModelHub,
  onOpenPromptTemplates,
  onOpenMemoryManager,
  onOpenKnowledgeBase,
  onClearChat,
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const debouncedQuery = useDebounce(query, 260);
  const inputRef = useRef(null);
  const containerRef = useRef(null);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Built-in Quick Palette Commands
  const commands = useMemo(() => [
    {
      id: 'cmd-new-chat',
      title: 'New Conversation',
      subtitle: activeWorkspace ? `Start fresh chat in "${activeWorkspace.name}"` : 'Start a new conversation',
      icon: PlusCircle,
      badge: 'Action',
      kbd: 'N',
      run: () => onNewChat && onNewChat()
    },
    {
      id: 'cmd-model-hub',
      title: 'Model Hub & Switcher',
      subtitle: currentModel ? `Active: ${currentModel}` : 'Browse and pull local Ollama models',
      icon: Cpu,
      badge: 'Model',
      kbd: 'M',
      run: () => onOpenModelHub && onOpenModelHub()
    },
    {
      id: 'cmd-documents',
      title: 'Manage Documents & Connectors',
      subtitle: 'Upload files, ingest GitHub repos, Web URLs, YouTube, Notes',
      icon: FolderOpen,
      badge: 'RAG',
      kbd: 'D',
      run: () => onOpenDocuments && onOpenDocuments()
    },
    {
      id: 'cmd-prompts',
      title: 'Prompt Templates & Personas',
      subtitle: 'Pre-engineered system prompts for coding, review, and briefing',
      icon: Sparkles,
      badge: 'Prompts',
      kbd: 'P',
      run: () => onOpenPromptTemplates && onOpenPromptTemplates()
    },
    {
      id: 'cmd-memory',
      title: 'Neural Semantic Memory',
      subtitle: 'Manage cross-conversation persistent memories and preferences',
      icon: Brain,
      badge: 'Memory',
      kbd: 'B',
      run: () => onOpenMemoryManager && onOpenMemoryManager()
    },
    {
      id: 'cmd-settings',
      title: 'Settings & Local API Server',
      subtitle: 'OpenAI API compatibility, Cursor/VSCode connection, API keys',
      icon: Settings,
      badge: 'System',
      kbd: 'S',
      run: () => onOpenSettings && onOpenSettings()
    },
    {
      id: 'cmd-kb',
      title: 'Global Knowledge Base',
      subtitle: 'Manage shared vector database collections across workspaces',
      icon: Database,
      badge: 'Storage',
      kbd: 'K',
      run: () => onOpenKnowledgeBase && onOpenKnowledgeBase()
    },
    {
      id: 'cmd-clear',
      title: 'Clear Active Chat',
      subtitle: 'Reset the messages in current conversation',
      icon: Trash2,
      badge: 'Chat',
      kbd: 'C',
      run: () => onClearChat && onClearChat()
    }
  ], [activeWorkspace, currentModel, onNewChat, onOpenModelHub, onOpenDocuments, onOpenPromptTemplates, onOpenMemoryManager, onOpenSettings, onOpenKnowledgeBase, onClearChat]);

  // Filter commands by query
  const filteredCommands = useMemo(() => {
    if (!query.trim()) return commands;
    const q = query.toLowerCase().trim();
    return commands.filter(c => 
      c.title.toLowerCase().includes(q) || 
      c.subtitle.toLowerCase().includes(q) ||
      c.badge.toLowerCase().includes(q)
    );
  }, [commands, query]);

  // Server-side search API
  useEffect(() => {
    if (!debouncedQuery.trim()) {
      setResults(null);
      setError(null);
      setSelectedIndex(0);
      return;
    }

    let isSubscribed = true;
    const search = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/v1/search/global?q=${encodeURIComponent(debouncedQuery.trim())}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) throw new Error(`Search failed (${res.status})`);
        const data = await res.json();
        if (isSubscribed) {
          setResults(data);
          setSelectedIndex(0);
        }
      } catch (e) {
        if (isSubscribed) {
          setError(e.message);
          setResults(null);
        }
      } finally {
        if (isSubscribed) setLoading(false);
      }
    };

    search();
    return () => { isSubscribed = false; };
  }, [debouncedQuery, token]);

  // Flat list of selectable items for keyboard navigation
  const flatItems = useMemo(() => {
    const list = [];

    // 1. Matching commands
    filteredCommands.forEach(cmd => {
      list.push({ ...cmd, _type: 'command' });
    });

    if (!query.trim()) {
      // 2. Workspaces list (quick switcher)
      if (workspaces && workspaces.length > 0) {
        workspaces.forEach(ws => {
          list.push({
            id: `ws-${ws.id}`,
            _type: 'workspace_quick',
            name: ws.name,
            icon: FolderOpen,
            badge: ws.id === activeWorkspace?.id ? 'Active' : 'Workspace',
            ws
          });
        });
      }

      // 3. Recent chats
      if (chats && chats.length > 0) {
        chats.slice(0, 5).forEach(c => {
          list.push({
            id: `chat-${c.id}`,
            _type: 'chat_quick',
            title: c.title || 'Untitled Chat',
            icon: MessageCircle,
            badge: 'Recent',
            chat: c
          });
        });
      }
    } else if (results) {
      // 4. Server search results
      if (results.workspaces) {
        results.workspaces.forEach(r => list.push({ ...r, _type: 'search_result', _group: 'workspaces' }));
      }
      if (results.chats) {
        results.chats.forEach(r => list.push({ ...r, _type: 'search_result', _group: 'chats' }));
      }
      if (results.documents) {
        results.documents.forEach(r => list.push({ ...r, _type: 'search_result', _group: 'documents' }));
      }
    }

    return list;
  }, [filteredCommands, query, workspaces, activeWorkspace, chats, results]);

  // Ensure selectedIndex is within bounds
  useEffect(() => {
    if (selectedIndex >= flatItems.length) {
      setSelectedIndex(Math.max(0, flatItems.length - 1));
    }
  }, [flatItems.length, selectedIndex]);

  const handleItemSelect = useCallback((item) => {
    onClose();
    if (item._type === 'command') {
      item.run();
    } else if (item._type === 'workspace_quick') {
      if (onSelectWorkspace) onSelectWorkspace(item.ws);
    } else if (item._type === 'chat_quick') {
      if (onNavigate) onNavigate({ type: 'chat', id: item.chat.id, workspace_id: item.chat.workspace_id });
    } else if (item._type === 'search_result') {
      if (onNavigate) onNavigate(item);
    }
  }, [onClose, onSelectWorkspace, onNavigate]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      onClose();
      return;
    }

    if (flatItems.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => (i + 1) % flatItems.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => (i - 1 + flatItems.length) % flatItems.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = flatItems[selectedIndex];
      if (item) handleItemSelect(item);
    }
  }, [flatItems, selectedIndex, handleItemSelect, onClose]);

  // Close on backdrop click
  const handleBackdropClick = (e) => {
    if (containerRef.current && !containerRef.current.contains(e.target)) {
      onClose();
    }
  };

  const totalResultsCount = results
    ? (results.workspaces?.length || 0) + (results.chats?.length || 0) + (results.documents?.length || 0)
    : 0;

  return (
    <div className={styles.backdrop} onClick={handleBackdropClick}>
      <div className={styles.modal} ref={containerRef} onKeyDown={handleKeyDown}>

        {/* ── Search Input ── */}
        <div className={styles.inputRow}>
          {loading ? (
            <Loader size={18} className={styles.searchIconSpinner} />
          ) : (
            <Command size={18} className={styles.searchIcon} />
          )}
          <input
            ref={inputRef}
            type="text"
            className={styles.input}
            placeholder="Type a command or search chats, docs, code..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="Command palette and global search"
            spellCheck={false}
            autoComplete="off"
          />
          {query && (
            <button className={styles.clearBtn} onClick={() => setQuery('')} title="Clear">
              <X size={14} />
            </button>
          )}
          <button className={styles.closeKbd} onClick={onClose} title="Close (Esc)">
            <kbd>Esc</kbd>
          </button>
        </div>

        {/* ── Body ── */}
        <div className={styles.body}>

          {/* Quick Actions / Commands */}
          {filteredCommands.length > 0 && (
            <div className={styles.group}>
              <div className={styles.groupLabel}>
                <Command size={12} />
                <span>Commands & Quick Actions</span>
                <span className={styles.groupCount}>{filteredCommands.length}</span>
              </div>
              {filteredCommands.map(cmd => {
                const idx = flatItems.findIndex(x => x.id === cmd.id);
                const isSelected = idx === selectedIndex;
                const Icon = cmd.icon;
                return (
                  <button
                    key={cmd.id}
                    className={`${styles.resultItem} ${isSelected ? styles.resultSelected : ''}`}
                    onClick={() => handleItemSelect({ ...cmd, _type: 'command' })}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <div className={styles.resultIcon}>
                      <Icon size={15} />
                    </div>
                    <div className={styles.resultBody}>
                      <span className={styles.resultTitle}>{cmd.title}</span>
                      <span className={styles.contentSnippet}>{cmd.subtitle}</span>
                    </div>
                    <span className={styles.commandBadge}>{cmd.badge}</span>
                    {cmd.kbd && (
                      <span className={styles.shortcutKbd}>{cmd.kbd}</span>
                    )}
                    <ArrowRight size={13} className={styles.resultArrow} />
                  </button>
                );
              })}
            </div>
          )}

          {/* If no query: Workspaces list */}
          {!query.trim() && workspaces && workspaces.length > 0 && (
            <div className={styles.group}>
              <div className={styles.groupLabel}>
                <Layers size={12} />
                <span>Switch Workspace</span>
                <span className={styles.groupCount}>{workspaces.length}</span>
              </div>
              {workspaces.map(ws => {
                const idx = flatItems.findIndex(x => x.id === `ws-${ws.id}`);
                const isSelected = idx === selectedIndex;
                return (
                  <button
                    key={`ws-${ws.id}`}
                    className={`${styles.resultItem} ${isSelected ? styles.resultSelected : ''}`}
                    onClick={() => handleItemSelect({ id: `ws-${ws.id}`, _type: 'workspace_quick', ws })}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <div className={styles.resultIcon}>
                      <FolderOpen size={15} />
                    </div>
                    <div className={styles.resultBody}>
                      <span className={styles.resultTitle}>{ws.name}</span>
                      {ws.description && <span className={styles.contentSnippet}>{ws.description}</span>}
                    </div>
                    {ws.id === activeWorkspace?.id ? (
                      <span className={styles.activeBadge}>Active</span>
                    ) : (
                      <span className={styles.workspaceBadge}>Workspace</span>
                    )}
                    <ArrowRight size={13} className={styles.resultArrow} />
                  </button>
                );
              })}
            </div>
          )}

          {/* If no query: Recent Chats */}
          {!query.trim() && chats && chats.length > 0 && (
            <div className={styles.group}>
              <div className={styles.groupLabel}>
                <MessageCircle size={12} />
                <span>Recent Conversations</span>
                <span className={styles.groupCount}>{Math.min(5, chats.length)}</span>
              </div>
              {chats.slice(0, 5).map(c => {
                const idx = flatItems.findIndex(x => x.id === `chat-${c.id}`);
                const isSelected = idx === selectedIndex;
                return (
                  <button
                    key={`chat-${c.id}`}
                    className={`${styles.resultItem} ${isSelected ? styles.resultSelected : ''}`}
                    onClick={() => handleItemSelect({ id: `chat-${c.id}`, _type: 'chat_quick', chat: c })}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <div className={styles.resultIcon}>
                      <MessageCircle size={15} />
                    </div>
                    <div className={styles.resultBody}>
                      <span className={styles.resultTitle}>{c.title || 'Untitled Conversation'}</span>
                      {c.updated_at && (
                        <span className={styles.resultMeta}>
                          {new Date(c.updated_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    <span className={styles.chatBadge}>Chat</span>
                    <ArrowRight size={13} className={styles.resultArrow} />
                  </button>
                );
              })}
            </div>
          )}

          {/* Search Error */}
          {error && (
            <div className={styles.errorState}>
              <span>⚠️ {error}</span>
            </div>
          )}

          {/* Search Results */}
          {query.trim() && results && totalResultsCount > 0 && (
            <div className={styles.results}>
              {/* Workspaces results */}
              {results.workspaces && results.workspaces.length > 0 && (
                <div className={styles.group}>
                  <div className={styles.groupLabel}>
                    <FolderOpen size={12} />
                    <span>Workspaces</span>
                    <span className={styles.groupCount}>{results.workspaces.length}</span>
                  </div>
                  {results.workspaces.map(item => {
                    const idx = flatItems.findIndex(x => x.id === item.id && x._group === 'workspaces');
                    const isSelected = idx === selectedIndex;
                    return (
                      <button
                        key={`ws-res-${item.id}`}
                        className={`${styles.resultItem} ${isSelected ? styles.resultSelected : ''}`}
                        onClick={() => handleItemSelect({ ...item, _type: 'search_result' })}
                        onMouseEnter={() => setSelectedIndex(idx)}
                      >
                        <div className={styles.resultIcon}><FolderOpen size={15} /></div>
                        <div className={styles.resultBody}>
                          <span className={styles.resultTitle}>{item.name || item.title}</span>
                          {item.content_snippet && <span className={styles.contentSnippet}>{item.content_snippet}</span>}
                        </div>
                        <span className={styles.workspaceBadge}>Workspace</span>
                        <ArrowRight size={13} className={styles.resultArrow} />
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Chats results */}
              {results.chats && results.chats.length > 0 && (
                <div className={styles.group}>
                  <div className={styles.groupLabel}>
                    <MessageCircle size={12} />
                    <span>Chats</span>
                    <span className={styles.groupCount}>{results.chats.length}</span>
                  </div>
                  {results.chats.map(item => {
                    const idx = flatItems.findIndex(x => x.id === item.id && x._group === 'chats');
                    const isSelected = idx === selectedIndex;
                    return (
                      <button
                        key={`chat-res-${item.id}`}
                        className={`${styles.resultItem} ${isSelected ? styles.resultSelected : ''}`}
                        onClick={() => handleItemSelect({ ...item, _type: 'search_result' })}
                        onMouseEnter={() => setSelectedIndex(idx)}
                      >
                        <div className={styles.resultIcon}><MessageCircle size={15} /></div>
                        <div className={styles.resultBody}>
                          <span className={styles.resultTitle}>{item.title}</span>
                          {item.content_snippet && <span className={styles.contentSnippet}>{item.content_snippet}</span>}
                          {item.workspace_name && (
                            <span className={styles.resultMeta}>
                              {item.workspace_name}
                              {item.match_type === 'content' && <span className={styles.matchBadge}>in messages</span>}
                            </span>
                          )}
                        </div>
                        <span className={styles.chatBadge}>Chat</span>
                        <ArrowRight size={13} className={styles.resultArrow} />
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Documents results */}
              {results.documents && results.documents.length > 0 && (
                <div className={styles.group}>
                  <div className={styles.groupLabel}>
                    <FileText size={12} />
                    <span>Documents</span>
                    <span className={styles.groupCount}>{results.documents.length}</span>
                  </div>
                  {results.documents.map(item => {
                    const idx = flatItems.findIndex(x => x.id === item.id && x._group === 'documents');
                    const isSelected = idx === selectedIndex;
                    return (
                      <button
                        key={`doc-res-${item.id}`}
                        className={`${styles.resultItem} ${isSelected ? styles.resultSelected : ''}`}
                        onClick={() => handleItemSelect({ ...item, _type: 'search_result' })}
                        onMouseEnter={() => setSelectedIndex(idx)}
                      >
                        <div className={styles.resultIcon}>
                          {item.doc_type === 'knowledge_base' ? <Database size={15} /> : <FileText size={15} />}
                        </div>
                        <div className={styles.resultBody}>
                          <span className={styles.resultTitle}>{item.title || item.name}</span>
                          {item.content_snippet && <span className={styles.contentSnippet}>{item.content_snippet}</span>}
                          {item.workspace_name && (
                            <span className={styles.resultMeta}>
                              {item.workspace_name}
                              {item.match_type === 'content' && <span className={styles.matchBadge}>in content</span>}
                              {item.doc_type === 'knowledge_base' && <span className={styles.kbBadge}>Knowledge Base</span>}
                            </span>
                          )}
                        </div>
                        <span className={styles.docBadge}>Doc</span>
                        <ArrowRight size={13} className={styles.resultArrow} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* No results for query */}
          {query.trim() && filteredCommands.length === 0 && results && totalResultsCount === 0 && !loading && (
            <div className={styles.emptyState}>
              <Search size={28} className={styles.emptyIcon} />
              <p className={styles.emptyTitle}>No matching commands or results</p>
              <p className={styles.emptyHint}>Try a different search keyword or press Esc to return.</p>
            </div>
          )}
        </div>

        {/* ── Footer ── */}
        <div className={styles.footer}>
          <div className={styles.footerHints}>
            <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
            <span><kbd>↵</kbd> Select</span>
            <span><kbd>Esc</kbd> Close</span>
          </div>
          {query.trim() && totalResultsCount > 0 && (
            <span className={styles.footerCount}>
              {totalResultsCount} result{totalResultsCount !== 1 ? 's' : ''} found
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
