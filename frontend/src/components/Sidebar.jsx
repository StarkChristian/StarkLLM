import React, { useState, useRef, useEffect, useMemo } from 'react';
import styles from './Sidebar.module.css';
import {
  LayoutDashboard, MessageSquare, Database, Settings,
  Plus, LogOut, ChevronRight, Trash2, Check, X,
  MessageCircle, ChevronDown, FileText, FolderOpen, BrainCircuit,
  Pencil, Search, Pin, PinOff, AlignLeft, SearchCheck,
  FolderPlus, Folder, MoveRight, Cpu, Sparkles
} from 'lucide-react';
import { SidebarStatusDot } from './SystemStatusWidget';
import EmptyState from './EmptyState';

const NAV_ITEMS = [
  { id: 'dashboard',      label: 'Dashboard',      icon: LayoutDashboard },
  { id: 'chat',           label: 'Chat',            icon: MessageSquare },
  { id: 'knowledge-base', label: 'Knowledge Base',  icon: Database },
  { id: 'settings',       label: 'Settings',        icon: Settings },
];

export default function Sidebar({
  workspaces,
  activeWorkspace,
  onSelectWorkspace,
  onNewWorkspace,
  activeView,
  onViewChange,
  onLogout,
  username,
  token,
  // Multi-chat props
  chats,
  activeChatId,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  onRenameChat,
  onPinChat,
  // Search props (lifted to App)
  chatSearchQuery,
  setChatSearchQuery,
  // Workspace documents props
  workspaceDocs = [],
  onDeleteDocument,
  onManageDocuments,
  onManageMemories,
  // Global search
  onGlobalSearch,
  // Folder props
  chatFolders = [],
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveChat,
  // Model Hub
  currentModel,
  onOpenModelHub,
}) {
  const isChat = activeView === 'chat';
  const [deletingChatId, setDeletingChatId] = useState(null);
  const [deletingDocId, setDeletingDocId] = useState(null);
  const [deletingFolderId, setDeletingFolderId] = useState(null);
  const [wsDropdownOpen, setWsDropdownOpen] = useState(false);
  const [docsCollapsed, setDocsCollapsed] = useState(false);
  const [editingChatId, setEditingChatId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  
  const [collapsedFolders, setCollapsedFolders] = useState({});
  const [editingFolderId, setEditingFolderId] = useState(null);
  const [editFolderTitle, setEditFolderTitle] = useState('');
  const [movingChatId, setMovingChatId] = useState(null);

  const wsDropdownRef = useRef(null);
  const editInputRef = useRef(null);
  const searchInputRef = useRef(null);
  const folderEditInputRef = useRef(null);

  // Group chats
  const groupedChats = useMemo(() => {
    const groups = {
      unassigned: [],
      folders: {}
    };
    chatFolders.forEach(f => {
      groups.folders[f.id] = { ...f, chats: [] };
    });

    chats.forEach(c => {
      if (c.folder_id && groups.folders[c.folder_id]) {
        groups.folders[c.folder_id].chats.push(c);
      } else {
        groups.unassigned.push(c);
      }
    });
    return groups;
  }, [chats, chatFolders]);

  const displayChats = chats;

  // Auto-focus the rename input when editing starts
  useEffect(() => {
    if (editingChatId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingChatId]);

  const startRename = (e, chat) => {
    e.stopPropagation();
    setEditingChatId(chat.id);
    setEditTitle(chat.title || '');
    setDeletingChatId(null); // cancel any pending delete
  };

  const submitRename = (e) => {
    e?.stopPropagation?.();
    if (editTitle.trim() && editTitle.trim() !== (chats.find(c => c.id === editingChatId)?.title || '')) {
      onRenameChat(editingChatId, editTitle.trim());
    }
    setEditingChatId(null);
  };

  const cancelRename = (e) => {
    e?.stopPropagation?.();
    setEditingChatId(null);
  };

  const handleRenameKeyDown = (e) => {
    if (e.key === 'Enter') submitRename(e);
    if (e.key === 'Escape') cancelRename(e);
  };

  // Format timestamp nicely
  const formatTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    const isYesterday = d.toDateString() === yesterday.toDateString();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) return time;
    if (isYesterday) return `Yesterday`;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  // Close workspace dropdown when clicking outside
  useEffect(() => {
    const handler = (e) => {
      if (wsDropdownRef.current && !wsDropdownRef.current.contains(e.target)) {
        setWsDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleDeleteChat = (e, chatId) => {
    e.stopPropagation();
    setDeletingChatId(chatId);
  };

  const confirmDeleteChat = (e, chatId) => {
    e.stopPropagation();
    onDeleteChat(chatId);
    setDeletingChatId(null);
  };

  const cancelDeleteChat = (e) => {
    e.stopPropagation();
    setDeletingChatId(null);
  };

  const handleDeleteDoc = (e, docId) => {
    e.stopPropagation();
    setDeletingDocId(docId);
  };

  const confirmDeleteDoc = (e, docId) => {
    e.stopPropagation();
    onDeleteDocument(docId);
    setDeletingDocId(null);
  };

  const cancelDeleteDoc = (e) => {
    e.stopPropagation();
    setDeletingDocId(null);
  };

  const startRenameFolder = (e, folder) => {
    e.stopPropagation();
    setEditingFolderId(folder.id);
    setEditFolderTitle(folder.name || '');
    setDeletingFolderId(null);
  };

  const submitRenameFolder = (e) => {
    e?.stopPropagation?.();
    if (editFolderTitle.trim() && editFolderTitle.trim() !== (chatFolders.find(f => f.id === editingFolderId)?.name || '')) {
      onRenameFolder(editingFolderId, editFolderTitle.trim());
    }
    setEditingFolderId(null);
  };

  const cancelRenameFolder = (e) => {
    e?.stopPropagation?.();
    setEditingFolderId(null);
  };

  const handleFolderRenameKeyDown = (e) => {
    if (e.key === 'Enter') submitRenameFolder(e);
    if (e.key === 'Escape') cancelRenameFolder(e);
  };

  const handleNewFolderPrompt = () => {
    const name = window.prompt("Enter new folder name:");
    if (name && name.trim()) {
      onCreateFolder(name.trim());
    }
  };

  const renderChatItem = (chat) => {
    return (
      <div
        key={chat.id}
        className={`${styles.chatItem} ${activeChatId === chat.id ? styles.chatActive : ''}`}
      >
        {deletingChatId === chat.id ? (
          /* ── Delete confirmation row ── */
          <div className={styles.deleteConfirm}>
            <span className={styles.deletePrompt}>Delete?</span>
            <button className={styles.confirmBtn} onClick={(e) => confirmDeleteChat(e, chat.id)} title="Confirm">
              <Check size={11} />
            </button>
            <button className={styles.cancelBtn} onClick={cancelDeleteChat} title="Cancel">
              <X size={11} />
            </button>
          </div>
        ) : editingChatId === chat.id ? (
          /* ── Inline rename row ── */
          <div className={styles.renameRow}>
            <input
              ref={editInputRef}
              className={styles.renameInput}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={handleRenameKeyDown}
              onBlur={submitRename}
              maxLength={80}
            />
            <button className={styles.confirmBtn} onClick={submitRename} title="Save" onMouseDown={e => e.preventDefault()}>
              <Check size={11} />
            </button>
            <button className={styles.cancelBtn} onClick={cancelRename} title="Cancel" onMouseDown={e => e.preventDefault()}>
              <X size={11} />
            </button>
          </div>
        ) : (
          /* ── Normal chat row ── */
          <>
            <button
              className={styles.chatSelectBtn}
              onClick={() => onSelectChat(chat)}
              onDoubleClick={(e) => startRename(e, chat)}
            >
              <MessageCircle size={13} className={styles.chatIcon} />
              <div className={styles.chatInfo}>
                <span className={styles.chatName}>
                  {chat.is_pinned && <Pin size={10} className={styles.pinnedIcon} />}
                  {chat.title || 'Untitled'}
                </span>
                <div className={styles.chatMeta}>
                  {chat.content_match && chatSearchQuery.trim() && (
                    <span className={styles.contentMatchBadge} title="Matched in message content">
                      <AlignLeft size={9} />
                      in messages
                    </span>
                  )}
                  {chat.created_at && (
                    <span className={styles.chatTime}>{formatTime(chat.created_at)}</span>
                  )}
                </div>
              </div>
            </button>
            <div className={styles.chatActions}>
              <button
                className={styles.chatActionBtn}
                onClick={(e) => { e.stopPropagation(); onPinChat(chat.id, chat.is_pinned); }}
                title={chat.is_pinned ? "Unpin chat" : "Pin chat"}
              >
                {chat.is_pinned ? <PinOff size={11} /> : <Pin size={11} />}
              </button>
              
              <div style={{ position: 'relative' }}>
                <button
                  className={`${styles.chatActionBtn} ${movingChatId === chat.id ? styles.chatActionActive : ''}`}
                  onClick={(e) => { e.stopPropagation(); setMovingChatId(movingChatId === chat.id ? null : chat.id); }}
                  title="Move to folder"
                >
                  <MoveRight size={11} />
                </button>
                {movingChatId === chat.id && (
                  <div className={styles.moveDropdown} onClick={(e) => e.stopPropagation()}>
                    <div className={styles.moveDropdownHeader}>Move to...</div>
                    <button className={styles.moveDropdownItem} onClick={() => { onMoveChat(chat.id, null); setMovingChatId(null); }}>
                      <Folder size={12} /> Uncategorized
                    </button>
                    {chatFolders.map(f => (
                      <button key={f.id} className={styles.moveDropdownItem} onClick={() => { onMoveChat(chat.id, f.id); setMovingChatId(null); }}>
                        <Folder size={12} /> {f.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button
                className={styles.chatActionBtn}
                onClick={(e) => startRename(e, chat)}
                title="Rename chat"
              >
                <Pencil size={11} />
              </button>
              <button
                className={styles.chatActionBtn + ' ' + styles.chatActionDanger}
                onClick={(e) => handleDeleteChat(e, chat.id)}
                title="Delete chat"
              >
                <Trash2 size={11} />
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className={styles.container}>
      {/* ── Brand header ── */}
      <button
        className={styles.brandBtn}
        onClick={() => onViewChange('dashboard')}
        title="Go to Dashboard"
      >
        <img src="/Logo.png" alt="StarkLLM logo" className={styles.brandLogo} />
        <span className={styles.brandName}>StarkLLM</span>
      </button>

      {/* ── Global Search ── */}
      <button
        className={styles.globalSearchBtn}
        onClick={onGlobalSearch}
        title="Global Search (Ctrl+K)"
      >
        <Search size={14} className={styles.globalSearchIcon} />
        <span className={styles.globalSearchLabel}>Search everything…</span>
        <kbd className={styles.globalSearchKbd}>Ctrl K</kbd>
      </button>

      {/* ── Top navigation ── */}
      <nav className={styles.nav}>
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`${styles.navItem} ${activeView === id ? styles.navActive : ''}`}
            onClick={() => onViewChange(id)}
          >
            <Icon size={18} className={styles.navIcon} />
            <span>{label}</span>
            {activeView === id && <ChevronRight size={14} className={styles.navChevron} />}
          </button>
        ))}
      </nav>

      {/* ── Workspace Selector (compact dropdown) ── */}
      {isChat && (
        <div className={styles.wsSelector} ref={wsDropdownRef}>
          <div className={styles.wsSelectorHeader}>
            <span className={styles.sectionLabel}>Workspace</span>
            <button
              className={styles.addBtnSmall}
              onClick={onNewWorkspace}
              title="New Workspace"
            >
              <Plus size={12} />
            </button>
          </div>
          <button
            className={styles.wsDropdownTrigger}
            onClick={() => setWsDropdownOpen(prev => !prev)}
          >
            <FolderOpen size={14} className={styles.wsDropdownIcon} />
            <span className={styles.wsDropdownLabel}>
              {activeWorkspace?.name || 'Select workspace…'}
            </span>
            <ChevronDown
              size={14}
              className={`${styles.wsDropdownChevron} ${wsDropdownOpen ? styles.wsChevronOpen : ''}`}
            />
          </button>
          {wsDropdownOpen && (
            <div className={styles.wsDropdownMenu}>
              {workspaces.length === 0 && (
                <div style={{ padding: '8px' }}>
                  <EmptyState 
                    icon={FolderOpen} 
                    title="No workspaces" 
                    action={{ label: 'New Workspace', onClick: onNewWorkspace }} 
                    size="sm" 
                  />
                </div>
              )}
              {workspaces.map(ws => (
                <button
                  key={ws.id}
                  className={`${styles.wsDropdownItem} ${activeWorkspace?.id === ws.id ? styles.wsDropdownActive : ''}`}
                  onClick={() => {
                    onSelectWorkspace(ws);
                    onViewChange('chat');
                    setWsDropdownOpen(false);
                  }}
                >
                  <FolderOpen size={13} />
                  <span>{ws.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Chat sessions ── */}
      {isChat && activeWorkspace && (
        <div className={styles.chatSection}>
          <div className={styles.sectionHeaderRow}>
            <span className={styles.sectionLabel}>Chats</span>
            <div style={{ display: 'flex', gap: '4px' }}>
              <button
                className={styles.addBtnSmall}
                onClick={handleNewFolderPrompt}
                title="New Folder"
              >
                <FolderPlus size={12} />
              </button>
              <button
                className={styles.addBtnSmall}
                onClick={onNewChat}
                title="New Chat"
              >
                <Plus size={12} />
              </button>
            </div>
          </div>
          {/* ── Search Box ── */}
          <div className={styles.searchBox}>
            <Search size={13} className={styles.searchIcon} />
            <input
              ref={searchInputRef}
              type="text"
              className={styles.searchInput}
              placeholder="Search chats & messages…"
              value={chatSearchQuery}
              onChange={e => setChatSearchQuery(e.target.value)}
              aria-label="Search chats"
            />
            {chatSearchQuery && (
              <button
                className={styles.searchClear}
                onClick={() => { setChatSearchQuery(''); searchInputRef.current?.focus(); }}
                title="Clear search"
              >
                <X size={11} />
              </button>
            )}
          </div>
          <div className={styles.chatList}>
            {displayChats.length === 0 && chatSearchQuery.trim() ? (
              <div className={styles.searchEmptyState}>
                <Search size={20} className={styles.searchEmptyIcon} />
                <span>No chats match</span>
                <span className={styles.searchEmptyQuery}>"{chatSearchQuery}"</span>
              </div>
            ) : displayChats.length === 0 ? (
                <EmptyState 
                  icon={MessageSquare} 
                  title="No chats yet" 
                  action={{ label: 'Start a Chat', onClick: onNewChat }} 
                  size="sm" 
                />
            ) : null}

            {chatSearchQuery.trim() ? (
              /* Flat list if searching */
              displayChats.map(renderChatItem)
            ) : (
              /* Grouped list if not searching */
              <>
                {chatFolders.map(folder => {
                  const isCollapsed = collapsedFolders[folder.id];
                  const folderChats = groupedChats.folders[folder.id].chats;
                  return (
                    <div key={folder.id} className={styles.folderContainer}>
                      {editingFolderId === folder.id ? (
                         <div className={styles.renameRow} style={{ margin: '4px 8px' }}>
                           <input
                             ref={folderEditInputRef}
                             className={styles.renameInput}
                             value={editFolderTitle}
                             onChange={(e) => setEditFolderTitle(e.target.value)}
                             onKeyDown={handleFolderRenameKeyDown}
                             onBlur={submitRenameFolder}
                             maxLength={50}
                             autoFocus
                           />
                           <button className={styles.confirmBtn} onClick={submitRenameFolder} title="Save" onMouseDown={e => e.preventDefault()}>
                             <Check size={11} />
                           </button>
                           <button className={styles.cancelBtn} onClick={cancelRenameFolder} title="Cancel" onMouseDown={e => e.preventDefault()}>
                             <X size={11} />
                           </button>
                         </div>
                      ) : (
                        <div 
                          className={styles.folderHeader} 
                          onClick={() => setCollapsedFolders(prev => ({ ...prev, [folder.id]: !prev[folder.id] }))}
                          onDoubleClick={(e) => startRenameFolder(e, folder)}
                        >
                          <ChevronDown size={12} className={`${styles.folderChevron} ${isCollapsed ? styles.collapsed : ''}`} />
                          <Folder size={12} className={styles.folderIcon} />
                          <span className={styles.folderName}>{folder.name}</span>
                          
                          <div className={styles.folderActions} onClick={e => e.stopPropagation()}>
                            {deletingFolderId === folder.id ? (
                              <div className={styles.deleteConfirm} style={{ background: 'transparent' }}>
                                <button className={styles.confirmBtn} onClick={(e) => { e.stopPropagation(); onDeleteFolder(folder.id); setDeletingFolderId(null); }} title="Confirm Delete">
                                  <Check size={11} />
                                </button>
                                <button className={styles.cancelBtn} onClick={(e) => { e.stopPropagation(); setDeletingFolderId(null); }} title="Cancel">
                                  <X size={11} />
                                </button>
                              </div>
                            ) : (
                              <>
                                <button
                                  className={styles.chatActionBtn}
                                  onClick={(e) => startRenameFolder(e, folder)}
                                  title="Rename folder"
                                >
                                  <Pencil size={11} />
                                </button>
                                <button
                                  className={styles.chatActionBtn + ' ' + styles.chatActionDanger}
                                  onClick={(e) => { e.stopPropagation(); setDeletingFolderId(folder.id); }}
                                  title="Delete folder (chats will be uncategorized)"
                                >
                                  <Trash2 size={11} />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      )}
                      
                      {!isCollapsed && (
                        <div className={styles.folderContent}>
                          {folderChats.length === 0 ? (
                            <div className={styles.emptyFolderHint}>Empty folder</div>
                          ) : (
                            folderChats.map(renderChatItem)
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
                
                {/* Unassigned chats at the bottom */}
                {groupedChats.unassigned.map(renderChatItem)}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Workspace Documents (collapsible) ── */}
      {isChat && activeWorkspace && (
        <div className={styles.docSection}>
          <button
            className={styles.sectionHeaderRow}
            onClick={() => setDocsCollapsed(prev => !prev)}
          >
            <span className={styles.sectionLabel}>
              Documents{workspaceDocs.length > 0 ? ` (${workspaceDocs.length})` : ''}
            </span>
            <ChevronDown
              size={12}
              className={`${styles.collapseChevron} ${docsCollapsed ? styles.collapsed : ''}`}
            />
          </button>
          {!docsCollapsed && (
            <div className={styles.docList}>
              <button 
                className={styles.manageDocsBtn} 
                onClick={onManageDocuments}
              >
                <FolderOpen size={14} />
                Manage Documents
              </button>
              <button 
                className={styles.manageDocsBtn} 
                onClick={onManageMemories}
              >
                <BrainCircuit size={14} />
                Long-Term Memory
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Active Model & Model Hub ── */}
      <div className={styles.modelSection}>
        <button 
          className={styles.modelHubBtn}
          onClick={onOpenModelHub}
          title="Open StarkLLM Model Hub"
        >
          <Cpu size={18} className={styles.modelIcon} />
          <div className={styles.modelDetails}>
            <span className={styles.modelLabel}>AI Model</span>
            <span className={styles.modelValue}>{currentModel || 'Select Model...'}</span>
          </div>
          <Sparkles size={14} className={styles.modelSparkle} />
        </button>
      </div>

      {/* ── User footer ── */}
      <div className={styles.footer}>
        <div className={styles.userInfo}>
          <div className={styles.avatar}>
            {username ? username[0].toUpperCase() : '?'}
          </div>
          <span className={styles.username}>{username || 'User'}</span>
          <SidebarStatusDot token={token} />
        </div>
        <button className={styles.logoutBtn} onClick={onLogout} title="Log out">
          <LogOut size={16} />
        </button>
      </div>
    </div>
  );
}
