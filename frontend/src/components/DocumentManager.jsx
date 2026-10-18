import React, { useState, useEffect } from 'react';
import styles from './DocumentManager.module.css';
import { 
  X, FileText, Trash2, Eye, Calendar, HardDrive, File, 
  CheckCircle2, AlertTriangle, RefreshCw, Loader, XCircle,
  Globe, Link2, Plus, ArrowRight, Video
} from 'lucide-react';
import { useToast } from './Toast';

/* --- Formatting Helpers --- */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatRelativeDate(isoString) {
  if (!isoString) return 'Unknown';
  const date = new Date(isoString);
  const now = new Date();
  const diffHours = (now - date) / (1000 * 60 * 60);
  
  if (diffHours < 24) return 'Today';
  if (diffHours < 48) return 'Yesterday';
  return Math.floor(diffHours / 24) + ' days ago';
}

function formatDateFull(isoString) {
  if (!isoString) return 'Unknown';
  return new Date(isoString).toLocaleString(undefined, { 
    dateStyle: 'medium', timeStyle: 'short' 
  });
}

/* --- Status Badge --- */
const STATUS_CONFIG = {
  uploading:  { label: 'Uploading',  color: 'var(--accent-color)',   spin: true  },
  extracting: { label: 'Extracting', color: '#f59e0b',               spin: true  },
  chunking:   { label: 'Chunking',   color: '#f59e0b',               spin: true  },
  embedding:  { label: 'Embedding',  color: '#a855f7',               spin: true  },
  indexed:    { label: 'Indexed',    color: 'var(--success)',         spin: false },
  failed:     { label: 'Failed',     color: 'var(--error, #ef4444)', spin: false },
  missing:    { label: 'Missing',    color: '#f97316',               spin: false },
};

function StatusBadge({ status, className }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.indexed;
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '2px 8px',
        borderRadius: '20px',
        fontSize: '0.7rem',
        fontWeight: 600,
        letterSpacing: '0.02em',
        background: `${cfg.color}22`,
        color: cfg.color,
        border: `1px solid ${cfg.color}44`,
      }}
    >
      {cfg.spin
        ? <Loader size={11} style={{ animation: 'spin 1s linear infinite' }} />
        : status === 'indexed' ? <CheckCircle2 size={11} />
        : status === 'failed'  ? <XCircle size={11} />
        : <AlertTriangle size={11} />
      }
      {cfg.label}
    </span>
  );
}

function StatusDot({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.indexed;
  if (cfg.spin) {
    return <Loader size={10} style={{ color: cfg.color, animation: 'spin 1s linear infinite', flexShrink: 0 }} />;
  }
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: cfg.color,
        flexShrink: 0,
        display: 'inline-block',
      }}
      title={cfg.label}
    />
  );
}

const IN_PROGRESS_STATUSES = ['uploading', 'extracting', 'chunking', 'embedding'];

