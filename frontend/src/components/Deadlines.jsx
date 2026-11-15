import React, { useEffect, useMemo, useState } from 'react';
import { CalendarClock, CalendarPlus, Bell, BellRing, Check } from 'lucide-react';
import EmptyState from './EmptyState';
import { UI_LOCALE } from '../utils/locale';
import { downloadFile } from '../utils/download';
import { t, language } from '../i18n';
import styles from './Deadlines.module.css';

// Deadlines of all letters (docs/document-inbox-design.md, B5): the list with page and line, reminders and a calendar
// file. Every date was read word for word from a letter by fixed rules; reminders and the calendar file stay on this PC.

const KIND_LABEL = { deadline: t('Deadline'), payment: t('Payment'), appointment: t('Appointment') };
const REMINDER_CHOICES = [7, 3, 1, 0];  // days before; 0 = on the day
const STATE_CLASS = { overdue: 'stateOverdue', today: 'stateToday', soon: 'stateSoon', upcoming: 'stateUpcoming' };

const fmtDate = (iso, opts) => new Date(`${iso}T12:00:00`).toLocaleDateString(UI_LOCALE, opts);
const dayWord = (n) => (n === 0 ? t('On the day') : n === 1 ? t('1 day before') : t('{days} days before', { days: n }));

export function whenText(days) {
  if (days < 0) return days === -1 ? t('1 day overdue') : t('{days} days overdue', { days: -days });
  if (days === 0) return t('today');
  if (days === 1) return t('tomorrow');
  return t('in {days} days', { days });
}

const icsName = (keys) => (keys.length === 1 ? 'StarkLLM-deadline.ics' : 'StarkLLM-deadlines.ics');

async function saveCalendar(headers, keys) {
  const query = new URLSearchParams();
  keys.forEach((k) => query.append('key', k));
  query.set('lang', language());
  return downloadFile(`/api/v1/dashboard/deadlines.ics?${query}`, headers, icsName(keys));
}

function useDeadlines(token, every) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(false);
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const load = async () => {
    try {
      const res = await fetch('/api/v1/dashboard/deadlines', { headers });
      if (!res.ok) throw new Error(String(res.status));
      setData(await res.json());
      setError(false);
    } catch (_) {
      setError(true);
    }
  };
  useEffect(() => {
    if (!token) return undefined;
    load();
    const timer = setInterval(load, every);
    return () => clearInterval(timer);
  }, [token]);
  return { data, error, headers, load };
}

