import React, { useState, useEffect, useRef } from 'react';
import styles from './DocumentViewerModal.module.css';
import { FileText, Download, Search, ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { t } from '../i18n';
import { useEscape } from '../utils/useEscape';

// The cited passage in the page text, found even when line breaks differ (the index joins sentences with spaces).
function passageRange(text, passage) {
  const words = String(passage || '').trim().split(/\s+/).slice(0, 40).filter(Boolean);
  if (words.length < 3 || !text) return null;
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
  const m = re.exec(text);
  return m ? [m.index, m.index + m[0].length] : null;
}

export default function DocumentViewerModal({
  isOpen,
  onClose,
  workspaceId,
  documentId,
  initialFilename,
  initialPage = 1,
  highlight,
  token
}) {
  const [docData, setDocData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [currentPage, setCurrentPage] = useState(initialPage || 1);
  const [searchQuery, setSearchQuery] = useState('');
  const [imageUrl, setImageUrl] = useState(null);
  const markRef = useRef(null);
  useEscape(onClose, isOpen);

  // The original photo, loaded with the login token (a plain <img src> would not send it)
  useEffect(() => {
    if (!docData?.is_image || !docData?.id) return undefined;
    let url = null;
    let alive = true;
    fetch(`/api/v1/documents/${workspaceId}/documents/${docData.id}/file`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => { if (b && alive) { url = URL.createObjectURL(b); setImageUrl(url); } })
      .catch(() => {});
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [docData, workspaceId, token]);

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
            throw new Error(t('The document {name} was not found in this workspace.', { name: initialFilename }));
          }
          const lookupData = await lookupRes.json();
          activeDocId = lookupData.id;
        }

        if (!activeDocId) {
          throw new Error(t('No document was chosen.'));
        }

        const res = await fetch(`/api/v1/documents/${workspaceId}/documents/${activeDocId}/content`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {}
        });

        if (!res.ok) {
          throw new Error(t('The document could not be loaded.'));
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
          setError(err.message || t('Error loading document'));
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

  const cited = !searchQuery ? passageRange(currentText, highlight) : null;

  useEffect(() => {
    if (cited && markRef.current) markRef.current.scrollIntoView({ block: 'center' });
  }, [cited && cited[0], currentPage, loading]);

  const renderHighlightedContent = (text, query) => {
    if (cited) {
      return (
        <>
          {text.slice(0, cited[0])}
          <mark ref={markRef} className={styles.highlight}>{text.slice(cited[0], cited[1])}</mark>
          {text.slice(cited[1])}
        </>
      );
    }
    if (!query || !query.trim()) return text;
    const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
    return parts.map((part, i) =>
      part.toLowerCase() === query.toLowerCase() ? (
        <mark key={i} className={styles.highlight}>{part}</mark>
      ) : part
    );
  };

  const handleDownload = async () => {
    if (!docData?.id) return;
    const res = await fetch(`/api/v1/documents/${workspaceId}/documents/${docData.id}/file`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = docData.filename || 'document';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.titleArea}>
            <FileText size={20} color="#818cf8" />
            <h3 className={styles.title} title={docData?.filename || initialFilename}>
              {docData?.filename || initialFilename || t('Document Viewer')}
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
                title={t('Download original file')}
              >
                <Download size={16} />
              </button>
            )}
            <button className={styles.closeBtn} onClick={onClose} title={t('Close')}>
              ✕
            </button>
          </div>
        </div>

        <div className={styles.toolbar}>
          <div className={styles.searchBox}>
            <Search size={14} color="#a1a1aa" />
            <input
              type="text"
              placeholder={t('Search in document...')}
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
              <span>{t('Page {page} of {total}', { page: currentPage, total: totalPages })}</span>
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
              <span>{t('Extracting and loading document passages...')}</span>
            </div>
          ) : error ? (
            <div style={{ color: '#ef4444', textAlign: 'center', padding: '2rem' }}>
              {error}
            </div>
          ) : (
            <div>
              {imageUrl && currentPage === 1 && (
                <img className={styles.image} src={imageUrl} alt={docData?.filename || ''} />
              )}
              {renderHighlightedContent(currentText, searchQuery)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
