import React, { useCallback, useEffect, useState } from 'react';
import { Play, Pause, Trash2, RefreshCw, Bell } from 'lucide-react';
import styles from './PrivacyPanel.module.css';
import { t } from '../i18n';
import { UI_LOCALE } from '../utils/locale';
import { webTaskBridge } from '../utils/webTask';
import { ruleInWords } from '../utils/scheduleWords';

// Scheduled web tasks (docs/roadmap-2026-12.md, R5): what runs by itself, when it ran, what it found, and whether the
// answer changed since the run before. The desktop app runs them; this list only shows and changes them.
export default function ScheduledWebTasks() {
  const bridge = webTaskBridge();
  const [list, setList] = useState([]);
  const [running, setRunning] = useState('');
  const load = useCallback(() => {
    if (!bridge || !bridge.schedules) return;
    bridge.schedules.list().then((r) => setList((r && r.schedules) || [])).catch(() => {});
  }, [bridge]);
  useEffect(() => {
    load();
    if (!bridge || !bridge.schedules) return undefined;
    return bridge.schedules.onChange(load);
  }, [bridge, load]);
  if (!bridge || !bridge.schedules) return null;

  const runNow = async (id) => {
    setRunning(id);
    try { await bridge.schedules.runNow(id); } finally { setRunning(''); load(); }
  };
  const toggle = async (s) => { await bridge.schedules.setEnabled(s.id, s.enabled === false); load(); };
  const remove = async (s) => {
    if (!window.confirm(t('Remove the scheduled task “{task}”?', { task: s.task.slice(0, 80) }))) return;
    await bridge.schedules.remove(s.id);
    load();
  };
  const when = (ms) => (ms ? new Date(ms).toLocaleString(UI_LOCALE, { dateStyle: 'short', timeStyle: 'short' }) : '');

  return (
    <>
      <h3 className={styles.sub}>{t('Scheduled web tasks')}</h3>
      <p className={styles.summary}>
        {t('They run by themselves while StarkLLM runs and is online, and only look: StarkLLM answers every question of the task with "no", so it never buys, books or sends anything and stops where a sign-in would be needed. A notification shows when an answer changed.')}
      </p>
      {list.length === 0 ? (
        <p className={styles.muted}>{t('No scheduled tasks yet. After a web task, choose “Repeat this task”.')}</p>
      ) : (
        <ul className={styles.schedules}>
          {list.map((s) => (
            <li key={s.id} className={s.enabled === false ? styles.paused : ''}>
              <div className={styles.scheduleHead}>
                <strong>{s.task.length > 120 ? `${s.task.slice(0, 119)}…` : s.task}</strong>
                <span className={styles.muted}>{ruleInWords(s.rule)}{s.enabled === false ? ` · ${t('paused')}` : ''}</span>
              </div>
              {s.lastRun ? (
                <div className={styles.muted}>
                  {t('Last run: {when}', { when: when(s.lastRun) })}
                  {' · '}
                  {s.lastStatus === 'done' ? t('answered') : s.lastStatus === 'stopped' ? t('stopped') : t('not finished')}
                  {s.changedAt && s.changedAt === s.lastRun && <span className={styles.changed}> <Bell size={12} /> {t('changed')}</span>}
                </div>
              ) : (
                <div className={styles.muted}>{t('Not run yet')}</div>
              )}
              {s.lastAnswer && (
                <details>
                  <summary>{t('Last answer')}</summary>
                  <p className={styles.answer}>{s.lastAnswer}</p>
                </details>
              )}
              <div className={styles.toolbar}>
                <button type="button" className={styles.btn} onClick={() => runNow(s.id)} disabled={Boolean(running)}>
                  <RefreshCw size={14} className={running === s.id ? 'spinner' : undefined} /> {t('Run now')}
                </button>
                <button type="button" className={styles.btn} onClick={() => toggle(s)}>
                  {s.enabled === false ? <><Play size={14} /> {t('Resume')}</> : <><Pause size={14} /> {t('Pause')}</>}
                </button>
                <button type="button" className={styles.btn} onClick={() => remove(s)}><Trash2 size={14} /> {t('Remove')}</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
