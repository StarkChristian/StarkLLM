import React, { useState, useEffect } from 'react';
import styles from './DocumentViewerModal.module.css';
import { FileText, Download, Search, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';

export default function DocumentViewerModal({
  isOpen,
  onClose,
  workspaceId,
  documentId,
  initialFilename,
  initialPage = 1,
  token
}) {
  const [docData, setDocData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [currentPage, setCurrentPage] = useState(initialPage || 1);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    if (!isOpen || !workspaceId) return;

    let isMounted = true;
    setLoading(true);
    setError(null);

    const fetchDoc = async () => {
      try {
        let activeDocId = documentId;

        // If no documentId was passed but filename was passed, lookup documentId
        if (!activeDocId && initialFilename) {
          const lookupRes = await fetch(
            `/api/v1/documents/${workspaceId}/documents/lookup?filename=${encodeURIComponent(initialFilename)}`,
            {
              headers: token ? { Authorization: `Bearer ${token}` } : {}
            }
          );
          if (!lookupRes.ok) {
            throw new Error(`Document '${initialFilename}' not found in active workspace`);
          }
          const lookupData = await lookupRes.json();
          activeDocId = lookupData.id;
        }

        if (!activeDocId) {
          throw new Error('No valid document specified.');
        }

        const res = await fetch(`/api/v1/documents/${workspaceId}/documents/${activeDocId}/content`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        });

        if (!res.ok) {
          throw new Error('Failed to load document content');
        }

        const data = await res.json();
        if (isMounted) {
          setDocData(data);
          if (initialPage && initialPage <= (data.page_count || 1)) {
            setCurrentPage(initialPage);
          } else {
            setCurrentPage(1);
          }
        }
      } catch (err) {
        if (isMounted) {
          setError(err.message || 'Error loading document');
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    fetchDoc();

    return () => {
      isMounted = false;
    };
  }, [isOpen, workspaceId, documentId, initialFilename, initialPage, token]);

  if (!isOpen) return null;

  const totalPages = docData?.pages?.length || 1;
  const currentText = docData?.pages?.find(p => p.page === currentPage)?.text || docData?.full_text || '';

  const renderHighlightedContent = (text, query) => {
    if (!query || !query.trim()) return text;
    const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
    return parts.map((part, i) =>
      part.toLowerCase() === query.toLowerCase() ? (
        <mark key={i} className={styles.highlight}>{part}</mark>
      ) : part
    );
  };

  const handleDownload = () => {
    if (!docData?.id) return;
    const downloadUrl = `/api/v1/documents/${workspaceId}/documents/${docData.id}/file`;
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = docData.filename || 'document';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.titleArea}>
            <FileText size={20} color="#818cf8" />
            <h3 className={styles.title} title={docData?.filename || initialFilename}>
              {docData?.filename || initialFilename || 'Document Viewer'}
            </h3>
            {docData?.file_type && (
              <span className={styles.badge}>{docData.file_type}</span>
            )}
          </div>
          <div className={styles.actions}>
            {docData?.id && (
              <button
                className={styles.iconBtn}
                onClick={handleDownload}
                title="Download original file"
              >
                <Download size={16} />
              </button>
            )}
            <button className={styles.closeBtn} onClick={onClose} title="Close">
              ✕
            </button>
          </div>
        </div>

        <div className={styles.toolbar}>
          <div className={styles.searchBox}>
            <Search size={14} color="#a1a1aa" />
            <input
              type="text"
              placeholder="Search in document..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>

          {totalPages > 1 && (
            <div className={styles.pagination}>
              <button
                className={styles.pageBtn}
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              >
                <ChevronLeft size={14} />
              </button>
              <span>Page {currentPage} of {totalPages}</span>
              <button
                className={styles.pageBtn}
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>

        <div className={styles.content}>
          {loading ? (
            <div className={styles.loading}>
              <div className={styles.spinner} />
              <span>Extracting and loading document passages...</span>
            </div>
          ) : error ? (
            <div style={{ color: '#ef4444', textAlign: 'center', padding: '2rem' }}>
              ⚠️ {error}
            </div>
          ) : (
            <div>
              {renderHighlightedContent(currentText, searchQuery)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
