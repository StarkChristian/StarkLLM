import React, { useEffect, useState } from 'react';
import { X, PenLine, Loader, Copy, Check, FileText, FileDown, RotateCcw, CalendarClock, AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import { t, language } from '../i18n';
import { useEscape } from '../utils/useEscape';
import { UI_LOCALE } from '../utils/locale';
import { saveAsWord, saveAsPdf } from '../utils/exportDocs';
import { REPLY_KINDS, letterExport, shownDeadlines } from '../utils/replyLetter';
import { useToast } from './Toast';
import styles from './ReplyLetterModal.module.css';

// "Write a reply letter" on a letter of the inbox (2.8, option 10). StarkLLM drafts the letter from the letter's own
// facts and the user's details in Settings; the user edits it and exports it (Word, PDF) or copies it. Nothing is
// ever sent. The deadlines shown are the ones printed in the letter, each with its sentence; none is made up.

const KIND_LABEL = {
  cancel: t('Cancel a contract or subscription'),
  objection: t('Object to a notice, tax assessment or fine'),
  deferral: t('Ask for more time to pay or for a payment plan'),
  correction: t('Ask for a correction of an invoice'),
  sepa_revoke: t('Revoke a SEPA direct-debit mandate'),
};

const fmtDate = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(UI_LOCALE) : '');

function languageLabel(code) {
  try {
    return new Intl.DisplayNames([UI_LOCALE], { type: 'language' }).of(code) || code;
  } catch (_) {
    return code;
  }
}

