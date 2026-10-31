import React, { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar';
import ChatArea from './components/ChatArea';
import InputBar from './components/InputBar';
import LoginSignup from './components/LoginSignup';
import KnowledgeBase from './components/KnowledgeBase';
import Dashboard from './components/Dashboard';
import Settings from './components/Settings';
import ErrorBoundary from './components/ErrorBoundary';
import DocumentManager from './components/DocumentManager';
import MemoryManager from './components/MemoryManager';
import GlobalSearch from './components/GlobalSearch';
import SummaryModal from './components/SummaryModal';
import WorkspaceKBModal from './components/WorkspaceKBModal';
import HealthBanner from './components/HealthBanner';
import OnboardingWizard from './components/OnboardingWizard';
import ModelHubModal from './components/ModelHubModal';
import StudioModal from './components/StudioModal';
import { useToast } from './components/Toast';
import { useChatFolders } from './hooks/useChatFolders';
import { useChatSummary } from './hooks/useChatSummary';
import { exportChat } from './utils/chatExport';

const NO_ANSWER_TEXT = '*[The model returned no answer. Try again, raise the token limit, or choose another model.]*';

export default function App() {
  const toast = useToast();
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [username, setUsername] = useState(localStorage.getItem('username') || '');
  const [onboardingDone, setOnboardingDone] = useState(localStorage.getItem('starkllm_onboarding_done') === 'true');
  const [workspaces, setWorkspaces] = useState([]);
  const [activeWorkspace, setActiveWorkspace] = useState(null);
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Hello! I am StarkLLM, your private AI assistant. How can I help you today?' }
  ]);

  // Multi-chat state
  const [chats, setChats] = useState([]);
  const [activeChatId, setActiveChatId] = useState(null);
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const chatSearchQueryRef = useRef(chatSearchQuery);
  useEffect(() => {
    chatSearchQueryRef.current = chatSearchQuery;
  }, [chatSearchQuery]);

  // Workspace documents state
  const [workspaceDocs, setWorkspaceDocs] = useState([]);

  const [wsLoading, setWsLoading] = useState(false);
  const [wsError, setWsError] = useState(null);
  const [activeView, setActiveView] = useState('dashboard');
  const [useKb, setUseKb] = useState(false);
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(false);
  const [workspacesError, setWorkspacesError] = useState(null);
  const [hasFetchedWorkspaces, setHasFetchedWorkspaces] = useState(false);

  // Workspace name modal state
  const [showWsModal, setShowWsModal] = useState(false);
  const [newWsName, setNewWsName] = useState('');
  const wsNameInputRef = useRef(null);

  // Document Manager modal state
  const [showDocManager, setShowDocManager] = useState(false);
  const [showMemoryManager, setShowMemoryManager] = useState(false);
  const [showKbModal, setShowKbModal] = useState(false);
  const [showModelHub, setShowModelHub] = useState(false);
  const [showStudio, setShowStudio] = useState(false);
  // Empty until the user picks a model: then fetchMe() shows the server's default (DEFAULT_TEXT_MODEL, the one the
  // desktop app downloads). A hard-coded name here made every chat on a fresh install ask for a model that is not installed.
  const [currentModel, setCurrentModel] = useState(localStorage.getItem('default_model') || '');

  // Generation state (for stop button)
  const [isGenerating, setIsGenerating] = useState(false);
  const abortControllerRef = useRef(null);
  const docPollingRef = useRef(null); // interval ref for document status polling

  // ── Global Search state ──
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);

  const getHeaders = (extraHeaders = {}) => ({
    'Authorization': `Bearer ${token}`,
    ...extraHeaders
  });

  const handleLogout = () => {
    setToken(null);
    setUsername('');
    localStorage.removeItem('token');
    localStorage.removeItem('username');
    setWorkspaces([]);
    setActiveWorkspace(null);
    setActiveChatId(null);
    setChats([]);
    setActiveView('dashboard');
    setHasFetchedWorkspaces(false);
    setWorkspacesError(null);
    setLoadingWorkspaces(false);
  };

  // ── Chat Summary hook ──
  const {
    showSummaryModal,
    setShowSummaryModal,
    summaryText,
    summaryLoading,
    summaryError,
    summaryChatTitle,
    summaryCopied,
    handleSummarizeChat,
    handleCopySummary,
  } = useChatSummary({ getHeaders, handleLogout, chats, activeChatId });

  useEffect(() => {
    const fontSize = localStorage.getItem('ui_font_size') || 'medium';
    document.documentElement.style.fontSize =
      fontSize === 'small' ? '14px' : fontSize === 'large' ? '18px' : '16px';
  }, []);

  // ── Ctrl+K global search shortcut ──
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setShowGlobalSearch(prev => !prev);
      }
      if (e.key === 'Escape') {
        setShowGlobalSearch(false);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (token) {
      localStorage.setItem('token', token);
      fetchWorkspaces();
      fetchMe();
    } else {
      localStorage.removeItem('token');
      setWorkspaces([]);
      setActiveWorkspace(null);
      setActiveChatId(null);
      setChats([]);
      setHasFetchedWorkspaces(false);
      setWorkspacesError(null);
      setLoadingWorkspaces(false);
    }
  }, [token]);

  const fetchMe = async () => {
    try {
      const res = await fetch('/api/v1/auth/me', { headers: getHeaders() });
      if (res.ok) {
        const data = await res.json();
        const name = data.username || data.name || '';
        setUsername(name);
        localStorage.setItem('username', name);
        if (!localStorage.getItem('default_model')) {
          if (data.default_model) {
            setCurrentModel(data.default_model);
          } else {
            const st = await fetch('/api/v1/dashboard/system-status', { headers: getHeaders() });
            if (st.ok) setCurrentModel((await st.json()).text_model?.name || '');
          }
        }
      }
    } catch (_) {}
  };

  const fetchWorkspaces = async (retryCount = 0) => {
    setLoadingWorkspaces(true);
    setWorkspacesError(null);
    try {
      const res = await fetch('/api/v1/workspaces/', { headers: getHeaders() });
      if (res.status === 401) { 
        handleLogout(); 
        setLoadingWorkspaces(false);
        setHasFetchedWorkspaces(true);
        return; 
      }
      if (!res.ok) {
        // Backend not ready yet — retry up to 10 times (30 seconds total buffer)
        if (retryCount < 10) {
          const delay = 3000; // constant 3s delay
          console.log(`Backend returned ${res.status}, retrying in 3s... (attempt ${retryCount + 1}/10)`);
          setTimeout(() => fetchWorkspaces(retryCount + 1), delay);
          return;
        }
        throw new Error(`Server returned error ${res.status}`);
      }
      const data = await res.json();
      setWorkspaces(data || []);
      if (data && data.length > 0) {
        setActiveWorkspace(data[0]);
      } else {
        setActiveWorkspace(null);
      }
      setWorkspacesError(null);
      setLoadingWorkspaces(false);
      setHasFetchedWorkspaces(true);
    } catch (err) {
      console.error('Error fetching workspaces:', err);
      // If a network exception or fetch error occurred, retry up to 10 times as well
      if (retryCount < 10) {
        const delay = 3000;
        console.log(`Network error occurred, retrying in 3s... (attempt ${retryCount + 1}/10)`);
        setTimeout(() => fetchWorkspaces(retryCount + 1), delay);
        return;
      }
      
      setLoadingWorkspaces(false);
      setHasFetchedWorkspaces(true);

      if (workspaces.length === 0) {
        setWorkspacesError('Failed to connect to StarkLLM backend. Click "Retry Connection" or wait for the system to finish starting.');
      } else {
        toast.error('Cannot reach StarkLLM backend. Make sure the server is running.', 0, {
          label: 'Retry Connection',
          onClick: () => fetchWorkspaces(0)
        });
      }
    }
  };

  // ── Fetch chat sessions for the active workspace ──
  const fetchAndLoadInitialChat = async (workspaceId) => {
    try {
      const res = await fetch(`/api/v1/chat/sessions/${workspaceId}`, { headers: getHeaders() });
      if (res.status === 401) { handleLogout(); return; }
      if (!res.ok) return;
      const data = await res.json();
      setChats(data);
      if (data.length > 0) {
        // Load the most recent chat
        await loadChat(data[0].id);
      } else {
        setActiveChatId(null);
        setMessages([{ role: 'assistant', content: 'Start a new chat to begin.' }]);
      }
    } catch (err) {
      console.error('Error fetching chats:', err);
    }
  };

  const refreshChatList = async (workspaceId) => {
    try {
      const query = chatSearchQueryRef.current || '';
      const qs = query.trim() ? `?q=${encodeURIComponent(query)}` : '';
      const res = await fetch(`/api/v1/chat/sessions/${workspaceId}${qs}`, { headers: getHeaders() });
      if (res.status === 401) { handleLogout(); return; }
      if (!res.ok) return;
      const data = await res.json();
      setChats(data);
    } catch (err) {
      console.error('Error refreshing chat list:', err);
    }
  };

  // Debounce search query changes
  useEffect(() => {
    if (!activeWorkspace) return;
    const timeoutId = setTimeout(() => {
      refreshChatList(activeWorkspace.id);
    }, 300);
    return () => clearTimeout(timeoutId);
  }, [chatSearchQuery, activeWorkspace]);

  const loadChat = async (chatId) => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    try {
      const res = await fetch(`/api/v1/chat/session/${chatId}`, { headers: getHeaders() });
      if (res.status === 401) { handleLogout(); return; }
      if (!res.ok) return;
      const data = await res.json();
      setActiveChatId(data.chat_id);
      setMessages(
        data.messages && data.messages.length > 0
          // An empty saved answer (older versions stored them) would otherwise show the "thinking" dots forever.
          ? data.messages.map(m => (m.role === 'assistant' && !(m.content || '').trim() ? { ...m, content: NO_ANSWER_TEXT } : m))
          : [{ role: 'assistant', content: 'Chat loaded. How can I help you?', timestamp: new Date() }]
      );
    } catch (err) {
      console.error('Error loading chat:', err);
    }
  };

  const fetchWorkspaceDocs = async (workspaceId) => {
    try {
      const res = await fetch(`/api/v1/documents/${workspaceId}`, { headers: getHeaders() });
      if (res.status === 401) { handleLogout(); return; }
      if (!res.ok) return;
      const data = await res.json();
      setWorkspaceDocs(data);
    } catch (err) {
      console.error('Error fetching workspace documents:', err);
    }
  };

  // Terminal statuses — polling stops when all docs reach one of these
  const TERMINAL_STATUSES = ['indexed', 'failed', 'missing'];

  const startDocPolling = (workspaceId) => {
    // Clear any existing polling interval
    if (docPollingRef.current) clearInterval(docPollingRef.current);

    docPollingRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/v1/documents/${workspaceId}`, { headers: getHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        setWorkspaceDocs(data);

        // Stop polling when all docs are in a terminal state
        const allDone = data.every(d => TERMINAL_STATUSES.includes(d.status));
        if (allDone) {
          clearInterval(docPollingRef.current);
          docPollingRef.current = null;
        }
      } catch (err) {
        console.error('Doc polling error:', err);
      }
    }, 2000);
  };

  // Cleanup polling on unmount or when workspace changes
  useEffect(() => {
    return () => {
      if (docPollingRef.current) clearInterval(docPollingRef.current);
    };
  }, [activeWorkspace?.id]);

  const {
    chatFolders,
    setChatFolders,
    fetchChatFolders,
    handleCreateFolder,
    handleRenameFolder,
    handleDeleteFolder,
    handleMoveChat,
  } = useChatFolders({ getHeaders, handleLogout, activeWorkspace, setChats });


  useEffect(() => {
    if (activeWorkspace && token) {
      fetchAndLoadInitialChat(activeWorkspace.id);
      fetchWorkspaceDocs(activeWorkspace.id);
      fetchChatFolders(activeWorkspace.id);
    }
  }, [activeWorkspace, token]);

  const handleSelectChat = async (chat) => {
    await loadChat(chat.id);
  };

  const handleNewChat = async () => {
    if (!activeWorkspace) return;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    try {
      const res = await fetch(`/api/v1/chat/sessions/${activeWorkspace.id}`, {
        method: 'POST',
        headers: getHeaders()
      });
      if (res.status === 401) { handleLogout(); return; }
      if (!res.ok) return;
      const newChat = await res.json();
      setChats(prev => [newChat, ...prev]);
      setActiveChatId(newChat.id);
      setActiveView('chat');
      setMessages([{ role: 'assistant', content: 'New chat started. What shall we work on?' }]);
    } catch (err) {
      console.error('Error creating chat:', err);
    }
  };

  const handleDeleteChat = async (chatId) => {
    try {
      await fetch(`/api/v1/chat/session/${chatId}`, {
        method: 'DELETE',
        headers: getHeaders()
      });
      setChats(prev => {
        const remaining = prev.filter(c => c.id !== chatId);
        return remaining;
      });
      if (activeChatId === chatId) {
        // Switch to next available chat
        const remaining = chats.filter(c => c.id !== chatId);
        if (remaining.length > 0) {
          await loadChat(remaining[0].id);
        } else {
          setActiveChatId(null);
          setMessages([{ role: 'assistant', content: 'Start a new chat to begin.' }]);
        }
      }
    } catch (err) {
      console.error('Error deleting chat:', err);
    }
  };

  const handleRenameChat = async (chatId, newTitle) => {
    try {
      const res = await fetch(`/api/v1/chat/session/${chatId}`, {
        method: 'PATCH',
        headers: getHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ title: newTitle })
      });
      if (res.status === 401) { handleLogout(); return; }
      if (!res.ok) return;
      
      const data = await res.json();
      setChats(prev => prev.map(c => 
        c.id === chatId ? { ...c, title: data.title } : c
      ));
    } catch (err) {
      console.error('Error renaming chat:', err);
    }
  };

  const handlePinChat = async (chatId, currentIsPinned) => {
    try {
      const newPinned = !currentIsPinned;
      const res = await fetch(`/api/v1/chat/session/${chatId}/pin`, {
        method: 'PATCH',
        headers: getHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ is_pinned: newPinned })
      });
      if (res.status === 401) { handleLogout(); return; }
      if (!res.ok) return;

      const data = await res.json();
      setChats(prev => {
        const next = prev.map(c => 
          c.id === chatId ? { ...c, is_pinned: data.is_pinned } : c
        );
        // Re-sort chats: pinned first, then by created_at desc
        return next.sort((a, b) => {
          if (a.is_pinned !== b.is_pinned) {
            return a.is_pinned ? -1 : 1;
          }
          return new Date(b.created_at) - new Date(a.created_at);
        });
      });
    } catch (err) {
      console.error('Error pinning chat:', err);
    }
  };

  const handleSendMessage = async (text) => {
    if (!activeWorkspace) {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Please create or select a workspace first.' }]);
      return;
    }
    setMessages(prev => [...prev, { role: 'user', content: text, timestamp: new Date() }]);
    setMessages(prev => [...prev, { role: 'assistant', content: '', timestamp: new Date() }]);
    setIsGenerating(true);

    let currentChatId = activeChatId;
    const controller = new AbortController();
    abortControllerRef.current = controller;

    let isTimeout = false;
    let timeoutId = setTimeout(() => {
      isTimeout = true;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    }, 180000); // 180 seconds inactivity timeout

    const resetTimeout = () => {
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        isTimeout = true;
        if (abortControllerRef.current) {
          abortControllerRef.current.abort();
        }
      }, 180000);
    };

    try {
        const savedProvider = localStorage.getItem('llm_provider') || 'ollama';
        const savedBaseUrl = localStorage.getItem('llm_base_url') || undefined;
        const savedApiKey = localStorage.getItem('llm_api_key') || undefined;
        const savedCustomModel = localStorage.getItem('llm_custom_model') || undefined;

        const effectiveModel = savedProvider === 'openai_compatible'
          ? (savedCustomModel || currentModel || 'deepseek-chat')
          : (currentModel || undefined);

        const response = await fetch('/api/v1/chat/', {
          method: 'POST',
          headers: getHeaders({ 'Content-Type': 'application/json' }),
          signal: controller.signal,
          body: JSON.stringify({
            workspace_id: activeWorkspace.id,
            chat_id: activeChatId,
            message: text,
            model: effectiveModel,
            provider: savedProvider,
            base_url: savedBaseUrl,
            api_key: savedApiKey,
            stream: true,
            use_knowledge_base: useKb,
            use_web_search: useWebSearch,
            use_hybrid_search: localStorage.getItem('rag_hybrid_search') !== 'false',
            use_query_rewriting: localStorage.getItem('rag_query_rewriting') !== 'false',
            use_context_compression: localStorage.getItem('rag_context_compression') !== 'false'
          })
        });

      if (response.status === 401) { handleLogout(); return; }
      if (!response.ok) throw new Error(`API error: ${response.status}`);

      const chatIdHeader = response.headers.get('X-Chat-ID');
      if (chatIdHeader) {
        const newChatId = parseInt(chatIdHeader, 10);
        currentChatId = newChatId;
        if (!activeChatId) {
          setActiveChatId(newChatId);
          // Refresh chat list to show the new titled chat without overriding active messages
          refreshChatList(activeWorkspace.id).catch(() => {});
        }
      }

      const chatRenamedHeader = response.headers.get('X-Chat-Renamed');
      if (chatRenamedHeader === 'true') {
        refreshChatList(activeWorkspace.id).catch(() => {});
      }

      const kbUsedHeader = response.headers.get('X-KB-Used') === 'true';
      const kbSourcesHeader = response.headers.get('X-KB-Sources') ? decodeURIComponent(response.headers.get('X-KB-Sources')) : '';
      const wsSourcesHeader = response.headers.get('X-WS-Sources') ? decodeURIComponent(response.headers.get('X-WS-Sources')) : '';
      const webSourcesHeader = response.headers.get('X-Web-Sources') ? decodeURIComponent(response.headers.get('X-Web-Sources')) : '';
      const webSourcesUrlsHeader = response.headers.get('X-Web-Sources-Urls') ? decodeURIComponent(response.headers.get('X-Web-Sources-Urls')) : '';

      const webTitles = webSourcesHeader ? webSourcesHeader.split(',').filter(Boolean) : [];
      const webUrls = webSourcesUrlsHeader ? webSourcesUrlsHeader.split(',').filter(Boolean) : [];
      const webSourcesData = webTitles.map((title, idx) => ({
        title,
        url: webUrls[idx] || ''
      }));

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      const streamStartTime = performance.now();
      let fullText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetTimeout(); // Reset the inactivity timeout upon receiving a chunk
        fullText += decoder.decode(value, { stream: true });
        setMessages(prev => {
          const msgs = [...prev];
          const prevMsg = msgs[msgs.length - 1];
          msgs[msgs.length - 1] = {
            ...prevMsg,
            role: 'assistant',
            content: fullText,
            kbUsed: kbUsedHeader,
            kbSources: kbSourcesHeader ? kbSourcesHeader.split('|').filter(Boolean) : [],
            wsSources: wsSourcesHeader ? wsSourcesHeader.split('|').filter(Boolean) : [],
            webSources: webSourcesData
          };
          return msgs;
        });
      }

      if (!fullText.trim()) {
        setMessages(prev => {
          const msgs = [...prev];
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], role: 'assistant', content: NO_ANSWER_TEXT, isError: true, failedText: text };
          return msgs;
        });
        return;
      }

      const totalElapsedSec = Math.max(0.1, (performance.now() - streamStartTime) / 1000);
      const totalWords = fullText.trim().split(/\s+/).filter(Boolean).length;
      const totalTokens = Math.max(1, Math.round(totalWords * 1.3));
      const tokPerSec = (totalTokens / totalElapsedSec).toFixed(1);

      // An error message streamed by the backend is not generated text: no speed badge for it.
      if (!fullText.trimStart().startsWith('Error generating response')) setMessages(prev => {
        const msgs = [...prev];
        const prevMsg = msgs[msgs.length - 1];
        if (prevMsg && prevMsg.role === 'assistant') {
          msgs[msgs.length - 1] = {
            ...prevMsg,
            speedStats: {
              tokPerSec,
              tokens: totalTokens,
              timeSec: totalElapsedSec.toFixed(1)
            }
          };
        }
        return msgs;
      });

    } catch (err) {
      if (isTimeout) {
        const partialContent = await new Promise(resolve => {
          setMessages(prev => {
            const msgs = [...prev];
            const lastMsg = msgs[msgs.length - 1];
            const saved = lastMsg.content || '';
            lastMsg.content = saved ? saved + '\n\n*[Response timed out]*' : '*[Response timed out]*';
            resolve(lastMsg.content);
            return msgs;
          });
        });
        // Save the timed-out partial message to DB
        if (currentChatId) {
          try {
            await fetch('/api/v1/chat/save-partial', {
              method: 'POST',
              headers: getHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ chat_id: currentChatId, content: partialContent })
            });
          } catch (saveErr) { console.error('Failed to save partial message:', saveErr); }
        }
      } else if (err.name === 'AbortError') {
        // User stopped generation manually — save whatever we have
        let partialContent = '';
        setMessages(prev => {
          const msgs = [...prev];
          const lastMsg = msgs[msgs.length - 1];
          if (lastMsg.content === '') {
            lastMsg.content = '*[Generation stopped]*';
          }
          partialContent = lastMsg.content;
          return msgs;
        });
        // Save the stopped/partial message to DB
        if (currentChatId) {
          try {
            await fetch('/api/v1/chat/save-partial', {
              method: 'POST',
              headers: getHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ chat_id: currentChatId, content: partialContent })
            });
          } catch (saveErr) { console.error('Failed to save partial message:', saveErr); }
        }
      } else {
        console.error('Error sending message:', err);
        setMessages(prev => {
          const msgs = [...prev];
          msgs[msgs.length - 1] = { 
            ...msgs[msgs.length - 1], 
            role: 'assistant', 
            content: `Error: ${err.message}`,
            isError: true,
            failedText: text 
          };
          return msgs;
        });
      }
    } finally {
      clearTimeout(timeoutId);
      setIsGenerating(false);
      abortControllerRef.current = null;
    }
  };

  const handleStopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
  };


  // ── Global Search Navigation ──
  const handleNavigateFromSearch = async (item) => {
    if (item.type === 'workspace') {
      const ws = workspaces.find(w => w.id === item.id);
      if (ws) handleSelectWorkspace(ws);
      return;
    }
    if (item.type === 'document') {
      if (item.doc_type === 'knowledge_base') {
        setActiveView('knowledge-base');
      } else {
        const ws = workspaces.find(w => w.id === item.workspace_id);
        if (ws) handleSelectWorkspace(ws);
      }
      return;
    }
    if (item.type === 'chat') {
      const ws = workspaces.find(w => w.id === item.workspace_id);
      if (ws && ws.id !== activeWorkspace?.id) {
        // Switch workspace first, then load the chat
        setActiveWorkspace(ws);
        setActiveView('chat');
        // Load chat after workspace change completes
        await loadChat(item.id);
      } else {
        setActiveView('chat');
        await loadChat(item.id);
      }
    }
  };

  const handleTruncateChat = async (keepCount) => {
    if (!activeChatId) return false;
    try {
      const res = await fetch(`/api/v1/chat/truncate`, {
        method: 'POST',
        headers: getHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          chat_id: activeChatId,
          keep_count: keepCount,
        })
      });
      if (res.status === 401) { handleLogout(); return false; }
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      return true;
    } catch (err) {
      console.error('Error truncating chat:', err);
      return false;
    }
  };

  const handleRegenerateMessage = async (index) => {
    if (index <= 0) return;
    const userMsgIndex = index - 1;
    const userMsg = messages[userMsgIndex];
    if (userMsg.role !== 'user') return;
    
    const success = await handleTruncateChat(userMsgIndex);
    if (!success) return;
    
    setMessages(prev => prev.slice(0, userMsgIndex));
    await handleSendMessage(userMsg.content);
  };

  const handleEditMessage = async (index, newText) => {
    const success = await handleTruncateChat(index);
    if (!success) return;

    setMessages(prev => prev.slice(0, index));
    await handleSendMessage(newText);
  };

  const handleExportChat = (format = 'md') => {
    exportChat(messages, chats, activeChatId, format);
  };

  const handleFileUpload = async (file) => {
    if (!activeWorkspace) { toast.warning('Please create or select a workspace before uploading files.'); return; }
    const formData = new FormData();
    formData.append('file', file);
    setMessages(prev => [...prev, { role: 'system', content: `Uploading ${file.name}…` }]);

    let response;
    try {
      response = await fetch(`/api/v1/documents/${activeWorkspace.id}/upload`, {
        method: 'POST',
        headers: getHeaders(),
        body: formData,
      });
    } catch (networkErr) {
      // Network-level failure (CORS, DNS, offline, etc.)
      const errorMsg = `Network error — please check your connection and try again. (${networkErr.message})`;
      setMessages(prev => {
        const msgs = [...prev];
        msgs[msgs.length - 1] = { role: 'system', content: `❌ Failed to upload ${file.name}: ${errorMsg}` };
        return msgs;
      });
      throw new Error(errorMsg);
    }

    if (response.status === 401) { handleLogout(); return; }
    if (!response.ok) {
      let errorMsg = 'Upload failed';
      // Determine a human-readable error based on HTTP status
      if (response.status === 413) {
        const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
        errorMsg = `File too large (${sizeMB} MB). Maximum allowed upload size is 100 MB.`;
      } else if (response.status === 502 || response.status === 503 || response.status === 504) {
        errorMsg = `Server is temporarily unavailable (HTTP ${response.status}). Please try again in a moment.`;
      } else {
        // Try to parse JSON detail from the backend
        const err = await response.json().catch(() => null);
        if (err && err.detail) {
          errorMsg = err.detail;
        } else {
          // Fallback: try to read the raw text body for clues
          const rawText = err ? JSON.stringify(err) : await response.text().catch(() => '');
          errorMsg = `Upload failed (HTTP ${response.status})${rawText ? ': ' + rawText.substring(0, 200) : ''}`;
        }
      }
      setMessages(prev => {
        const msgs = [...prev];
        msgs[msgs.length - 1] = { role: 'system', content: `❌ Failed to upload ${file.name}: ${errorMsg}` };
        return msgs;
      });
      throw new Error(errorMsg);
    }

    const newDoc = await response.json();

    // Add the doc immediately into local state so it appears in Document Manager instantly
    setWorkspaceDocs(prev => {
      // avoid duplicates
      const withoutNew = prev.filter(d => d.id !== newDoc.id);
      return [newDoc, ...withoutNew];
    });

    // Start polling until indexing completes
    startDocPolling(activeWorkspace.id);

    setMessages(prev => {
      const msgs = [...prev];
      msgs[msgs.length - 1] = {
        role: 'system',
        content: `📄 ${file.name} uploaded. Indexing in progress — you can continue chatting while it processes.`
      };
      return msgs;
    });
  };

  const handleDeleteDocument = async (documentId) => {
    if (!activeWorkspace) return;
    try {
      const res = await fetch(`/api/v1/documents/${activeWorkspace.id}/documents/${documentId}`, {
        method: 'DELETE',
        headers: getHeaders()
      });
      if (res.status === 401) { handleLogout(); return; }
      if (!res.ok) return;
      setWorkspaceDocs(prev => prev.filter(d => d.id !== documentId));
    } catch (err) {
      console.error('Error deleting document:', err);
    }
  };

  // ── Workspace creation with name prompt ──
  const openNewWorkspaceModal = () => {
    setNewWsName('');
    setShowWsModal(true);
    setTimeout(() => wsNameInputRef.current?.focus(), 50);
  };

  const handleNewWorkspace = async (nameOverride) => {
    const wsName = typeof nameOverride === 'string' && nameOverride
      ? nameOverride
      : newWsName.trim() || `Workspace ${workspaces.length + 1}`;
    setShowWsModal(false);
    setWsLoading(true);
    setWsError(null);
    try {
      const res = await fetch('/api/v1/workspaces/', {
        method: 'POST',
        headers: getHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: wsName })
      });
      if (res.status === 401) { handleLogout(); return; }
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Server error ${res.status}`);
      }
      const newWs = await res.json();
      setWorkspaces(prev => [...prev, newWs]);
      setActiveWorkspace(newWs);
      setChats([]);
      setActiveChatId(null);
      setMessages([{ role: 'assistant', content: `Workspace "${wsName}" created. What shall we work on?` }]);
      setActiveView('chat');
    } catch (err) {
      console.error('Error creating workspace:', err);
      setWsError(err.message);
    } finally {
      setWsLoading(false);
    }
  };

  const handleSelectWorkspace = (ws) => {
    // Stop any ongoing stream before switching workspaces
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setActiveWorkspace(ws);
    setActiveView('chat');
    setChatSearchQuery('');
  };

  // ── Not logged in ──
  if (!token) {
    return <LoginSignup onLoginSuccess={(t) => setToken(t)} />;
  }

  // ── Onboarding ──
  if (!onboardingDone) {
    return <OnboardingWizard token={token} onComplete={() => {
      localStorage.setItem('starkllm_onboarding_done', 'true');
      setOnboardingDone(true);
    }} />;
  }

  // ── Connection Loading state ──
  if (token && (loadingWorkspaces || !hasFetchedWorkspaces) && !workspacesError && workspaces.length === 0) {
    return (
      <div style={{
        display: 'flex', width: '100vw', height: '100vh',
        alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: '1.5rem',
        background: 'var(--bg-primary)'
      }}>
        <img src="/Logo.png" alt="StarkLLM" style={{ width: 144, height: 'auto', marginBottom: 12 }} />
        <h3 style={{ color: '#ffffff', fontWeight: 700, fontSize: '1.4rem' }}>Connecting to StarkLLM backend...</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '1rem', fontWeight: 500 }}>Please wait a moment while components load.</p>
      </div>
    );
  }

  // ── Connection Error state ──
  if (token && workspacesError && workspaces.length === 0) {
    return (
      <div style={{
        display: 'flex', width: '100vw', height: '100vh',
        alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: '1.5rem',
        background: 'var(--bg-primary)'
      }}>
        <img src="/Logo.png" alt="StarkLLM" style={{ width: 144, height: 'auto', marginBottom: 12 }} />
        <h3 style={{ color: 'var(--danger)', fontWeight: 700, fontSize: '1.4rem' }}>Connection Failed</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '1rem', textAlign: 'center', maxWidth: 400, lineHeight: 1.6, padding: '0 1rem' }}>
          {workspacesError}
        </p>
        <div style={{ display: 'flex', gap: '12px', marginTop: 12 }}>
          <button onClick={() => fetchWorkspaces(0)} className="btn-primary" style={{ padding: '12px 24px', fontSize: '0.95rem', fontWeight: 600 }}>
            Retry Connection
          </button>
          <button onClick={handleLogout} className="btn-secondary" style={{ padding: '12px 24px', fontSize: '0.95rem', fontWeight: 600 }}>
            Logout
          </button>
        </div>
      </div>
    );
  }

  // ── No workspace (new user) ──
  if (hasFetchedWorkspaces && !activeWorkspace && token && workspaces.length === 0 && activeView !== 'settings') {
    return (
      <div style={{
        display: 'flex', width: '100vw', height: '100vh',
        alignItems: 'center', justifyContent: 'center',
        flexDirection: 'column', gap: '1.25rem',
        background: 'var(--bg-primary)'
      }}>
        <img src="/Logo.png" alt="StarkLLM" style={{ width: 144, height: 'auto', marginBottom: 12 }} />
        <h2 style={{ color: '#ffffff', fontWeight: 700, fontSize: '1.75rem' }}>Welcome to StarkLLM!</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '1rem', textAlign: 'center', maxWidth: 380, lineHeight: 1.6 }}>
          You don't have any workspaces yet. Create one to get started.
        </p>
        {wsError && (
          <p style={{ color: 'var(--danger)', background: 'rgba(239,68,68,0.1)', padding: '0.75rem 1.25rem', borderRadius: 8, fontSize: '0.95rem', fontWeight: 500 }}>
            ⚠️ {wsError}
          </p>
        )}
        <button
          onClick={openNewWorkspaceModal}
          disabled={wsLoading}
          className="btn-primary"
          style={{ fontSize: '0.95rem', padding: '12px 24px', fontWeight: 600 }}
        >
          {wsLoading ? 'Creating…' : '+ Create My First Workspace'}
        </button>
        <button onClick={handleLogout} className="btn-danger" style={{ fontSize: '0.9rem', padding: '10px 20px', fontWeight: 600 }}>
          Logout
        </button>

        {showWsModal && (
          <WorkspaceNameModal
            value={newWsName}
            onChange={setNewWsName}
            onConfirm={() => handleNewWorkspace(newWsName)}
            onCancel={() => setShowWsModal(false)}
            inputRef={wsNameInputRef}
          />
        )}
      </div>
    );
  }

  // ── Main app layout ──
  return (
    <div style={{ display: 'flex', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <Sidebar
        workspaces={workspaces}
        activeWorkspace={activeWorkspace}
        onSelectWorkspace={handleSelectWorkspace}
        onNewWorkspace={openNewWorkspaceModal}
        activeView={activeView}
        onViewChange={setActiveView}
        onLogout={handleLogout}
        username={username}
        token={token}
        chats={chats}
        activeChatId={activeChatId}
        onSelectChat={handleSelectChat}
        onNewChat={handleNewChat}
        onDeleteChat={handleDeleteChat}
        onRenameChat={handleRenameChat}
        onPinChat={handlePinChat}
        chatSearchQuery={chatSearchQuery}
        setChatSearchQuery={setChatSearchQuery}
        workspaceDocs={workspaceDocs}
        onDeleteDocument={handleDeleteDocument}
        onManageDocuments={() => setShowDocManager(true)}
        onManageMemories={() => setShowMemoryManager(true)}
        onGlobalSearch={() => setShowGlobalSearch(true)}
        chatFolders={chatFolders}
        onCreateFolder={handleCreateFolder}
        onRenameFolder={handleRenameFolder}
        onDeleteFolder={handleDeleteFolder}
        onMoveChat={handleMoveChat}
        currentModel={currentModel}
        onOpenModelHub={() => setShowModelHub(true)}
        onOpenStudio={() => setShowStudio(true)}
      />

      {/* Main content */}
      <ErrorBoundary>
        {activeView === 'dashboard' && (
          <Dashboard
            token={token}
            username={username}
            workspaces={workspaces}
            onNewWorkspace={openNewWorkspaceModal}
            onViewChange={setActiveView}
            onSelectWorkspace={handleSelectWorkspace}
            chats={chats}
            onSelectChat={handleSelectChat}
          />
        )}

        {activeView === 'knowledge-base' && (
          <KnowledgeBase token={token} />
        )}

        {activeView === 'settings' && (
          <Settings token={token} username={username} activeWorkspace={activeWorkspace} />
        )}

        {activeView === 'chat' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <HealthBanner token={token} />
            <ChatArea 
              messages={messages} 
              onRegenerate={handleRegenerateMessage}
              onEdit={handleEditMessage}
              onExport={handleExportChat}
              onSummarize={activeChatId ? handleSummarizeChat : null}
              onRetryMessage={handleSendMessage}
              onSelectStarter={handleSendMessage}
              workspaceId={activeWorkspace?.id}
              token={token}
            />
            <InputBar 
              onSendMessage={handleSendMessage} 
              onFileUpload={handleFileUpload}
              useKb={useKb}
              onToggleKb={() => setUseKb(!useKb)}
              useWebSearch={useWebSearch}
              onToggleWebSearch={() => setUseWebSearch(!useWebSearch)}
              isGenerating={isGenerating}
              onStopGeneration={handleStopGeneration}
              token={token}
              activeWorkspace={activeWorkspace}
              onOpenKbSettings={() => setShowKbModal(true)}
            />
          </div>
        )}
      </ErrorBoundary>

      <WorkspaceKBModal
        isOpen={showKbModal}
        onClose={() => setShowKbModal(false)}
        activeWorkspace={activeWorkspace}
        token={token}
        onWorkspaceUpdated={(updatedWs) => {
          setActiveWorkspace(updatedWs);
          setWorkspaces(prev => prev.map(w => w.id === updatedWs.id ? updatedWs : w));
        }}
      />

      {/* Workspace name modal */}
      {showWsModal && (
        <WorkspaceNameModal
          value={newWsName}
          onChange={setNewWsName}
          onConfirm={() => handleNewWorkspace(newWsName)}
          onCancel={() => setShowWsModal(false)}
          inputRef={wsNameInputRef}
        />
      )}

      {/* Document Manager Modal */}
      {showDocManager && activeWorkspace && (
        <DocumentManager
          isOpen={showDocManager}
          onClose={() => setShowDocManager(false)}
          workspaceId={activeWorkspace.id}
          documents={workspaceDocs}
          onDeleteDocument={handleDeleteDocument}
          token={token}
        />
      )}

      {/* Memory Manager Modal */}
      {showMemoryManager && activeWorkspace && (
        <MemoryManager
          workspace={activeWorkspace}
          token={token}
          onClose={() => setShowMemoryManager(false)}
        />
      )}

      {/* Global Search & Command Palette Modal */}
      {showGlobalSearch && (
        <GlobalSearch
          token={token}
          workspaces={workspaces}
          activeWorkspace={activeWorkspace}
          chats={chats}
          currentModel={currentModel}
          onClose={() => setShowGlobalSearch(false)}
          onNavigate={handleNavigateFromSearch}
          onNewChat={() => {
            setShowGlobalSearch(false);
            handleNewChat();
          }}
          onSelectWorkspace={(ws) => {
            setShowGlobalSearch(false);
            handleSelectWorkspace(ws);
          }}
          onOpenSettings={() => {
            setShowGlobalSearch(false);
            setActiveView('settings');
          }}
          onOpenDocuments={() => {
            setShowGlobalSearch(false);
            setShowDocManager(true);
          }}
          onOpenModelHub={() => {
            setShowGlobalSearch(false);
            setShowModelHub(true);
          }}
          onOpenPromptTemplates={() => {
            setShowGlobalSearch(false);
            setActiveView('settings');
          }}
          onOpenMemoryManager={() => {
            setShowGlobalSearch(false);
            setShowMemoryManager(true);
          }}
          onOpenKnowledgeBase={() => {
            setShowGlobalSearch(false);
            setActiveView('knowledge-base');
          }}
          onClearChat={() => {
            setShowGlobalSearch(false);
            setMessages([{ role: 'assistant', content: 'Chat reset. What would you like to explore next?' }]);
          }}
        />
      )}

      {/* Chat Summary Modal */}
      {showSummaryModal && (
        <SummaryModal
          chatTitle={summaryChatTitle}
          summary={summaryText}
          loading={summaryLoading}
          error={summaryError}
          onClose={() => setShowSummaryModal(false)}
          onCopy={handleCopySummary}
          copied={summaryCopied}
        />
      )}

      {/* StarkLLM Model Hub Modal */}
      <ModelHubModal
        isOpen={showModelHub}
        onClose={() => setShowModelHub(false)}
        token={token}
        currentModel={currentModel}
        onModelSelect={(modelName) => {
          setCurrentModel(modelName);
          localStorage.setItem('default_model', modelName);
        }}
      />

      {/* AI Studio Modal - Offline Document Synthesis */}
      <StudioModal
        isOpen={showStudio}
        onClose={() => setShowStudio(false)}
        workspaceId={activeWorkspace?.id}
        token={token}
        selectedModel={currentModel}
      />
    </div>
  );
}

