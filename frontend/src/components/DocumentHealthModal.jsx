import React, { useEffect, useState } from 'react';
import { X, Stethoscope, Loader, AlertTriangle, CheckCircle2 } from 'lucide-react';
import styles from './DocumentHealthModal.module.css';
import { useEscape } from '../utils/useEscape';
import { pageList } from '../utils/documentHealth';
import { t } from '../i18n';

// "Document health" (2.7): what StarkLLM could read from one document and what may be missing, so a weak answer can be
// traced to its cause (a scan without text, a password, unaccepted tracked changes, a table read as plain text).
// The data comes from the engine (GET .../documents/{id}/health, services/document_health.py); no model is asked.
function warningText(w) {
  switch (w.kind) {
    case 'parse_error':
      return w.detail
        ? t('The file could not be read completely: {detail}', { detail: w.detail })
        : t('The file could not be read completely.');
    case 'encrypted':
      return t('The file is protected with a password, so StarkLLM cannot read its text. Save a copy without the password and upload it again.');
    case 'empty_pages':
      return t('No text was found on {count} page(s): {pages}. If these pages are scans, check the reading languages in Settings > Reading photos and scans, then re-index the document.', { count: w.count, pages: pageList(w.pages) });
    case 'little_text':
      return t('Very little text was found ({chars} characters). Answers from this document may be incomplete.', { chars: w.chars });
    case 'tracked_changes':
      return t('The Word file contains {count} tracked change(s) that were not accepted. The text StarkLLM read may differ from what you see. Accept or reject the changes in Word and upload the file again.', { count: w.count });
    case 'tables_flattened':
      return (w.pages && w.pages.length)
        ? t('Tables were found on page(s) {pages}. Their cells were read as plain text and the column layout is lost: check answers about values from these tables.', { pages: pageList(w.pages) })
        : t('{count} table(s) were read row by row as plain text and the column layout is lost: check answers about values from these tables.', { count: w.count });
    case 'hidden_text':
      return t('Hidden text (white, tiny or invisible) was found and left out.');
    case 'not_indexed':
      return t('This document is not indexed yet.');
    default:
      return w.kind;
  }
}

function Row({ label, children }) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{children}</span>
    </div>
  );
}

export default function DocumentHealthModal({ workspaceId, documentId, token, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEscape(onClose);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/v1/documents/${workspaceId}/documents/${documentId}/health`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.detail || String(res.status));
        if (alive) setData(body);
      } catch (e) {
        if (alive) setError(e.message);
      }
    })();
    return () => { alive = false; };
  }, [workspaceId, documentId, token]);

  const ocr = data?.ocr;
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={t('Document health')} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.titleArea}>
            <Stethoscope size={18} />
            <h3 className={styles.title}>{t('Document health')}{data ? `: ${data.filename}` : ''}</h3>
          </div>
          <button className={styles.close} onClick={onClose} title={t('Close')} aria-label={t('Close')}><X size={18} /></button>
        </div>
        <div className={styles.body}>
          {!data && !error && <div className={styles.loading}><Loader size={18} className="spinner" /> {t('Checking the document...')}</div>}
          {error && <p className={styles.error}>{t('The document health could not be loaded: {error}', { error })}</p>}
          {data && (
            <>
              {data.warnings.length === 0 ? (
                <p className={styles.ok}><CheckCircle2 size={16} /> {t('No problems found: StarkLLM could read this document.')}</p>
              ) : (
                <ul className={styles.warnings}>
                  {data.warnings.map((w, i) => (
                    <li key={i}><AlertTriangle size={15} className={styles.warnIcon} /> <span>{warningText(w)}</span></li>
                  ))}
                </ul>
              )}
              <div className={styles.grid}>
                {data.pages != null && <Row label={t('Pages')}>{t('{withText} of {pages} with text', { withText: data.pages_with_text, pages: data.pages })}</Row>}
                <Row label={t('Passages in the search')}>{data.chunks}</Row>
                <Row label={t('Characters read')}>{data.chars.toLocaleString()}</Row>
                <Row label={t('Text recognition (OCR)')}>
                  {ocr.used ? (
                    <>
                      {t('Used on page(s) {pages}', { pages: pageList(ocr.pages) })}
                      {ocr.languages.length > 0
                        ? ` · ${t('Languages: {languages}', { languages: ocr.languages.join(', ') })}`
                        : ` · ${t('Language not recorded (indexed before version 2.7)')}`}
                      {ocr.confidence != null && ` · ${t('Confidence: {value} %', { value: ocr.confidence })}`}
                    </>
                  ) : t('Not used')}
                </Row>
                {data.vision_pages.length > 0 && (
                  <Row label={t('Described by the image model')}>{t('Page(s) {pages}', { pages: pageList(data.vision_pages) })}</Row>
                )}
              </div>
              <h4 className={styles.subTitle}>{t('Extracted text (first part)')}</h4>
              {data.text_preview
                ? <pre className={styles.text}>{data.text_preview}{data.preview_truncated ? '\n…' : ''}</pre>
                : <p className={styles.muted}>{t('No text was extracted.')}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
