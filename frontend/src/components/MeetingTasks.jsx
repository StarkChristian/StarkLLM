import React, { useEffect, useMemo, useState } from 'react';
import { ListChecks, Check, RotateCcw, Trash2 } from 'lucide-react';
import { t } from '../i18n';
import { sourceLabel } from '../utils/meeting';
import { UI_LOCALE } from '../utils/locale';
import { whenText } from './Deadlines';
import styles from './Meeting.module.css';

// Tasks from meetings that the user added (2.8, option 13), above the deadlines of the letters. Each one shows the
// time in the meeting it was said ("[00:12:30]") and opens the transcript there.

const fmtDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(UI_LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });

export default function MeetingTasks({ token, onOpen }) {
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const [tasks, setTasks] = useState([]);
  const [showDone, setShowDone] = useState(false);

  const load = async () => {
    try {
      const res = await fetch('/api/v1/meetings/tasks', { headers });
      if (res.ok) setTasks((await res.json()).tasks || []);
    } catch (_) { /* nothing shown */ }
  };
  useEffect(() => {
    if (!token) return undefined;
    load();
    const timer = setInterval(load, 20000);
    return () => clearInterval(timer);
  }, [token]);

  const setDone = async (task, done) => {
    await fetch(`/api/v1/meetings/tasks/${task.id}`, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ done }),
    });
    load();
  };
  const remove = async (task) => {
    await fetch(`/api/v1/meetings/tasks/${task.id}`, { method: 'DELETE', headers });
    load();
  };

  if (!tasks.length) return null;
  const done = tasks.filter((x) => x.done).length;
  const shown = showDone ? tasks : tasks.filter((x) => !x.done);

  return (
    <section className={styles.tasksCard} aria-labelledby="meeting-tasks">
      <div className={styles.tasksHead}>
        <h3 id="meeting-tasks"><ListChecks size={16} /> {t('Tasks from meetings')}</h3>
        {done > 0 && (
          <label className={styles.check}>
            <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> {t('Show done ({count})', { count: done })}
          </label>
        )}
      </div>
      <ul className={styles.list}>
        {shown.map((task) => (
          <li key={task.id} className={`${styles.item} ${task.done ? styles.itemDecided : ''}`}>
            <span className={styles.taskText}>{task.text}</span>
            <div className={styles.taskFacts}>
              {task.owner && <span>{t('Who: {name}', { name: task.owner })}</span>}
              {task.due_date
                ? <span>{fmtDate(task.due_date)} · {whenText(task.days)}</span>
                : task.due_text ? <span>{t('Due: {words}', { words: task.due_text })}</span> : null}
              <button className={styles.sourceBtn} onClick={() => onOpen({ scope: 'ws', document_id: task.document_id, workspace_id: task.workspace_id, page: 1, text: task.text })}>
                {task.filename} · {sourceLabel(task.time)}
              </button>
            </div>
            <div className={styles.taskButtons}>
              {task.done
                ? <button className="btn-secondary" onClick={() => setDone(task, false)}><RotateCcw size={14} /> {t('Not done')}</button>
                : <button className="btn-secondary" onClick={() => setDone(task, true)}><Check size={14} /> {t('Done')}</button>}
              <button className="btn-secondary" onClick={() => remove(task)} title={t('Remove from the list')} aria-label={t('Remove from the list')}><Trash2 size={14} /></button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