export default function DocumentManager({ 
  isOpen, 
  onClose, 
  workspaceId, 
  documents, 
  onDeleteDocument,
  token 
}) {
  const toast = useToast();
  const [selectedDoc, setSelectedDoc] = useState(null);
  const [previewText, setPreviewText] = useState("");
  const [loadingPreview, setLoadingPreview] = useState(false);
  
  // State for actions
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [reindexingIds, setReindexingIds] = useState(new Set());
  const [reindexSuccessIds, setReindexSuccessIds] = useState(new Set());

  // Connectors State ('web' | 'youtube' | null)
  const [activeConnector, setActiveConnector] = useState(null);
  const [webUrl, setWebUrl] = useState('');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [isIngesting, setIsIngesting] = useState(false);

  const handleIngestUrl = async (e) => {
    e.preventDefault();
    if (!webUrl.trim()) return;
    setIsIngesting(true);
    try {
      const res = await fetch(`/api/v1/documents/${workspaceId}/ingest-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ url: webUrl.trim() })
      });
      if (res.ok) {
        toast.success("Webpage queued for indexing!");
        setWebUrl('');
        setActiveConnector(null);
      } else {
        const err = await res.json();
        toast.error(`Ingest failed: ${err.detail || 'Could not fetch URL'}`);
      }
    } catch (err) {
      console.error("Error ingesting URL:", err);
      toast.error("Network error while connecting to URL.");
    } finally {
      setIsIngesting(false);
    }
  };

  const handleIngestYoutube = async (e) => {
    e.preventDefault();
    if (!youtubeUrl.trim()) return;
    setIsIngesting(true);
    try {
      const res = await fetch(`/api/v1/documents/${workspaceId}/ingest-youtube`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ url: youtubeUrl.trim() })
      });
      if (res.ok) {
        toast.success("YouTube transcript queued for indexing!");
        setYoutubeUrl('');
        setActiveConnector(null);
      } else {
        const err = await res.json();
        toast.error(`Ingest failed: ${err.detail || 'Could not fetch YouTube transcript'}`);
      }
    } catch (err) {
      console.error("Error ingesting YouTube:", err);
      toast.error("Network error while fetching YouTube video.");
    } finally {
      setIsIngesting(false);
    }
  };

  useEffect(() => {
    if (!isOpen) {
      setSelectedDoc(null);
      setPreviewText("");
      setDeleteConfirmId(null);
      setActiveConnector(null);
      setWebUrl('');
      setYoutubeUrl('');
    }
  }, [isOpen]);

  // When selected doc changes, fetch preview and reset action states
  useEffect(() => {
    setDeleteConfirmId(null);
    if (selectedDoc) {
      // Only fetch preview if doc is fully indexed
      if (selectedDoc.status === 'indexed') {
        fetchPreview(selectedDoc.id);
      } else {
        setPreviewText("");
      }
    } else {
      setPreviewText("");
    }
  }, [selectedDoc?.id]);

  // If documents array changes (e.g. after deletion or status update), update selectedDoc
  useEffect(() => {
    if (selectedDoc) {
      const stillExists = documents.find(d => d.id === selectedDoc.id);
      if (!stillExists) {
        setSelectedDoc(null);
      } else {
        setSelectedDoc(stillExists);
        // If doc just became indexed, auto-fetch preview
        if (stillExists.status === 'indexed' && selectedDoc.status !== 'indexed') {
          fetchPreview(stillExists.id);
        }
      }
    }
  }, [documents]);

  const fetchPreview = async (docId) => {
    setLoadingPreview(true);
    setPreviewText("");
    try {
      const res = await fetch(`/api/v1/documents/${workspaceId}/preview/${docId}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to load preview');
      const data = await res.json();
      setPreviewText(data.preview || "No text preview available.");
    } catch (err) {
      setPreviewText("Error loading preview.");
    } finally {
      setLoadingPreview(false);
    }
  };

  const handleDeleteClick = async (docId) => {
    if (deleteConfirmId === docId) {
      await onDeleteDocument(docId);
      setDeleteConfirmId(null);
    } else {
      setDeleteConfirmId(docId);
      setTimeout(() => {
        setDeleteConfirmId(curr => curr === docId ? null : curr);
      }, 3000);
    }
  };

  const handleReindex = async (docId) => {
    setReindexingIds(prev => new Set([...prev, docId]));
    setReindexSuccessIds(prev => { const s = new Set(prev); s.delete(docId); return s; });
    try {
      const res = await fetch(`/api/v1/documents/${workspaceId}/documents/${docId}/reindex`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Re-index failed');
      setReindexSuccessIds(prev => new Set([...prev, docId]));
      setTimeout(() => setReindexSuccessIds(prev => { const s = new Set(prev); s.delete(docId); return s; }), 3000);
    } catch (err) {
      toast.error("Failed to re-index document.");
    } finally {
      setReindexingIds(prev => { const s = new Set(prev); s.delete(docId); return s; });
    }
  };

  if (!isOpen) return null;

  const isInProgress = (doc) => IN_PROGRESS_STATUSES.includes(doc.status);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        {/* ── Header ── */}
        <div className={styles.header}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <h2>Workspace Documents</h2>
            
            <button 
              className="badge badge-accent"
              style={{ 
                cursor: 'pointer', 
                padding: '5px 10px', 
                display: 'inline-flex', 
                alignItems: 'center', 
                gap: '5px',
                background: activeConnector === 'web' ? 'var(--accent-primary)' : undefined,
                color: activeConnector === 'web' ? '#fff' : undefined
              }}
              onClick={() => setActiveConnector(activeConnector === 'web' ? null : 'web')}
            >
              <Globe size={13} />
              <span>{activeConnector === 'web' ? 'Close Web' : '+ Web URL'}</span>
            </button>

            <button 
              className="badge badge-accent"
              style={{ 
                cursor: 'pointer', 
                padding: '5px 10px', 
                display: 'inline-flex', 
                alignItems: 'center', 
                gap: '5px',
                background: activeConnector === 'youtube' ? '#ef4444' : undefined,
                color: activeConnector === 'youtube' ? '#fff' : undefined,
                borderColor: activeConnector === 'youtube' ? '#ef4444' : undefined
              }}
              onClick={() => setActiveConnector(activeConnector === 'youtube' ? null : 'youtube')}
            >
              <Video size={13} />
              <span>{activeConnector === 'youtube' ? 'Close YouTube' : '+ YouTube Video'}</span>
            </button>
          </div>
          <button className={styles.closeBtn} onClick={onClose} title="Close">
            <X size={20} />
          </button>
        </div>

        {/* ── Ingest Web URL Form ── */}
        {activeConnector === 'web' && (
          <form onSubmit={handleIngestUrl} style={{
            padding: '12px 24px',
            background: 'rgba(99, 102, 241, 0.08)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            gap: '10px',
            alignItems: 'center'
          }}>
            <Globe size={16} color="var(--accent-bright)" />
            <input 
              type="url"
              className="input-field"
              placeholder="https://example.com/article-or-documentation..."
              value={webUrl}
              onChange={e => setWebUrl(e.target.value)}
              disabled={isIngesting}
              autoFocus
              style={{ flex: 1, padding: '8px 12px', fontSize: '0.85rem' }}
            />
            <button 
              type="submit"
              className="btn-primary"
              disabled={!webUrl.trim() || isIngesting}
              style={{ padding: '8px 16px', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}
            >
              {isIngesting ? <Loader size={14} className="animate-spin" /> : <ArrowRight size={14} />}
              <span>{isIngesting ? 'Crawling...' : 'Index Webpage'}</span>
            </button>
          </form>
        )}

        {/* ── Ingest YouTube Video Form ── */}
        {activeConnector === 'youtube' && (
          <form onSubmit={handleIngestYoutube} style={{
            padding: '12px 24px',
            background: 'rgba(239, 68, 68, 0.08)',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            gap: '10px',
            alignItems: 'center'
          }}>
            <Video size={16} color="#ef4444" />
            <input 
              type="url"
              className="input-field"
              placeholder="https://www.youtube.com/watch?v=... or youtu.be/..."
              value={youtubeUrl}
              onChange={e => setYoutubeUrl(e.target.value)}
              disabled={isIngesting}
              autoFocus
              style={{ flex: 1, padding: '8px 12px', fontSize: '0.85rem' }}
            />
            <button 
              type="submit"
              className="btn-primary"
              disabled={!youtubeUrl.trim() || isIngesting}
              style={{ 
                padding: '8px 16px', 
                fontSize: '0.85rem', 
                display: 'flex', 
                alignItems: 'center', 
                gap: '6px', 
                whiteSpace: 'nowrap',
                background: '#ef4444'
              }}
            >
              {isIngesting ? <Loader size={14} className="animate-spin" /> : <ArrowRight size={14} />}
              <span>{isIngesting ? 'Fetching Transcript...' : 'Index Video'}</span>
            </button>
          </form>
        )}
        
        {/* ── Body ── */}
        <div className={styles.content}>
          
          {/* ── Master List (Left) ── */}
          <div className={styles.masterList}>
            {documents.length === 0 ? (
              <div className={styles.emptyList}>
                <FileText size={32} className={styles.emptyListIcon} />
                <p>No documents uploaded yet.</p>
              </div>
            ) : (
              documents.map(doc => {
                const isSelected = selectedDoc?.id === doc.id;
                return (
                  <div 
                    key={doc.id} 
                    className={`${styles.docItem} ${isSelected ? styles.docItemActive : ''}`}
                    onClick={() => setSelectedDoc(doc)}
                  >
                    <div className={styles.docItemIconWrap}>
                      <FileText size={18} className={styles.docItemIcon} />
                      <div style={{ position: 'absolute', bottom: -2, right: -2 }}>
                        <StatusDot status={doc.status} />
                      </div>
                    </div>
                    <div className={styles.docItemBody}>
                      <span className={styles.docItemName} title={doc.filename}>{doc.filename}</span>
                      <div className={styles.docItemMeta}>
                        <span>{formatBytes(doc.file_size)}</span>
                        <span className={styles.metaDot}>•</span>
                        <span>{formatRelativeDate(doc.created_at)}</span>
                        {isInProgress(doc) && (
                          <>
                            <span className={styles.metaDot}>•</span>
                            <span style={{ color: '#f59e0b', fontSize: '0.7rem' }}>
                              {STATUS_CONFIG[doc.status]?.label ?? doc.status}…
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          
          {/* ── Details Panel (Right) ── */}
          <div className={styles.detailsPanel}>
            {selectedDoc ? (
              <div className={styles.detailsContent}>
                
                {/* Details Header & Actions */}
                <div className={styles.detailsHeader}>
                  <div className={styles.detailsTitleWrap}>
                    <h3 className={styles.detailsTitle}>{selectedDoc.filename}</h3>
                    <StatusBadge status={selectedDoc.status} />
                  </div>

                  <div className={styles.actionButtons}>
                    <button 
                      className={styles.actionBtnSecondary}
                      onClick={() => handleReindex(selectedDoc.id)}
                      disabled={reindexingIds.has(selectedDoc.id) || isInProgress(selectedDoc) || selectedDoc.status === 'missing'}
                      title="Re-parse and embed into vector database"
                    >
                      {reindexingIds.has(selectedDoc.id) ? <Loader size={14} className={styles.spinner} /> : 
                       reindexSuccessIds.has(selectedDoc.id) ? <CheckCircle2 size={14} style={{ color: 'var(--success)' }} /> : 
                       <RefreshCw size={14} />}
                      {reindexingIds.has(selectedDoc.id) ? 'Re-indexing...' : reindexSuccessIds.has(selectedDoc.id) ? 'Done' : 'Re-index'}
                    </button>

                    <button 
                      className={`${styles.actionBtnDanger} ${deleteConfirmId === selectedDoc.id ? styles.confirmDanger : ''}`}
                      onClick={() => handleDeleteClick(selectedDoc.id)}
                      disabled={isInProgress(selectedDoc)}
                    >
                      <Trash2 size={14} /> 
                      {deleteConfirmId === selectedDoc.id ? 'Confirm Delete?' : 'Delete'}
                    </button>
                  </div>
                </div>

                {/* Error message if failed */}
                {selectedDoc.status === 'failed' && selectedDoc.error_message && (
                  <div style={{
                    padding: '10px 14px',
                    background: 'rgba(239,68,68,0.08)',
                    border: '1px solid rgba(239,68,68,0.25)',
                    borderRadius: '8px',
                    fontSize: '0.8rem',
                    color: '#ef4444',
                    marginBottom: 12,
                  }}>
                    <strong>Indexing error:</strong> {selectedDoc.error_message}
                  </div>
                )}

                {/* In-progress hint */}
                {isInProgress(selectedDoc) && (
                  <div style={{
                    padding: '10px 14px',
                    background: 'rgba(245,158,11,0.08)',
                    border: '1px solid rgba(245,158,11,0.25)',
                    borderRadius: '8px',
                    fontSize: '0.8rem',
                    color: '#f59e0b',
                    marginBottom: 12,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}>
                    <Loader size={13} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
                    Indexing in progress: <strong>{STATUS_CONFIG[selectedDoc.status]?.label}</strong>…
                    Preview and RAG will be available once indexing completes.
                  </div>
                )}

                {/* Metadata Grid */}
                <div className={styles.metaGrid}>
                  <div className={styles.metaItem}>
                    <HardDrive size={14} className={styles.metaIcon} />
                    <div className={styles.metaData}>
                      <span className={styles.metaLabel}>Size</span>
                      <span className={styles.metaValue}>{formatBytes(selectedDoc.file_size)}</span>
                    </div>
                  </div>
                  <div className={styles.metaItem}>
                    <File size={14} className={styles.metaIcon} />
                    <div className={styles.metaData}>
                      <span className={styles.metaLabel}>Type</span>
                      <span className={styles.metaValue}>{selectedDoc.file_type ? selectedDoc.file_type.toUpperCase() : 'Unknown'}</span>
                    </div>
                  </div>
                  <div className={styles.metaItem}>
                    <Calendar size={14} className={styles.metaIcon} />
                    <div className={styles.metaData}>
                      <span className={styles.metaLabel}>Added</span>
                      <span className={styles.metaValue}>{formatDateFull(selectedDoc.created_at)}</span>
                    </div>
                  </div>
                </div>

                {/* Text Preview Card */}
                {selectedDoc.status === 'indexed' && (
                  <div className={styles.previewCard}>
                    <div className={styles.previewCardHeader}>
                      <Eye size={14} />
                      <span>Parsed Text Preview</span>
                    </div>
                    <div className={styles.previewCardBody}>
                      {loadingPreview ? (
                        <div className={styles.loadingState}>
                          <Loader size={20} className={styles.spinner} />
                          <span>Loading preview...</span>
                        </div>
                      ) : (
                        <pre className={styles.previewText}>{previewText}</pre>
                      )}
                    </div>
                  </div>
                )}

              </div>
            ) : (
              <div className={styles.emptyPanel}>
                <FileText size={48} className={styles.emptyPanelIcon} />
                <p className={styles.emptyPanelTitle}>No document selected</p>
                <p className={styles.emptyPanelHint}>Select a document from the list to view its details and parsed text.</p>
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}
