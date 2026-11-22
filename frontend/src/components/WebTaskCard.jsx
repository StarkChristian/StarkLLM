import React, { useState } from 'react';
import { Compass, Loader, CheckCircle, AlertTriangle, Square, ExternalLink, ShieldAlert, Hand, Pause, Play, FilePlus, Bookmark, Repeat } from 'lucide-react';
import styles from './WebTaskCard.module.css';
import { t } from '../i18n';
import { UI_LOCALE } from '../utils/locale';
import { weekdayName } from '../utils/schedule';
import { ruleInWords } from '../utils/scheduleWords';

// A web task in the chat (docs/web-tasks.md): StarkLLM works in its own browser window; here the user sees each
// step, answers its questions, allows or refuses a risky click, and does a sign-in, a payment or a CAPTCHA in the
// window before pressing "Continue".

function stepText(s) {
  const d = s.detail || '';
  switch (s.action) {
    case 'open': return t('Opened {page}', { page: d });
    case 'search': return t('Searched for “{words}”', { words: d });
    case 'click': return t('Clicked {element}', { element: d });
    case 'type': return t('Typed {text}', { text: d });
    case 'select': return t('Chose {option}', { option: d });
    case 'scroll': return d === 'up' ? t('Scrolled up') : t('Scrolled down');
    case 'back': return t('Went back');
    case 'read': return t('Read the page {page}', { page: d });
    case 'asked': return t('Asked you: {question}', { question: d });
    case 'refused': return t('Not done: you did not allow it');
    case 'user': return t('A step for you in the window');
    case 'problem': return t('Did not work: {reason}', { reason: d });
    case 'blocked': return t('Not opened: {site} (site rules)', { site: d });
    default: return d;
  }
}

