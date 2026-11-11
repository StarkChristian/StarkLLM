import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { FolderOpen, FolderPlus, RefreshCw, Zap, ChevronDown, ChevronRight, File, AlertCircle, CheckCircle, Clock, Loader, X, Database, Search, Eye, Info, Trash2, Copy, Check } from 'lucide-react';
import styles from './KnowledgeBase.module.css';
import EmptyState from './EmptyState';
import { serverDate } from '../utils/time';
import { UI_LOCALE } from '../utils/locale';
import { t } from '../i18n';

// ─── helpers ────────────────────────────────────────────────────────────────

function formatDate(dateStr) {
  if (!dateStr) return '—';
  const d = serverDate(dateStr);
  return d.toLocaleString(UI_LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

const STATUS_META = {
  indexed:  { icon: CheckCircle,  cls: 'indexed',  label: t('Indexed')  },
  pending:  { icon: Clock,        cls: 'pending',  label: t('Pending')  },
  indexing: { icon: Loader,       cls: 'indexing', label: t('Indexing') },
  failed:   { icon: AlertCircle,  cls: 'failed',   label: t('Failed')   },
};

// ─── sub-components ─────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.pending;
  const Icon = meta.icon;
  return (
    <span className={`${styles.badge} ${styles['badge_' + meta.cls]}`}>
      <Icon size={11} className={status === 'indexing' ? styles.spin : ''} />
      {meta.label}
    </span>
  );
}

const SUMMARY_LABEL = {
  indexed: (count) => t('{count} indexed', { count }),
  pending: (count) => t('{count} waiting', { count }),
  indexing: (count) => t('{count} being indexed', { count }),
  failed: (count) => t('{count} failed', { count }),
};

function DocStatusSummary({ docs }) {
  const counts = { indexed: 0, pending: 0, indexing: 0, failed: 0 };
  docs.forEach(d => { if (counts[d.status] !== undefined) counts[d.status]++; });
  const hasAny = Object.values(counts).some(v => v > 0);
  return (
    <div className={styles.docSummary}>
      {hasAny
        ? Object.entries(counts).map(([status, count]) =>
            count > 0 && (
              <span key={status} className={`${styles.summaryPill} ${styles['pill_' + status]}`}>
                {SUMMARY_LABEL[status](count)}
              </span>
            )
          )
        : <span className={styles.emptyPill}>{t('No documents yet')}</span>
      }
    </div>
  );
}

// ─── Folder Browser ─────────────────────────────────────────────────────────

function FolderBrowser({ token, onSelect }) {
  const [browseData, setBrowseData]   = useState(null);  // { path, parent, entries, roots }
  const [browseError, setBrowseError] = useState(null);
  const [browseLoading, setBrowseLoading] = useState(false);
  const [selectedPath, setSelectedPath]   = useState(null);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const browse = useCallback(async (path = null) => {
    setBrowseLoading(true);
    setBrowseError(null);
    try {
      const url = path
        ? `/api/v1/knowledge-base/folders/browse?path=${encodeURIComponent(path)}`
        : `/api/v1/knowledge-base/folders/browse`;
      const res = await fetch(url, { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) {
        setBrowseError(data.detail || t('Failed to browse directory.'));
      } else {
        setBrowseData(data);
        setSelectedPath(data.path);
      }
    } catch {
      setBrowseError(t('Network error loading directory.'));
    } finally {
      setBrowseLoading(false);
    }
  }, [token]);

  // Load root on mount
  useEffect(() => { browse(); }, []);

  // Build breadcrumb parts from current path
  const breadcrumbs = useMemo(() => {
    if (!browseData) return [];
    const parts = browseData.path.replace(/\\/g, '/').split('/').filter(Boolean);
    const roots = (browseData.roots || []).map(r => r.replace(/\\/g, '/'));
    const crumbs = [];
    let accumulated = '';
    for (const part of parts) {
      accumulated = accumulated ? `${accumulated}/${part}` : `/${part}`;
      // only show from first matching root onwards
      const inRoot = roots.some(r => accumulated.startsWith(r) || r.startsWith(accumulated));
      if (inRoot || crumbs.length > 0) crumbs.push({ label: part, path: accumulated });
    }
    return crumbs;
  }, [browseData]);

  if (!browseData && browseLoading) {
    return <div className={styles.browserLoading}><Loader size={16} className={styles.spin} /> {t('Loading…')}</div>;
  }

  return (
    <div className={styles.browserPanel}>
      {/* Root selector — only shown when multiple roots */}
      {browseData && (browseData.roots || []).length > 1 && (
        <div className={styles.browserRoots}>
          {browseData.roots.map(root => (
            <button
              key={root}
              onClick={() => browse(root)}
              className={`${styles.browserRootBtn} ${browseData.path.startsWith(root) ? styles.browserRootBtnActive : ''}`}
            >
              <FolderOpen size={11} /> {root}
            </button>
          ))}
        </div>
      )}

      {/* Toolbar: Up button + breadcrumb */}
      <div className={styles.browserToolbar}>
        <button
          className={styles.browserUpBtn}
          onClick={() => browseData?.parent && browse(browseData.parent)}
          disabled={!browseData?.parent}
          title={t('Go up')}
        >
          <ChevronRight size={13} style={{ transform: 'rotate(180deg)' }} />
        </button>
        <div className={styles.browserBreadcrumb}>
          {breadcrumbs.map((crumb, i) => (
            <span key={crumb.path} style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
              {i > 0 && <span className={styles.breadcrumbSep}>/</span>}
              {i < breadcrumbs.length - 1
                ? <button className={styles.breadcrumbBtn} onClick={() => browse(crumb.path)}>{crumb.label}</button>
                : <span className={styles.breadcrumbCurrent}>{crumb.label}</span>
              }
            </span>
          ))}
        </div>
      </div>

      {/* Directory entries */}
      <div className={styles.browserEntries}>
        {browseLoading && (
          <div className={styles.browserLoading}><Loader size={14} className={styles.spin} /> {t('Loading…')}</div>
        )}
        {!browseLoading && browseError && (
          <div className={styles.browserEmpty}><AlertCircle size={18} />{browseError}</div>
        )}
        {!browseLoading && !browseError && browseData && browseData.entries.length === 0 && (
          <div className={styles.browserEmpty}><FolderOpen size={20} />{t('This folder is empty')}</div>
        )}
        {!browseLoading && !browseError && browseData && browseData.entries.map(entry => {
          const isSelected = selectedPath === `${browseData.path}/${entry.name}`.replace(/\/+/g, '/');
          return (
            <div
              key={entry.name}
              className={[
                styles.browserEntry,
                entry.is_dir ? styles.browserEntryDir : styles.browserEntryFile,
                entry.is_dir && isSelected ? styles.browserEntrySelected : ''
              ].filter(Boolean).join(' ')}
              onClick={() => {
                if (!entry.is_dir) return;
                const newPath = `${browseData.path}/${entry.name}`.replace(/\/+/g, '/');
                setSelectedPath(newPath);
                onSelect(newPath); // Immediately update parent state
              }}
              onDoubleClick={() => {
                if (!entry.is_dir) return;
                const newPath = `${browseData.path}/${entry.name}`.replace(/\/+/g, '/');
                browse(newPath);
              }}
              title={entry.is_dir ? `Double-click to open ${entry.name}` : entry.name}
            >
              {entry.is_dir
                ? <FolderOpen size={14} style={{ color: 'var(--accent-bright)', flexShrink: 0 }} />
                : <File size={13} style={{ opacity: 0.45, flexShrink: 0 }} />
              }
              <span className={styles.browserEntryName}>{entry.name}</span>
              {entry.is_dir && (
                <button 
                  className={styles.browserOpenBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    const newPath = `${browseData.path}/${entry.name}`.replace(/\/+/g, '/');
                    browse(newPath);
                  }}
                  title={t('Open folder')}
                >
                  <ChevronRight size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Add Folder Modal ────────────────────────────────────────────────────────

const WIN_PATH_RE = /^[A-Za-z]:[/\\]/;

function AddFolderModal({ onClose, onAdd, loading, error, token }) {
  const [path, setPath]     = useState('');
  const [name, setName]     = useState('');
  const [manualMode, setManualMode] = useState(false);

  const isWindowsPath = WIN_PATH_RE.test(path.trim());

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!path.trim() || isWindowsPath) return;
    onAdd(path.trim(), name.trim() || null);
  };

  const handleBrowseSelect = (selectedPath) => {
    setPath(selectedPath);
    // Auto-fill name from the last path segment
    const segment = selectedPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
    setName(prev => prev || segment);
  };

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()} style={{ maxWidth: '580px', width: '95%' }}>
        <div className={styles.modalHeader}>
          <span className={styles.modalTitle}><FolderPlus size={18} /> {t('Add Knowledge Base Folder')}</span>
          <button className={styles.modalClose} onClick={onClose}><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit} className={styles.modalBody}>

          {/* Windows path warning — shown when user types C:\... */}
          {isWindowsPath && (
            <div className={styles.winPathWarning}>
              <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <strong>{t('Windows path detected.')}</strong> {t('Paths like {path} are not visible inside the Docker container and cannot be registered here.', { path: path.trim().slice(0, 30) + (path.length > 30 ? '…' : '') })}
                <br /><br />
                <strong>{t('Use the StarkLLM launcher instead:')}</strong>
                <ol style={{ margin: '8px 0 0 18px', padding: 0 }}>
                  <li>{t('Close this dialog and stop StarkLLM.')}</li>
                  <li>{t('Run start.exe again and press Y when prompted to add a folder.')}</li>
                  <li>{t('Pick your Windows folder — the launcher will mirror and register it automatically.')}</li>
                </ol>
                <br />
                <em>{t('Alternative:')}</em> {t('Copy your files into knowledge_base_data/my-folder inside the StarkLLM project directory, then register the path /kb_data/my-folder here.')}
              </div>
            </div>
          )}

          {/* Mode toggle */}
          <div className={styles.modeToggle}>
            <span className={styles.modeToggleLabel}>
              {manualMode ? t('Entering container path manually.') : t('Browse /kb_data to select a sub-folder:')}
            </span>
            <button type="button" className={styles.modeToggleBtn} onClick={() => setManualMode(m => !m)}>
              {manualMode ? t('← Back to browser') : t('Enter path manually')}
            </button>
          </div>

          {/* Browser or manual input */}
          {!manualMode ? (
            <FolderBrowser token={token} onSelect={handleBrowseSelect} />
          ) : (
            <>
              <label className={styles.label}>
                {t('Container Folder Path')} <span className={styles.required}>*</span>
              </label>
              <input
                className={`${styles.input} ${isWindowsPath ? styles.inputError : ''}`}
                type="text"
                placeholder="/kb_data/my-documents"
                value={path}
                onChange={e => setPath(e.target.value)}
                autoFocus
                required
              />
              <p className={styles.hint}>
                {t('Enter the path as seen inside the container; it must start with /kb_data/. To index a Windows folder, use start.exe, which mirrors it automatically.')}
              </p>
            </>
          )}

          {/* Selected path preview & Name input */}
          {path && !isWindowsPath && (
            <div style={{ marginTop: 16, padding: 12, background: 'var(--bg-tertiary)', borderRadius: 8, border: '1px solid var(--border-color)' }}>
              <p className={styles.hint} style={{ margin: '0 0 12px 0' }}>
                {t('Selected Path:')} <code style={{ color: 'var(--accent-bright)' }}>{path}</code>
              </p>

              <label className={styles.label}>
                {t('Folder Name')} <span className={styles.optional}>{t('(optional)')}</span>
              </label>
              <input
                className={styles.input}
                type="text"
                placeholder={t('My Reports')}
                value={name}
                onChange={e => setName(e.target.value)}
              />
            </div>
          )}

          {error && (
            <div className={styles.errorBox}>
              <AlertCircle size={14} /> {error}
            </div>
          )}

          <div className={styles.modalActions}>
            <button type="button" className={styles.btnSecondary} onClick={onClose} disabled={loading}>
              {t('Cancel')}
            </button>
            <button type="submit" className={styles.btnPrimary} disabled={loading || !path.trim() || isWindowsPath}>
              {loading ? <><Loader size={14} className={styles.spin} /> {t('Adding…')}</> : t('Add Folder')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── Folder Row ──────────────────────────────────────────────────────────────

function FolderRow({ folder, token, onRefresh }) {
  const [expanded, setExpanded]       = useState(false);
  const [docs, setDocs]               = useState([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [scanning, setScanning]       = useState(false);
  const [indexing, setIndexing]       = useState(false);
  const [actionMsg, setActionMsg]     = useState(null);
  const [docSearch, setDocSearch]     = useState('');
  const [lastSynced, setLastSynced]   = useState(folder.last_indexed_at);

  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const fetchDocs = useCallback(async () => {
    setDocsLoading(true);
    try {
      const res = await fetch(`/api/v1/knowledge-base/folders/${folder.id}/documents`, {
        headers: authHeaders,
      });
      if (res.ok) setDocs(await res.json());
    } catch (e) {
      console.error('Failed to fetch docs', e);
    } finally {
      setDocsLoading(false);
    }
  }, [folder.id, token]);

  const showMsg = (type, text) => {
    setActionMsg({ type, text });
    setTimeout(() => setActionMsg(null), 4000);
  };

  const handleSync = async (e, silent = false) => {
    if (e) e.stopPropagation();
    if (!silent) setScanning(true);
    try {
      const res = await fetch(`/api/v1/knowledge-base/folders/${folder.id}/sync`, {
        method: 'POST',
        headers: authHeaders,
      });
      const data = await res.json();
      if (res.ok) {
        const hasChanges = data.added > 0 || data.updated > 0 || data.deleted > 0;
        if (!silent || hasChanges) {
          showMsg('ok', t('Sync complete: {added} added, {updated} updated, {deleted} deleted.', { added: data.added, updated: data.updated, deleted: data.deleted }));
        }
        setLastSynced(new Date().toISOString());
        if (expanded) fetchDocs();
        // Only trigger parent refresh (which causes full spinner) on manual sync
        if (!silent) onRefresh();
      } else {
        if (!silent) showMsg('err', data.detail || t('Sync failed.'));
      }
    } catch {
      if (!silent) showMsg('err', t('Network error during sync.'));
    } finally {
      if (!silent) setScanning(false);
    }
  };

  // The summary next to a closed folder said "No documents yet" until it was opened once.
  useEffect(() => { fetchDocs(); }, [fetchDocs]);

  useEffect(() => {
    if (expanded) {
      fetchDocs();
      // Auto-sync on expand silently
      handleSync(null, true);
    }
  }, [expanded]);

  const handleIndexAll = async (e) => {
    e.stopPropagation();
    setIndexing(true);
    try {
      const res = await fetch(`/api/v1/knowledge-base/folders/${folder.id}/index`, {
        method: 'POST',
        headers: authHeaders,
      });
      const data = await res.json();
      if (res.ok) {
        showMsg('ok', data.message || t('Indexing complete.'));
        onRefresh();
        if (expanded) fetchDocs();
      } else {
        showMsg('err', data.detail || t('Indexing failed.'));
      }
    } catch {
      showMsg('err', t('Network error during indexing.'));
    } finally {
      setIndexing(false);
    }
  };

  const handleIndexDoc = async (docId) => {
    try {
      const res = await fetch(`/api/v1/knowledge-base/documents/${docId}/index`, {
        method: 'POST',
        headers: authHeaders,
      });
      const data = await res.json();
      if (res.ok) showMsg('ok', data.message);
      else showMsg('err', data.detail || t('Index failed.'));
      fetchDocs();
    } catch {
      showMsg('err', t('Network error.'));
    }
  };

  const handleDeleteFolder = async (e) => {
    e.stopPropagation();
    if (!window.confirm(t('Remove the folder "{name}" from your Knowledge Base?', { name: folder.folder_name }) + '\n\n' + t('Its search data is removed. The files on your computer are NOT deleted.'))) {
      return;
    }
    setScanning(true);
    try {
      const res = await fetch(`/api/v1/knowledge-base/folders/${folder.id}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      if (res.ok || res.status === 204) {
        onRefresh();
      } else {
        const data = await res.json();
        showMsg('err', data.detail || t('Delete failed.'));
        setScanning(false);
      }
    } catch {
      showMsg('err', t('Network error during delete.'));
      setScanning(false);
    }
  };

  return (
    <div className={styles.folderCard}>
      {/* Header row */}
      <div className={styles.folderHeader} onClick={() => setExpanded(v => !v)}>
        <div className={styles.folderLeft}>
          <span className={styles.chevronBtn}>
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </span>
          <FolderOpen size={18} className={styles.folderIcon} />
          <div>
            <div className={styles.folderName}>{folder.folder_name}</div>
            <div className={styles.folderPath}>{folder.folder_path}</div>
          </div>
        </div>

        <div className={styles.folderRight} onClick={e => e.stopPropagation()}>
          <DocStatusSummary docs={docs} />
          <button
            className={styles.actionBtn}
            onClick={handleSync}
            disabled={scanning || indexing}
            title={t('Sync folder with disk')}
          >
            {scanning ? <Loader size={14} className={styles.spin} /> : <RefreshCw size={14} />}
            {scanning ? t('Syncing…') : t('Sync Now')}
          </button>
          <button
            className={`${styles.actionBtn} ${styles.actionBtnAccent}`}
            onClick={handleIndexAll}
            disabled={indexing || scanning}
            title={t('Index all pending documents')}
          >
            {indexing ? <Loader size={14} className={styles.spin} /> : <Zap size={14} />}
            {indexing ? t('Indexing…') : t('Index All')}
          </button>
          <button
            className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
            onClick={handleDeleteFolder}
            disabled={indexing || scanning}
            title={t('Remove folder from Knowledge Base')}
            style={{ marginLeft: 8 }}
          >
            <Trash2 size={14} /> {t('Delete Folder')}
          </button>
        </div>
      </div>

      {/* Feedback message */}
      {actionMsg && (
        <div className={`${styles.actionMsg} ${styles['actionMsg_' + actionMsg.type]}`}>
          {actionMsg.type === 'ok' ? <CheckCircle size={13} /> : <AlertCircle size={13} />}
          {actionMsg.text}
        </div>
      )}

      {/* Meta line */}
      <div className={styles.folderMeta}>
        <span>{t('Last synced: {date}', { date: formatDate(lastSynced) })}</span>
      </div>

      {/* Expanded document list */}
      {expanded && (
        <div className={styles.docList}>
          {docs.length > 0 && (
            <div className={styles.docSearchWrap}>
              <Search size={13} className={styles.docSearchIcon} />
              <input
                className={styles.docSearchInput}
                type="text"
                placeholder={t('Filter documents…')}
                value={docSearch}
                onChange={e => setDocSearch(e.target.value)}
              />
              {docSearch && (
                <button className={styles.docSearchClear} onClick={() => setDocSearch('')}>
                  <X size={12} />
                </button>
              )}
            </div>
          )}
          {docsLoading && (
            <div className={styles.docsLoading}>
              <Loader size={14} className={styles.spin} /> {t('Loading documents…')}
            </div>
          )}
          {!docsLoading && docs.length === 0 && (
            <div className={styles.emptyDocs}>
              {t('No documents found. Click Sync Now to discover files.')}
            </div>
          )}
          {!docsLoading && docs
            .filter(doc => !docSearch || doc.file_name.toLowerCase().includes(docSearch.toLowerCase()))
            .map(doc => (
            <div key={doc.id} className={styles.docRow}>
              <File size={14} className={styles.docIcon} />
              <div className={styles.docInfo}>
                <span className={styles.docName}>{doc.file_name}</span>
                <span className={styles.docMeta}>{formatBytes(doc.file_size)} · {doc.file_type.toUpperCase()}</span>
              </div>
              <StatusBadge status={doc.status} />
              {doc.status === 'failed' && doc.error_message && (
                <span className={styles.docError} title={doc.error_message}>⚠</span>
              )}
              {doc.status === 'indexed' && (
                <button
                  className={styles.reindexBtn}
                  onClick={() => window.openPreviewModal && window.openPreviewModal(doc)}
                  title={t('Preview document')}
                >
                  <Eye size={12} /> {t('Preview')}
                </button>
              )}
              {(doc.status === 'pending' || doc.status === 'failed') && (
                <button
                  className={styles.reindexBtn}
                  onClick={() => handleIndexDoc(doc.id)}
                  title={t('Index this document')}
                >
                  <Zap size={12} /> {t('Index')}
                </button>
              )}
            </div>
          ))}
          {!docsLoading && docSearch && docs.filter(d => d.file_name.toLowerCase().includes(docSearch.toLowerCase())).length === 0 && (
            <div className={styles.emptyDocs}>No documents match "{docSearch}"</div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function KnowledgeBase({ token }) {
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [search, setSearch]   = useState('');
  const [showModal, setShowModal] = useState(false);
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError]     = useState(null);
  
  const [kbConfig, setKbConfig] = useState(null);
  const [pathCopied, setPathCopied] = useState(false);

  // Global preview modal state
  const [previewDoc, setPreviewDoc] = useState(null);
  const [previewText, setPreviewText] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const fetchFolders = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/knowledge-base/folders', { headers: authHeaders });
      if (!res.ok) throw new Error('Failed to load folders');
      const data = await res.json();
      setFolders(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [authHeaders]);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/knowledge-base/config', { headers: authHeaders });
      if (res.ok) {
        const data = await res.json();
        setKbConfig(data);
      }
    } catch (err) {
      console.warn("Failed to fetch KB config", err);
    }
  }, [authHeaders]);

  useEffect(() => {
    fetchFolders();
    fetchConfig();
  }, [fetchFolders, fetchConfig]);
  const filteredFolders = useMemo(() =>
    search.trim()
      ? folders.filter(f =>
          f.folder_name.toLowerCase().includes(search.toLowerCase()) ||
          f.folder_path.toLowerCase().includes(search.toLowerCase())
        )
      : folders,
  [folders, search]);

  const handleAddFolder = async (folderPath, folderName) => {
    setAddLoading(true);
    setAddError(null);
    try {
      const res = await fetch('/api/v1/knowledge-base/folders', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder_path: folderPath, folder_name: folderName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || t('Failed to add folder.'));
      setFolders(prev => [...prev, data]);
      setShowModal(false);
    } catch (e) {
      setAddError(e.message);
    } finally {
      setAddLoading(false);
    }
  };

  useEffect(() => {
    window.openPreviewModal = async (doc) => {
      setPreviewDoc(doc);
      setPreviewText("");
      setPreviewLoading(true);
      try {
        const res = await fetch(`/api/v1/knowledge-base/documents/${doc.id}/preview`, {
          headers: authHeaders
        });
        if (!res.ok) throw new Error('Failed to load preview');
        const data = await res.json();
        setPreviewText(data.preview || t('No text preview available.'));
      } catch (err) {
        setPreviewText(t('Error loading preview.'));
      } finally {
        setPreviewLoading(false);
      }
    };
    return () => { delete window.openPreviewModal; };
  }, [token]);

  return (
    <div className={styles.container}>
      {/* Page header */}
      <div className={styles.pageHeader}>
        <div className={styles.pageTitle}>
          <Database size={22} className={styles.pageTitleIcon} />
          <div>
            <h1 className={styles.h1}>{t('Knowledge Base')}</h1>
            <p className={styles.subtitle}>{t('Manage indexed document folders for RAG retrieval')}</p>
          </div>
        </div>
        <div className={styles.headerRight}>
          <div className={styles.searchWrap}>
            <Search size={14} className={styles.searchIcon} />
            <input
              className={styles.searchInput}
              type="text"
              placeholder={t('Search folders…')}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button className={styles.searchClear} onClick={() => setSearch('')}>
                <X size={13} />
              </button>
            )}
          </div>
          <button className={styles.btnPrimary} onClick={() => setShowModal(true)}>
            <FolderPlus size={16} /> {t('Add Folder')}
          </button>
        </div>
      </div>

      {kbConfig && (
        <div className={styles.kbHelperBox}>
          <div className={styles.kbHelperIcon}>
            <FolderOpen size={20} />
          </div>
          <div className={styles.kbHelperContent}>
            <h3 className={styles.kbHelperTitle}>{t('Where do I put my files?')}</h3>
            <p className={styles.kbHelperText}>
              {t('Place your documents (PDFs, TXT, etc.) into the Knowledge Base folder on your computer. Then click Add Folder to scan and index them into StarkLLM.')}
            </p>
            <div className={styles.kbHelperPathWrap}>
              <code className={styles.kbHelperPath}>{kbConfig.host_kb_path}</code>
              <button 
                className={styles.kbHelperCopyBtn}
                onClick={() => {
                  navigator.clipboard.writeText(kbConfig.host_kb_path).catch(() => {});
                  setPathCopied(true);
                  setTimeout(() => setPathCopied(false), 2000);
                }}
              >
                {pathCopied ? <Check size={14} /> : <Copy size={14} />} {pathCopied ? t('Copied') : t('Copy Path')}
              </button>
            </div>
            {!loading && kbConfig.container_kb_path && !folders.some(f => f.folder_path === kbConfig.container_kb_path) && (
              <div style={{ marginTop: '12px' }}>
                <button 
                  className={styles.btnPrimary} 
                  style={{ padding: '6px 12px', fontSize: '0.85rem' }}
                  onClick={() => handleAddFolder(kbConfig.container_kb_path, 'Root Knowledge Base')}
                  disabled={addLoading}
                >
                  <FolderPlus size={14} /> {t('Register Root Folder Now')}
                </button>
                <span className={styles.hint} style={{ marginLeft: '10px', fontSize: '0.8rem' }}>
                  {t('Quickly add the main folder above to your list.')}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className={styles.errorBox}>
          <AlertCircle size={14} /> {error}
          <button className={styles.retryBtn} onClick={fetchFolders}>{t('Retry')}</button>
        </div>
      )}

      {loading && (
        <div className={styles.loadingState}>
          <Loader size={20} className={styles.spin} />
          <span>{t('Loading folders…')}</span>
        </div>
      )}

      {!loading && !error && folders.length === 0 && (
        <EmptyState 
          icon={FolderOpen} 
          title={t('No folders added yet')} 
          hint={t('Add a folder to start indexing documents for AI-assisted retrieval.')} 
          action={{ label: t('Add Your First Folder'), onClick: () => setShowModal(true) }} 
        />
      )}

      {!loading && folders.length > 0 && (
        <div className={styles.folderList}>
          {filteredFolders.length === 0 ? (
            <div className={styles.emptyDocs} style={{ padding: '2rem', textAlign: 'center' }}>
              No folders match "{search}"
            </div>
          ) : (
            filteredFolders.map(folder => (
              <FolderRow
                key={folder.id}
                folder={folder}
                token={token}
                onRefresh={fetchFolders}
              />
            ))
          )}
        </div>
      )}

      {showModal && (
        <AddFolderModal
          onClose={() => { setShowModal(false); setAddError(null); }}
          onAdd={handleAddFolder}
          loading={addLoading}
          error={addError}
          token={token}
        />
      )}

      {/* Preview Modal */}
      {previewDoc && (
        <div className={styles.modalOverlay} onClick={() => setPreviewDoc(null)}>
          <div className={styles.modalContent} onClick={e => e.stopPropagation()} style={{ maxWidth: '800px', width: '90%' }}>
            <div className={styles.modalHeader}>
              <h3 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                Preview: {previewDoc.file_name}
              </h3>
              <button className={styles.modalClose} onClick={() => setPreviewDoc(null)}>
                <X size={16} />
              </button>
            </div>
            <div className={styles.modalBody} style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              {previewLoading ? (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px', color: 'var(--text-secondary)' }}>
                  <Loader size={20} className={styles.spin} style={{ marginRight: '8px' }} /> {t('Loading preview...')}
                </div>
              ) : (
                <pre style={{ 
                  margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', 
                  fontFamily: 'inherit', fontSize: '0.9rem', lineHeight: '1.5',
                  background: 'var(--bg-tertiary)', padding: '16px', borderRadius: '6px',
                  border: '1px solid var(--border-color)', color: 'var(--text-primary)'
                }}>
                  {previewText}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
