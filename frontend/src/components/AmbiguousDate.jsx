import React from 'react';
import { CalendarClock } from 'lucide-react';
import { UI_LOCALE } from '../utils/locale';
import { t } from '../i18n';
import styles from './AmbiguousDate.module.css';

// A date like 03/04/2026 that the letter itself does not settle. StarkLLM does not guess: both readings are shown,
// the user chooses, and until then the date is used for no reminder and no calendar entry (backend: DateChoice).
const day = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(UI_LOCALE, { day: 'numeric', month: 'long', year: 'numeric' });

export default function AmbiguousDate({ date, onChoose, onOpen }) {
  const { dmy, mdy } = date.readings;
  return (
    <div className={styles.box} role="group" aria-label={t('Unclear date: {literal}', { literal: date.literal })}>
      <button className={styles.where} onClick={onOpen} title={t('Show on page {page}: {text}', { page: date.page, text: date.text })}>
        <CalendarClock size={14} /> <strong>{t('Unclear date: {literal}', { literal: date.literal })}</strong>
      </button>
      <span className={styles.hint}>
        {t('The letter does not say which comes first. Choose how to read it; until then this date is used for no reminder and no calendar entry.')}
      </span>
      <span className={styles.choices}>
        <button onClick={() => onChoose('dmy')}>{t('Day first: {date}', { date: day(dmy) })}</button>
        <button onClick={() => onChoose('mdy')}>{t('Month first: {date}', { date: day(mdy) })}</button>
      </span>
    </div>
  );
}

// the date after the user chose: a small way back
export function ChosenDate({ date, onUndo }) {
  return (
    <button className={styles.undo} onClick={onUndo} title={t('Choose again')}>
      {t('Read as {date}', { date: day(date.value) })} · {t('Choose again')}
    </button>
  );
}