// The list of all deadlines, in the inbox
export default function Deadlines({ token, onOpen }) {
  const { data, error, headers, load } = useDeadlines(token, 20000);
  const [selected, setSelected] = useState(() => new Set());
  const [failed, setFailed] = useState(false);

  const deadlines = data?.deadlines || [];
  const keys = new Set(deadlines.map((d) => d.key));
  const chosen = [...selected].filter((k) => keys.has(k));

  const toggle = (key) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const setReminders = async (deadline, daysBefore) => {
    await fetch('/api/v1/dashboard/deadlines/reminders', {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: deadline.key, days_before: daysBefore }),
    });
    load();
  };
  const toggleReminder = (deadline, days) => {
    const has = deadline.reminders.includes(days);
    setReminders(deadline, has ? deadline.reminders.filter((x) => x !== days) : [...deadline.reminders, days]);
  };
  const calendar = async (list) => setFailed(!(await saveCalendar(headers, list)));

  if (!data) return <p className={styles.note}>{error ? t('The deadlines could not be loaded. Is StarkLLM running?') : t('Looking through your documents…')}</p>;
  if (deadlines.length === 0) {
    return <EmptyState icon={CalendarClock} title={t('No deadlines')} hint={t('When a letter names a deadline, a payment date or an appointment, it shows up here.')} />;
  }
  const counts = data.counts || {};

  return (
    <div className={styles.wrap}>
      <div className={styles.toolbar}>
        <span className={styles.summary}>
          {counts.overdue > 0 && <span className={styles.stateOverdue}>{t('{count} overdue', { count: counts.overdue })}</span>}
          {counts.today + counts.soon > 0 && <span className={styles.stateSoon}>{t('{count} due within a week', { count: counts.today + counts.soon })}</span>}
          <span>{t('{count} in total', { count: deadlines.length })}</span>
        </span>
        <span className={styles.toolbarActions}>
          <button className="btn-secondary" disabled={chosen.length === 0} onClick={() => calendar(chosen)}>
            <CalendarPlus size={15} /> {t('Add selected to calendar')}{chosen.length > 0 ? ` (${chosen.length})` : ''}
          </button>
          <button className="btn-secondary" onClick={() => calendar([])} title={t('All deadlines from today on, as a calendar file for Outlook, Google or your phone')}>
            <CalendarPlus size={15} /> {t('Add all to calendar')}
          </button>
        </span>
      </div>
      {failed && <p className={styles.error} role="alert">{t('The calendar file could not be made.')}</p>}

      <ul className={styles.list}>
        {deadlines.map((d) => (
          <li key={d.key} className={`${styles.item} ${d.state === 'overdue' ? styles.itemOverdue : ''}`}>
            <label className={styles.pick}>
              <input type="checkbox" checked={selected.has(d.key)} onChange={() => toggle(d.key)} aria-label={t('Select for the calendar')} />
            </label>
            <span className={styles.dateBox}>
              <span className={styles.day}>{fmtDate(d.date, { day: 'numeric' })}</span>
              <span className={styles.month}>{fmtDate(d.date, { month: 'short', year: 'numeric' })}</span>
            </span>
            <div className={styles.body}>
              <div className={styles.meta}>
                <span className={styles[`kind_${d.kind}`]}>{KIND_LABEL[d.kind] || d.kind}</span>
                <span className={styles[STATE_CLASS[d.state]]}>{whenText(d.days)}{d.time ? ` · ${t('at {time}', { time: d.time })}` : ''}</span>
                {d.amount && <strong>{d.amount}</strong>}
                {d.reminder_active && <span className={styles.bell} title={t('Reminder is on')}><BellRing size={13} /> {t('Reminder due')}</span>}
              </div>
              <div className={styles.who}>{d.title || d.sender || d.filename}</div>
              <button className={styles.text} onClick={() => onOpen(d)} title={t('Show on page {page}: {text}', { page: d.page, text: d.text })}>
                {d.text}
              </button>
              <button className={styles.source} onClick={() => onOpen(d)}>
                {d.filename} · {t('Page {page}', { page: d.page })}{d.line ? `, ${t('line {line}', { line: d.line })}` : ''}
              </button>
              <div className={styles.reminders} role="group" aria-label={t('Remind me')}>
                <Bell size={13} />
                <span className={styles.remindLabel}>{t('Remind me')}</span>
                {REMINDER_CHOICES.map((days) => (
                  <button
                    key={days}
                    className={d.reminders.includes(days) ? styles.chipOn : styles.chip}
                    aria-pressed={d.reminders.includes(days)}
                    onClick={() => toggleReminder(d, days)}
                  >
                    {dayWord(days)}
                  </button>
                ))}
              </div>
            </div>
            <button className={styles.calBtn} onClick={() => calendar([d.key])} title={t('Add to calendar')} aria-label={t('Add to calendar')}>
              <CalendarPlus size={16} />
            </button>
          </li>
        ))}
      </ul>
      <p className={styles.hint}>{t('Found by fixed rules, word for word in your documents. Check the letter before you act on it.')}</p>
    </div>
  );
}

// Reminders that have begun, and what is overdue, on the dashboard. Shows nothing when there is nothing to do.
export function DueReminders({ token, onOpen, onShowAll }) {
  const { data, headers, load } = useDeadlines(token, 60000);
  const list = (data?.deadlines || []).filter((d) => d.reminder_active || (d.state === 'overdue'));
  if (list.length === 0) return null;
  const confirm = async (d) => {
    await fetch('/api/v1/dashboard/deadlines/reminders/ack', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: d.key }),
    });
    load();
  };
  return (
    <section className={styles.reminderCard} aria-labelledby="home-reminders">
      <div className={styles.reminderHead} id="home-reminders">
        <BellRing size={16} /> {t('Deadlines to look at')}
        <button className={styles.allLink} onClick={onShowAll}>{t('All deadlines')}</button>
      </div>
      <ul className={styles.reminderList}>
        {list.slice(0, 6).map((d) => (
          <li key={d.key} className={styles.reminderRow}>
            <button className={styles.reminderMain} onClick={() => onOpen(d)}>
              <span className={styles[STATE_CLASS[d.state]]}>{whenText(d.days)}</span>
              <strong>{fmtDate(d.date, { day: 'numeric', month: 'short' })}</strong>
              <span>{KIND_LABEL[d.kind]}: {d.title || d.sender || d.filename}</span>
              {d.amount && <strong>{d.amount}</strong>}
            </button>
            {d.reminder_active && (
              <button className={styles.gotIt} onClick={() => confirm(d)} title={t('Hide this reminder')}>
                <Check size={14} /> {t('Got it')}
              </button>
            )}
          </li>
        ))}
      </ul>
      {list.length > 6 && <p className={styles.hint}>{t('{count} more', { count: list.length - 6 })}</p>}
    </section>
  );
}
