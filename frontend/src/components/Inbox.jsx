import React, { useEffect, useMemo, useState } from 'react';
import { Inbox as InboxIcon, FileText, Image, Check, RotateCcw, Pencil, X, FolderOpen, CalendarClock, ShieldAlert, Copy, ChevronDown, ChevronRight } from 'lucide-react';
import DocumentViewerModal from './DocumentViewerModal';
import EmptyState from './EmptyState';
import { UI_LOCALE } from '../utils/locale';
import { t } from '../i18n';
import styles from './Inbox.module.css';

// The document inbox (docs/document-inbox-design.md, B4): what StarkLLM read in each new letter, to check and mark
// done, and the letters grouped into cases by sender. Every fact links to the page it was read from. StarkLLM only
// suggests: titles and cases are the user's to change, and nothing is renamed or moved on disk.

const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'webp', 'tif', 'tiff']);

const TYPE_LABEL = {
  debt_collection: t('Debt collection'),
  reminder: t('Reminder'),
  fine: t('Fine'),
  tax_notice: t('Tax notice'),
  payslip: t('Payslip'),
  termination: t('Cancellation'),
  statement: t('Statement'),
  invoice: t('Invoice'),
  job_offer: t('Job offer'),
  contract: t('Contract'),
  invitation: t('Invitation'),
  medical: t('Medical letter'),
  price_change: t('Change of terms'),
  payment_notice: t('Direct debit notice'),
  notice: t('Official notice'),
  insurance: t('Insurance'),
  prize: t('Prize notice'),
  message: t('Text message'),
};

const REFERENCE_LABEL = {
  customer_number: t('Customer number'),
  invoice_number: t('Invoice number'),
  contract_number: t('Contract number'),
  policy_number: t('Policy number'),
  tax_number: t('Tax number'),
  file_number: t('File number'),
  member_number: t('Member number'),
  employee_number: t('Employee number'),
  mandate_reference: t('Mandate reference'),
  reference: t('Reference'),
};

const DATE_LABEL = { deadline: t('Deadline'), payment: t('Payment'), appointment: t('Appointment'), change: t('Change') };

const fmtDate = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(UI_LOCALE) : '');

// "Stadtwerke Rheinstadt · Reminder · 06.11.2026", or the file name when nothing was understood
export function suggestedTitle(doc) {
  const f = doc.facts || {};
  const parts = [f.sender?.value, f.type ? TYPE_LABEL[f.type.value] : null, f.date ? fmtDate(f.date.value) : null].filter(Boolean);
  return parts.length >= 2 ? parts.join(' · ') : doc.filename;
}

