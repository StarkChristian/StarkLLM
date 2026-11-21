import React, { useState } from 'react';
import { Compass, Loader, CheckCircle, AlertTriangle, Square, ExternalLink, ShieldAlert, Hand } from 'lucide-react';
import styles from './WebTaskCard.module.css';
import { t } from '../i18n';

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

export default function WebTaskCard({ task, onReply, onShowWindow }) {
  const running = task.status === 'starting' || task.status === 'running';
  const header = running
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
        {onShowWindow && (
          <button type="button" className={styles.link} onClick={onShowWindow}>
            <ExternalLink size={14} /> {t('Show the window')}
          </button>
        )}
      </div>
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
    </div>
  );
}
