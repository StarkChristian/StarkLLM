import React, { useEffect, useState } from 'react';
import { X, Loader, ListChecks, Check, SkipForward, AlertTriangle, Sparkles } from 'lucide-react';
import { t } from '../i18n';
import { useEscape } from '../utils/useEscape';
import { sourceLabel } from '../utils/meeting';
import { UI_LOCALE } from '../utils/locale';
import styles from './Meeting.module.css';

// "Summarize the meeting": decisions, open points and tasks, each with the time it was said. Owners and dates are
// only what was said in the meeting. A task goes into the deadline list only when the user adds it.

const fmtDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(UI_LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });

function Item({ item }) {
  return (
    <li className={styles.item}>
      <span className={styles.time}>{sourceLabel(item.time)}</span>
      <span>{item.text}</span>
      {item.quote && <q className={styles.quote}>{item.quote}</q>}
    </li>
  );
}

function Task({ task, onDecide }) {
  const [owner, setOwner] = useState(task.owner || '');
  const [due, setDue] = useState(task.due_date || '');
  const decided = task.status !== 'proposed';
  return (
    <li className={`${styles.item} ${decided ? styles.itemDecided : ''}`}>
      <span className={styles.time}>{sourceLabel(task.time)}</span>
      <span className={styles.taskText}>{task.text}</span>
      {task.quote && <q className={styles.quote}>{task.quote}</q>}
      <div className={styles.taskFacts}>
        <span>{task.owner ? t('Who: {name}', { name: task.owner }) : t('No one was named')}</span>
        <span>
          {task.due_text
            ? (task.due_date ? t('Due: {words} ({date})', { words: task.due_text, date: fmtDate(task.due_date) }) : t('Due: {words}', { words: task.due_text }))
            : t('No date was said')}
        </span>
      </div>
      {task.status === 'proposed' ? (
        <div className={styles.taskForm}>
          <label>
            <span>{t('Who')}</span>
            <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder={t('optional')} maxLength={80} />
          </label>
          <label>
            <span>{t('Due date')}</span>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          </label>
          <button className="btn-primary" onClick={() => onDecide(task, 'add', { owner, due_date: due })}>
            <Check size={14} /> {t('Add to the list')}
          </button>
          <button className="btn-secondary" onClick={() => onDecide(task, 'skip')}>
            <SkipForward size={14} /> {t('Skip')}
          </button>
        </div>
      ) : (
        <span className={styles.status}>{task.status === 'added' ? t('In the deadline list') : t('Skipped')}</span>
      )}
    </li>
  );
}

export default function MeetingSummary({ token, meeting, filename, onClose }) {
  useEscape(onClose, true);
  const headers = { Authorization: `Bearer ${token}` };
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch(`/api/v1/meetings/${meeting.id}/summary`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => setSummary(body?.summary || null))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [meeting.id]);

  const summarize = async () => {
    setWorking(true);
    setError('');
    try {
      const res = await fetch(`/api/v1/meetings/${meeting.id}/summary`, { method: 'POST', headers });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || String(res.status));
      setSummary((await res.json()).summary);
    } catch (e) {
      setError(t('The meeting could not be summarized: {error}', { error: e.message }));
    } finally {
      setWorking(false);
    }
  };

  const decide = async (task, action, changes = {}) => {
    const body = { action };
    if (action === 'add') {
      if ((changes.owner || '') !== (task.owner || '')) body.owner = changes.owner || null;
      if ((changes.due_date || '') !== (task.due_date || '')) body.due_date = changes.due_date || null;
    }
    const res = await fetch(`/api/v1/meetings/${meeting.id}/tasks/${task.index}`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      setError(t('The task could not be added: {error}', { error: (await res.json().catch(() => ({}))).detail || res.status }));
      return;
    }
    const { task: updated } = await res.json();
    setSummary((s) => ({ ...s, tasks: s.tasks.map((x) => (x.index === updated.index ? updated : x)) }));
  };

  const empty = summary && !summary.decisions.length && !summary.open_points.length && !summary.tasks.length;

  return (
    <div className={styles.backdrop} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`${styles.modal} ${styles.wide}`} role="dialog" aria-modal="true" aria-label={t('Summarize the meeting')}>
        <div className={styles.header}>
          <h3 className={styles.title}><ListChecks size={16} /> {t('Summarize the meeting')}</h3>
          <button className={styles.closeBtn} onClick={onClose} title={t('Close')} aria-label={t('Close')}><X size={16} /></button>
        </div>
        <div className={styles.body}>
          <p className={styles.subtitle}>{filename}</p>
          {error && <p className={styles.error} role="alert"><AlertTriangle size={14} /> {error}</p>}
          {loading ? (
            <p className={styles.hint}><Loader size={14} className={styles.spin} /></p>
          ) : (
            <>
              <button className={styles.recordBtn} onClick={summarize} disabled={working}>
                {working ? <Loader size={15} className={styles.spin} /> : <Sparkles size={15} />}
                {working ? t('Your local model is reading the meeting…') : summary ? t('Summarize again') : t('Summarize the meeting')}
              </button>
              {empty && <p className={styles.hint}>{t('Nothing was found in the meeting for these lists.')}</p>}
              {summary && (
                <>
                  <h4 className={styles.section}>{t('Decisions')}</h4>
                  {summary.decisions.length ? <ul className={styles.list}>{summary.decisions.map((d, i) => <Item key={i} item={d} />)}</ul> : <p className={styles.hint}>{t('None')}</p>}
                  <h4 className={styles.section}>{t('Open points')}</h4>
                  {summary.open_points.length ? <ul className={styles.list}>{summary.open_points.map((d, i) => <Item key={i} item={d} />)}</ul> : <p className={styles.hint}>{t('None')}</p>}
                  <h4 className={styles.section}>{t('Tasks')}</h4>
                  <p className={styles.hint}>{t('Please check each task. Only the tasks you add go into the deadline list of the inbox.')}</p>
                  {summary.tasks.length ? <ul className={styles.list}>{summary.tasks.map((task) => <Task key={`${task.index}-${task.status}`} task={task} onDecide={decide} />)}</ul> : <p className={styles.hint}>{t('None')}</p>}
                  <p className={styles.hint}>{t('Made by the model on this PC and checked against the transcript: a name or a date that was not said is left out. Please check before you act on it.')}</p>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