export default function Inbox({ token, onViewChange, onCountChange }) {
  const headers = { Authorization: `Bearer ${token}` };
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState('new');
  const [viewing, setViewing] = useState(null);
  const [editing, setEditing] = useState(null); // { key, title }
  const [openCase, setOpenCase] = useState(null);

  const load = async () => {
    try {
      const res = await fetch('/api/v1/dashboard/inbox', { headers });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      setData(body);
      setError(false);
      if (onCountChange) onCountChange(body.new_count);
    } catch (_) {
      setError(true);
    }
  };
  useEffect(() => {
    if (!token) return undefined;
    load();
    const timer = setInterval(load, 20000);  // new uploads show up without a reload
    return () => clearInterval(timer);
  }, [token]);

  const save = async (doc, change) => {
    await fetch(`/api/v1/dashboard/inbox/${doc.scope}/${doc.id}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(change),
    });
    load();
  };
  const allDone = async () => {
    await fetch('/api/v1/dashboard/inbox/done', { method: 'POST', headers });
    load();
  };

  const open = (doc, fact) => {
    if (doc.scope === 'ws' && doc.workspace_id) {
      setViewing({ workspaceId: doc.workspace_id, documentId: doc.id, page: fact?.page || 1, highlight: fact?.text });
    } else if (onViewChange) {
      onViewChange('knowledge-base');
    }
  };

  const docs = data?.documents || [];
  const byKey = useMemo(() => Object.fromEntries(docs.map((d) => [`${d.scope}-${d.id}`, d])), [docs]);
  const newDocs = docs.filter((d) => d.status === 'new');
  const cases = data?.cases || [];
  const shown = tab === 'new' ? newDocs : docs;

  const whenText = (iso) => {
    const days = Math.round((new Date(`${iso}T12:00:00`) - new Date(`${data.today}T12:00:00`)) / 86400000);
    if (days === 0) return t('today');
    if (days === 1) return t('tomorrow');
    return t('in {days} days', { days });
  };

  // plain render functions, not components: a component defined in here is new on every render, and the title field
  // lost its focus after each key
  const factLink = (doc, fact, children, key) => (
    <button key={key} className={styles.fact} onClick={() => open(doc, fact)} title={t('Show on page {page}: {text}', { page: fact.page, text: fact.text })}>
      {children}
    </button>
  );

  const renderDoc = (doc) => {
    const f = doc.facts || {};
    const key = `${doc.scope}-${doc.id}`;
    const isEditing = editing?.key === key;
    const due = (f.amounts || []).filter((a) => !a.role).slice(0, 3);
    const datesShown = (f.dates || []).filter((d) => d.value >= data.today).sort((a, b) => a.value.localeCompare(b.value)).slice(0, 3);
    return (
      <li key={key} className={`${styles.doc} ${doc.status === 'done' ? styles.docDone : ''}`}>
        <div className={styles.docHead}>
          <span className={styles.docIcon}>{IMAGE_TYPES.has((doc.file_type || '').toLowerCase()) ? <Image size={18} /> : <FileText size={18} />}</span>
          <div className={styles.docTitleWrap}>
            {isEditing ? (
              <form
                className={styles.titleForm}
                onSubmit={(e) => { e.preventDefault(); save(doc, { title: editing.title }); setEditing(null); }}
              >
                <input
                  autoFocus
                  className={styles.titleInput}
                  value={editing.title}
                  maxLength={200}
                  aria-label={t('Title')}
                  onChange={(e) => setEditing({ key, title: e.target.value })}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(null); } }}
                />
                <button type="submit" className={styles.iconBtn} title={t('Save')}><Check size={15} /></button>
                <button type="button" className={styles.iconBtn} title={t('Cancel')} onClick={() => setEditing(null)}><X size={15} /></button>
              </form>
            ) : (
              <button className={styles.docTitle} onClick={() => open(doc, f.type || f.sender)}>
                {doc.title || suggestedTitle(doc)}
              </button>
            )}
            <span className={styles.docMeta}>
              {doc.filename}
              {doc.scope === 'kb' ? ` · ${t('Knowledge base')}` : doc.workspace ? ` · ${doc.workspace}` : ''}
              {doc.added ? ` · ${t('added {date}', { date: new Date(doc.added).toLocaleDateString(UI_LOCALE) })}` : ''}
            </span>
          </div>
          <div className={styles.docActions}>
            {!isEditing && (
              <button className={styles.iconBtn} title={t('Rename')} onClick={() => setEditing({ key, title: doc.title || suggestedTitle(doc) })}>
                <Pencil size={15} />
              </button>
            )}
            {doc.status === 'new' ? (
              <button className={styles.doneBtn} onClick={() => save(doc, { status: 'done' })}>
                <Check size={15} /> {t('Done')}
              </button>
            ) : (
              <button className={styles.undoBtn} onClick={() => save(doc, { status: 'new' })} title={t('Back to the new letters')}>
                <RotateCcw size={14} /> {t('New')}
              </button>
            )}
          </div>
        </div>

        <div className={styles.badges}>
          {doc.suspicious && <span className={styles.badgeDanger}><ShieldAlert size={13} /> {t('Possible scam: do not pay before you checked it with the sender')}</span>}
          {doc.replaced && <span className={styles.badgeMuted}>{t('Replaced by a newer letter')}</span>}
          {doc.duplicate_of && <span className={styles.badgeMuted}><Copy size={12} /> {t('Same letter as {file}', { file: doc.duplicate_of.filename })}</span>}
        </div>

        <dl className={styles.facts}>
          {f.type && (<><dt>{t('Kind')}</dt><dd>{factLink(doc, f.type, TYPE_LABEL[f.type.value] || f.type.value)}</dd></>)}
          {f.sender && (<><dt>{t('From')}</dt><dd>{factLink(doc, f.sender, f.sender.value)}</dd></>)}
          {f.date && (<><dt>{t('Letter date')}</dt><dd>{factLink(doc, f.date, fmtDate(f.date.value))}</dd></>)}
          {(f.references || []).slice(0, 4).map((r, i) => (
            <React.Fragment key={`r${i}`}><dt>{REFERENCE_LABEL[r.kind] || t('Reference')}</dt><dd>{factLink(doc, r, r.value)}</dd></React.Fragment>
          ))}
          {due.length > 0 && (<><dt>{t('Amounts')}</dt><dd className={styles.factList}>{due.map((a, i) => factLink(doc, a, a.value, i))}</dd></>)}
          {(f.accounts || []).length > 0 && (<><dt>{t('Bank account')}</dt><dd className={styles.factList}>{f.accounts.map((a, i) => factLink(doc, a, <span className={styles.mono}>{a.value}</span>, i))}</dd></>)}
        </dl>

        {datesShown.length > 0 && !doc.suspicious && !doc.replaced && (
          <ul className={styles.dates}>
            {datesShown.map((d, i) => (
              <li key={i}>
                {factLink(doc, d, (
                  <>
                    <span className={styles[`kind_${d.kind}`] || styles.kind_payment}>{DATE_LABEL[d.kind] || d.kind}</span>
                    <strong>{fmtDate(d.value)}</strong>
                    <span className={styles.dateWhen}>{whenText(d.value)}{d.time ? ` · ${t('at {time}', { time: d.time })}` : ''}</span>
                    {d.amount && <span>{d.amount}</span>}
                  </>
                ))}
              </li>
            ))}
          </ul>
        )}
      </li>
    );
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}><InboxIcon size={24} /> {t('Inbox')}</h1>
          <p className={styles.subtitle}>{t('What StarkLLM read in your letters. Click a value to see it on the page; mark a letter done when you have dealt with it.')}</p>
        </div>
        {newDocs.length > 1 && tab === 'new' && (
          <button className="btn-secondary" onClick={allDone}><Check size={15} /> {t('Mark all as done')}</button>
        )}
      </header>

      <div className={styles.tabs} role="tablist">
        <button role="tab" aria-selected={tab === 'new'} className={tab === 'new' ? styles.tabActive : styles.tab} onClick={() => setTab('new')}>
          {t('New')} {newDocs.length > 0 && <span className={styles.count}>{newDocs.length}</span>}
        </button>
        <button role="tab" aria-selected={tab === 'cases'} className={tab === 'cases' ? styles.tabActive : styles.tab} onClick={() => setTab('cases')}>
          {t('Cases')} {cases.length > 0 && <span className={styles.countMuted}>{cases.length}</span>}
        </button>
        <button role="tab" aria-selected={tab === 'all'} className={tab === 'all' ? styles.tabActive : styles.tab} onClick={() => setTab('all')}>
          {t('All documents')} {docs.length > 0 && <span className={styles.countMuted}>{docs.length}</span>}
        </button>
      </div>

      {!data ? (
        <p className={styles.note}>{error ? t('The inbox could not be loaded. Is StarkLLM running?') : t('Looking through your documents…')}</p>
      ) : tab === 'cases' ? (
        cases.length === 0 ? (
          <EmptyState icon={FolderOpen} title={t('No cases yet')} hint={t('Letters of the same sender are put together here.')} />
        ) : (
          <ul className={styles.cases}>
            {cases.map((c) => {
              const isOpen = openCase === c.key;
              // newest letter first (by the date on the letter, else when it was added)
              const letterDate = (d) => d.facts?.date?.value || (d.added || '').slice(0, 10);
              const members = c.documents.map((d) => byKey[`${d.scope}-${d.id}`]).filter(Boolean)
                .sort((a, b) => letterDate(b).localeCompare(letterDate(a)));
              return (
                <li key={c.key} className={styles.case}>
                  <button className={styles.caseHead} onClick={() => setOpenCase(isOpen ? null : c.key)} aria-expanded={isOpen}>
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    <span className={styles.caseName}>{c.name || c.key}</span>
                    <span className={styles.caseCount}>{c.documents.length === 1 ? t('1 document') : t('{count} documents', { count: c.documents.length })}</span>
                    {c.suspicious > 0 && <span className={styles.badgeDanger}><ShieldAlert size={13} /> {t('{count} suspicious', { count: c.suspicious })}</span>}
                    {c.next && (
                      <span className={styles.caseNext}>
                        <CalendarClock size={14} /> {DATE_LABEL[c.next.kind]} {fmtDate(c.next.value)}{c.next.amount ? ` · ${c.next.amount}` : ''}
                      </span>
                    )}
                  </button>
                  {c.references.length > 0 && (
                    <div className={styles.caseRefs}>
                      {c.references.slice(0, 4).map((r, i) => <span key={i}>{REFERENCE_LABEL[r.kind] || t('Reference')}: <span className={styles.mono}>{r.value}</span></span>)}
                    </div>
                  )}
                  {isOpen && <ul className={styles.list}>{members.map((d) => renderDoc(d))}</ul>}
                </li>
              );
            })}
          </ul>
        )
      ) : shown.length === 0 ? (
        <EmptyState
          icon={InboxIcon}
          title={tab === 'new' ? t('No new letters') : t('No documents yet')}
          hint={tab === 'new' ? t('New letters and documents show up here with what StarkLLM read in them.') : t('Add a letter, a scan or a photo, or put files into your knowledge base folder.')}
        />
      ) : (
        <ul className={styles.list}>{shown.map((d) => renderDoc(d))}</ul>
      )}

      {data && <p className={styles.hint}>{t('Found by fixed rules, word for word in your documents. Check the letter before you act on it.')}</p>}

      {viewing && (
        <DocumentViewerModal
          isOpen
          onClose={() => setViewing(null)}
          workspaceId={viewing.workspaceId}
          documentId={viewing.documentId}
          initialPage={viewing.page}
          highlight={viewing.highlight}
          token={token}
        />
      )}
    </div>
  );
}
