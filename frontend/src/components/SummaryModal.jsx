import React, { useRef } from 'react';
import styles from './SummaryModal.module.css';
import { X, Copy, Check, Loader, FileText } from 'lucide-react';
import MarkdownIt from 'markdown-it';
import { blockRemoteImages } from '../utils/markdown';
import { t } from '../i18n';
import { useEscape } from '../utils/useEscape';

const md = blockRemoteImages(new MarkdownIt({ html: false }));

export default function SummaryModal({ chatTitle, summary, loading, error, onClose, onCopy, copied }) {
  useEscape(onClose, true);
  const contentRef = useRef(null);

  return (
    <div className={styles.backdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={t('Chat Summary')}>

        {/* ── Header ── */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <div className={styles.headerIcon}>
              <FileText size={16} />
            </div>
            <div>
              <h3 className={styles.title}>{t('Chat Summary')}</h3>
              {chatTitle && (
                <p className={styles.subtitle}>{chatTitle}</p>
              )}
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose} title={t('Close')}>
            <X size={16} />
          </button>
        </div>

        {/* ── Body ── */}
        <div className={styles.body} ref={contentRef}>
          {loading && (
            <div className={styles.loadingState}>
              <Loader size={24} className={styles.spinner} />
              <p className={styles.loadingText}>{t('Generating summary…')}</p>
              <p className={styles.loadingHint}>{t('Your local LLM is reading the conversation.')}</p>
            </div>
          )}

          {error && !loading && (
            <div className={styles.errorState}>
              <span className={styles.errorIcon}>⚠️</span>
              <p className={styles.errorTitle}>{t('Summary failed')}</p>
              <p className={styles.errorMsg}>{error}</p>
            </div>
          )}

          {summary && !loading && (
            <div
              className={styles.summaryContent}
              dangerouslySetInnerHTML={{ __html: md.render(summary) }}
            />
          )}
        </div>

        {/* ── Footer ── */}
        {summary && !loading && (
          <div className={styles.footer}>
            <p className={styles.footerNote}>{t('Generated locally · not stored')}</p>
            <button
              className={`${styles.copyBtn} ${copied ? styles.copied : ''}`}
              onClick={onCopy}
              title={t('Copy summary')}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? t('Copied!') : t('Copy')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