export default function ReplyLetterModal({ token, doc, onClose, onOpenSource, onOpenSettings }) {
  useEscape(onClose, true);
  const toast = useToast();
  const headers = { Authorization: `Bearer ${token}` };
  const [kind, setKind] = useState(null);
  const [draft, setDraft] = useState(null);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null); // 'scam' | 'failed'
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(null);

  const write = async (chosen) => {
    setKind(chosen);
    setLoading(true);
    setError(null);
    setDraft(null);
    try {
      const res = await fetch('/api/v1/letters/draft', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: doc.scope, document_id: doc.id, kind: chosen, ui_language: language() }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body?.detail?.code === 'scam') { setError('scam'); return; }
      if (!res.ok) throw new Error(String(res.status));
      setDraft(body);
      setText(body.text);
    } catch (_) {
      setError('failed');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { setCopied(false); }, [text]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (_) {
      toast.error(t('Could not copy the letter.'));
    }
  };

  const save = async (format) => {
    const { title, items, words } = letterExport(text, draft?.subject, t('Reply letter (draft)'));
    setExporting(format);
    try {
      const args = { title, items, words: { ...words, sources: t('Sources'), exported: t('Exported from StarkLLM') }, dateText: new Date().toLocaleDateString(UI_LOCALE), headers, lang: draft?.language || 'en', dir: 'ltr' };
      const ok = format === 'docx' ? await saveAsWord(args) : await saveAsPdf(args);
      if (ok === false) toast.error(t('The export did not work.'));
    } catch (_) {
      toast.error(t('The export did not work.'));
    } finally {
      setExporting(null);
    }
  };

  const deadlines = shownDeadlines(draft);

  return (
    <div className={styles.backdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={t('Write a reply letter')}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.headerIcon}><PenLine size={16} /></span>
            <div>
              <h3 className={styles.title}>{t('Write a reply letter')}</h3>
              <p className={styles.subtitle}>{doc.title || doc.filename}</p>
            </div>
          </div>
          <button className={styles.closeBtn} onClick={onClose} title={t('Close')}><X size={16} /></button>
        </div>

        <div className={styles.body}>
          {!kind && (
            <>
              <p className={styles.lead}>{t('What should the letter do? StarkLLM writes a draft from the facts of this letter. You check and change it before you use it.')}</p>
              <ul className={styles.kinds}>
                {REPLY_KINDS.map((k) => (
                  <li key={k}><button className={styles.kindBtn} onClick={() => write(k)}>{KIND_LABEL[k]}</button></li>
                ))}
              </ul>
            </>
          )}

          {loading && (
            <div className={styles.loading}>
              <Loader size={22} className="spinner" />
              <p>{t('Writing the draft on this PC…')}</p>
              <p className={styles.muted}>{t('The local model writes the letter from the facts of this letter. This can take a minute.')}</p>
            </div>
          )}

          {error === 'scam' && (
            <p className={styles.danger}><ShieldAlert size={15} /> {t('No reply letter: this letter shows signs of a scam. Contact the sender only through an address or phone number you already know.')}</p>
          )}
          {error === 'failed' && (
            <p className={styles.danger}><AlertTriangle size={15} /> {t('The draft could not be written. Is StarkLLM running?')}</p>
          )}

          {draft && !loading && (
            <div className={styles.draftLayout}>
              <div className={styles.editor}>
                <div className={styles.editorHead}>
                  <strong>{KIND_LABEL[kind]}</strong>
                  <span className={styles.muted}>{t('Written in {language}, as letters are written there.', { language: languageLabel(draft.language) })}</span>
                </div>
                <textarea
                  className={styles.textarea}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  spellCheck
                  lang={draft.language}
                  aria-label={t('Reply letter (draft)')}
                />
                <p className={styles.muted}>
                  {draft.body_source === 'model'
                    ? t('The text was written by the local model ({model}). Sentences with a date, time limit or number that is not in the letter were removed.', { model: draft.model })
                    : t('The text is a fixed template: no local model was available, or its text did not pass the check.')}
                  {' '}{t('Fill in the parts in square brackets.')}
                </p>
              </div>

              <aside className={styles.side}>
                {!draft.profile_complete && (
                  <div className={styles.notice}>
                    <Info size={15} />
                    <span>
                      {t('Your name and address are missing. Fill them in once in Settings, under "Your details for letters".')}
                      {onOpenSettings && <> <button className={styles.linkBtn} onClick={onOpenSettings}>{t('Open Settings')}</button></>}
                    </span>
                  </div>
                )}

                <h4 className={styles.sideTitle}><CalendarClock size={15} /> {t('Deadlines in the letter')}</h4>
                {deadlines.length === 0 ? (
                  <div className={styles.warn}>
                    <strong>{t('Please check the deadline')}</strong>
                    <span>{t('The letter states no deadline. StarkLLM does not make one up.')}</span>
                  </div>
                ) : (
                  <ul className={styles.deadlines}>
                    {deadlines.map((d, i) => (
                      <li key={i}>
                        <span className={styles.deadlineHead}>
                          <span>{d.notice ? t('Last day to give notice') : d.kind === 'payment' ? t('Payment') : t('Deadline')}</span>
                          <strong>{d.date ? fmtDate(d.date) : d.literal}</strong>
                          {d.passed && <span className={styles.passed}>{t('passed')}</span>}
                        </span>
                        <button className={styles.source} onClick={() => onOpenSource && onOpenSource({ page: d.page, text: d.text })} title={t('Show on page {page}', { page: d.page })}>
                          {t('Source: “{text}” (page {page})', { text: d.text, page: d.page })}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className={styles.muted}>{t('Check yourself whether another deadline applies, for example one set by law.')}</p>

                <div className={styles.legal}>
                  <AlertTriangle size={15} />
                  <span>{t('This is not legal advice. Check the letter and the deadlines yourself, or ask an advice centre or a lawyer.')}</span>
                </div>
                <p className={styles.muted}>{t('StarkLLM never sends letters. Print or save the letter, sign it and send it yourself.')}</p>
              </aside>
            </div>
          )}
        </div>

        {draft && !loading && (
          <div className={styles.footer}>
            <button className="btn-secondary" onClick={() => { setKind(null); setDraft(null); setError(null); }}>
              <RotateCcw size={14} /> {t('Other kind of letter')}
            </button>
            <span className={styles.grow} />
            <button className="btn-secondary" onClick={copy}>{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? t('Copied!') : t('Copy')}</button>
            <button className="btn-secondary" onClick={() => save('docx')} disabled={exporting !== null}>
              {exporting === 'docx' ? <Loader size={14} className="spinner" /> : <FileText size={14} />} {t('Word')}
            </button>
            <button className="btn-primary" onClick={() => save('pdf')} disabled={exporting !== null}>
              {exporting === 'pdf' ? <Loader size={14} className="spinner" /> : <FileDown size={14} />} {t('PDF')}
            </button>
          </div>
        )}
        {(error && !loading) && (
          <div className={styles.footer}>
            <span className={styles.grow} />
            {error === 'failed' && <button className="btn-secondary" onClick={() => write(kind)}><RotateCcw size={14} /> {t('Try again')}</button>}
            <button className="btn-secondary" onClick={onClose}>{t('Close')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