function AskBox({ ask, onReply }) {
  const [answer, setAnswer] = useState('');
  if (ask.kind === 'confirm') {
    return (
      <div className={`${styles.ask} ${styles.askRisky}`} role="alert">
        <ShieldAlert size={18} />
        <div className={styles.askBody}>
          <p>{t('StarkLLM wants to click “{label}”. This can buy, book, pay, send or delete something.', { label: ask.text })}</p>
          <p className={styles.askHost}>{ask.url}</p>
          <div className={styles.askButtons}>
            <button type="button" className={styles.secondary} onClick={() => onReply(ask.qid, { ok: false })}>{t('Do not allow')}</button>
            <button type="button" className={styles.primary} onClick={() => onReply(ask.qid, { ok: true })}>{t('Allow this click')}</button>
          </div>
        </div>
      </div>
    );
  }
  if (ask.kind === 'site') {
    const why = ask.siteKind === 'finance' ? t('This looks like a bank or payment site.')
      : ask.siteKind === 'health' ? t('This looks like a health site.')
        : t('This looks like a government site.');
    return (
      <div className={`${styles.ask} ${styles.askRisky}`} role="alert">
        <ShieldAlert size={18} />
        <div className={styles.askBody}>
          <p>{t('StarkLLM wants to work on {site}.', { site: ask.text })} {why} {t('Allow it?')}</p>
          <div className={styles.askButtons}>
            <button type="button" className={styles.secondary} onClick={() => onReply(ask.qid, { ok: false, remember: true })}>{t('Never on this site')}</button>
            <button type="button" className={styles.secondary} onClick={() => onReply(ask.qid, { ok: false })}>{t('Not now')}</button>
            <button type="button" className={styles.secondary} onClick={() => onReply(ask.qid, { ok: true, remember: true })}>{t('Always allow this site')}</button>
            <button type="button" className={styles.primary} onClick={() => onReply(ask.qid, { ok: true })}>{t('Allow for this task')}</button>
          </div>
        </div>
      </div>
    );
  }
  if (ask.kind === 'handoff') {
    const captcha = ask.text === 'captcha';
    return (
      <div className={`${styles.ask} ${styles.askHandoff}`} role="alert">
        <Hand size={18} />
        <div className={styles.askBody}>
          <p>
            {captcha
              ? t('The website wants to check that a person is there. Please answer the check yourself in the StarkLLM browser window, then press Continue.')
              : t('This step is for you: “{label}”. StarkLLM never types passwords, payment details or codes. Please do it in the StarkLLM browser window, then press Continue.', { label: ask.text })}
          </p>
          <div className={styles.askButtons}>
            <button type="button" className={styles.secondary} onClick={() => onReply(ask.qid, { ok: false })}>{t('Skip')}</button>
            <button type="button" className={styles.primary} onClick={() => onReply(ask.qid, { ok: true })}>{t('Continue')}</button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.ask} role="alert">
      <Compass size={18} />
      <div className={styles.askBody}>
        <p>{ask.text}</p>
        <form onSubmit={(e) => { e.preventDefault(); onReply(ask.qid, { ok: Boolean(answer.trim()), text: answer.trim() }); }}>
          <input className={styles.askInput} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={t('Your answer')} autoFocus />
          <div className={styles.askButtons}>
            <button type="button" className={styles.secondary} onClick={() => onReply(ask.qid, { ok: false })}>{t('Skip')}</button>
            <button type="submit" className={styles.primary} disabled={!answer.trim()}>{t('Send')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function RepeatForm({ onSchedule, task }) {
  const [open, setOpen] = useState(false);
  const [every, setEvery] = useState('day');
  const [time, setTime] = useState('08:00');
  const [weekday, setWeekday] = useState(1);
  const [state, setState] = useState('');
  const save = async () => {
    setState('saving');
    const rule = every === 'week' ? { every, time, weekday: Number(weekday) } : { every, time };
    const ok = await onSchedule(task, rule);
    setState(ok ? `saved:${ruleInWords(rule)}` : 'failed');
  };
  if (state.startsWith('saved:')) {
    return <span className={styles.hint}>{t('Scheduled {when}. It only looks; results are under Settings › Privacy & network.', { when: state.slice(6) })}</span>;
  }
  if (!open) {
    return (
      <button type="button" className={styles.secondary} onClick={() => setOpen(true)}>
        <Repeat size={14} /> {t('Repeat this task')}
      </button>
    );
  }
  return (
    <span className={styles.repeatForm}>
      <select value={every} onChange={(e) => setEvery(e.target.value)} aria-label={t('How often')}>
        <option value="day">{t('daily')}</option>
        <option value="week">{t('weekly')}</option>
      </select>
      {every === 'week' && (
        <select value={weekday} onChange={(e) => setWeekday(e.target.value)} aria-label={t('Day')}>
          {[1, 2, 3, 4, 5, 6, 0].map((d) => <option key={d} value={d}>{weekdayName(d, UI_LOCALE)}</option>)}
        </select>
      )}
      <input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label={t('Time')} />
      <button type="button" className={styles.primary} onClick={save} disabled={state === 'saving' || !/^\d{2}:\d{2}$/.test(time)}>{t('Schedule')}</button>
      {state === 'failed' && <span className={styles.error}>{t('The task could not be scheduled.')}</span>}
    </span>
  );
}

export default function WebTaskCard({ task, onReply, onShowWindow, onPause, onResume, onSavePage, onSaveTask, onSchedule }) {
  const running = task.status === 'starting' || task.status === 'running';
  const [saved, setSaved] = useState('');
  const [taskSaved, setTaskSaved] = useState('');
  const saveTask = async () => {
    setTaskSaved('saving');
    const ok = await onSaveTask(task.task);
    setTaskSaved(ok ? 'saved' : 'failed');
  };
  const save = async () => {
    setSaved('saving');
    const ok = await onSavePage();
    setSaved(ok ? 'saved' : 'failed');
  };
  const header = running && task.paused
    ? <><Pause size={16} />{t('Web task paused: the window is yours')}</>
    : running
    ? <><Loader size={16} className={styles.spin} />{t('Web task: StarkLLM is working in its browser window')}</>
    : task.status === 'done'
      ? <><CheckCircle size={16} />{t('Web task done')}</>
      : task.status === 'stopped'
        ? <><Square size={16} />{t('Web task stopped')}</>
        : <><AlertTriangle size={16} />{t('Web task not finished')}</>;
  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.title}>{header}</span>
        <span className={styles.actions}>
          {running && !task.ask && onPause && !task.paused && (
            <button type="button" className={styles.link} onClick={onPause} title={t('Pause the task and use the window yourself')}>
              <Pause size={14} /> {t('Take over')}
            </button>
          )}
          {running && task.paused && onResume && (
            <button type="button" className={styles.link} onClick={onResume}>
              <Play size={14} /> {t('Hand back to StarkLLM')}
            </button>
          )}
          {onShowWindow && (
            <button type="button" className={styles.link} onClick={onShowWindow}>
              <ExternalLink size={14} /> {t('Show the window')}
            </button>
          )}
        </span>
      </div>
      {running && task.paused && (
        <p className={styles.hint}>{t('StarkLLM waits. Do what you like in its browser window, then hand it back: StarkLLM looks at the page again and goes on.')}</p>
      )}
      {task.steps.length > 0 && (
        <details className={styles.steps} open={running}>
          <summary>{t('{count} steps', { count: task.steps.length })}</summary>
          <ol>
            {task.steps.map((s, k) => <li key={k}>{stepText(s)}</li>)}
          </ol>
        </details>
      )}
      {task.ask && <AskBox key={task.ask.qid} ask={task.ask} onReply={onReply} />}
      {task.error && <p className={styles.error}>{task.error}</p>}
      {task.status === 'done' && onSavePage && task.url && (
        <div className={styles.saveRow}>
          <button type="button" className={styles.secondary} onClick={save} disabled={saved === 'saving' || saved === 'saved'}>
            <FilePlus size={14} /> {t('Save this page to the workspace')}
          </button>
          {saved === 'saved' && <span className={styles.hint}>{t('Saved. You can ask about it like about your other documents.')}</span>}
          {saved === 'failed' && <span className={styles.error}>{t('The page could not be saved.')}</span>}
        </div>
      )}
      {task.status === 'done' && onSaveTask && task.task && (
        <div className={styles.saveRow}>
          <button type="button" className={styles.secondary} onClick={saveTask} disabled={taskSaved === 'saving' || taskSaved === 'saved'}>
            <Bookmark size={14} /> {t('Save as a reusable web task')}
          </button>
          {taskSaved === 'saved' && <span className={styles.hint}>{t('Saved under Templates. Choose it there to run the task again; parts in {{double braces}} become fields to fill in.')}</span>}
          {taskSaved === 'failed' && <span className={styles.error}>{t('The task could not be saved.')}</span>}
        </div>
      )}
      {task.status === 'done' && onSchedule && task.task && (
        <div className={styles.saveRow}>
          <RepeatForm onSchedule={onSchedule} task={task.task} />
        </div>
      )}
      {task.status === 'error' && (
        // measured (docs/web-tasks.md): 7B models finish few web tasks, 14B and larger finish them
        <p className={styles.hint}>{t('Web tasks work much better with a larger local model (14B or more, for example qwen3:14b).')}</p>
      )}
    </div>
  );
}
