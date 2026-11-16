import React, { useEffect, useState } from 'react';
import { FileText, Database, X, ExternalLink } from 'lucide-react';
import styles from './SourcesModal.module.css';
import { t } from '../i18n';
import { readableLocator } from '../utils/sources';
import { useEscape } from '../utils/useEscape';

// What an answer was built from: per source the file, the page and the passages word for word, and a button that
// opens the document at that page. Answers from before this window existed only have source names; those are listed
// without passages.
export default function SourcesModal({ labels, evidence, loadEvidence, onClose, onOpenDocument }) {
  const [items, setItems] = useState(evidence || null);
  const [loading, setLoading] = useState(!evidence);
  useEscape(onClose, true);

  useEffect(() => {
    let alive = true;
    if (evidence) return undefined;
    (async () => {
      let found = null;
      try {
        found = loadEvidence ? await loadEvidence() : null;
      } catch (_) { /* shown as names only */ }
      if (alive) {
        setItems(found);
        setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [evidence, loadEvidence]);

  const wanted = new Set(labels || []);
  const shown = items && items.length
    ? items.filter((e) => !wanted.size || wanted.has(e.label))
    : (labels || []).map((label) => ({ label, file: label.split(' (')[0], passages: [] }));

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="sources-title" onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 id="sources-title" className={styles.title}>{t('Sources of this answer')}</h3>
          <button className={styles.close} onClick={onClose} aria-label={t('Close')}><X size={18} /></button>
        </div>
        <div className={styles.body}>
          {loading ? (
            <p className={styles.note}>{t('Loading the passages…')}</p>
          ) : (
            <>
              <p className={styles.note}>{t('The answer was written from these passages. Check them against the original before you rely on it.')}</p>
              {shown.map((e) => {
                const locator = (e.label.match(/\((.*)\)\s*$/) || [])[1];
                return (
                  <section key={e.label} className={styles.source}>
                    <div className={styles.sourceHead}>
                      <span className={styles.file}>
                        {e.scope === 'kb' ? <Database size={15} /> : <FileText size={15} />}
                        <span>{e.file}</span>
                      </span>
                      {locator && <span className={styles.where}>{readableLocator(locator)}</span>}
                    </div>
                    {e.passages && e.passages.map((p, i) => (
                      <blockquote key={i} className={styles.passage}>{p}</blockquote>
                    ))}
                    {e.scope === 'ws' && e.document_id && onOpenDocument && (
                      <button className={styles.open} onClick={() => onOpenDocument(e)}>
                        <ExternalLink size={14} />
                        {e.page ? t('Open document at page {page}', { page: e.page }) : t('Open document')}
                      </button>
                    )}
                  </section>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