// ── Workspace Name Modal ──────────────────────────────────────────────
function WorkspaceNameModal({ value, onChange, onConfirm, onCancel, inputRef }) {
  const handleKey = (e) => {
    if (e.key === 'Enter') onConfirm();
    if (e.key === 'Escape') onCancel();
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    }}>
      <div style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)',
        borderRadius: 14,
        padding: '2rem',
        width: 380,
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
        boxShadow: '0 24px 80px rgba(0,0,0,0.5)'
      }}>
        <h3 style={{ margin: 0, color: 'var(--text-primary)', fontWeight: 700 }}>New Workspace</h3>
        <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
          Give your workspace a name to get started.
        </p>
        <input
          ref={inputRef}
          type="text"
          placeholder="e.g. Research, Work, Personal…"
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={handleKey}
          style={{
            padding: '0.65rem 1rem',
            background: 'var(--bg-primary)',
            border: '1px solid var(--border-color)',
            borderRadius: 8,
            color: 'var(--text-primary)',
            fontSize: '0.9rem',
            outline: 'none',
          }}
        />
        <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              padding: '0.5rem 1.1rem',
              background: 'transparent',
              border: '1px solid var(--border-color)',
              borderRadius: 8,
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '0.875rem'
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="btn-primary"
            style={{ padding: '0.5rem 1.3rem', fontSize: '0.875rem' }}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
