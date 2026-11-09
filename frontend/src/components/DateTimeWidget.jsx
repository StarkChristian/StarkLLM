import React, { useState, useEffect } from 'react';
import { Clock, Calendar } from 'lucide-react';
import styles from './DateTimeWidget.module.css';
import { UI_LOCALE } from '../utils/locale';

export default function DateTimeWidget() {
  const [time, setTime] = useState(new Date());

  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatTime = (date) => {
    return date.toLocaleTimeString(UI_LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  };

  const formatDate = (date) => {
    return date.toLocaleDateString(UI_LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  };

  return (
    <div className={styles.widget}>
      <div className={styles.header}>
        <Clock className={styles.icon} size={18} />
        <span className={styles.title}>System Time</span>
      </div>
      <div className={styles.timeDisplay}>
        {formatTime(time)}
      </div>
      <div className={styles.dateDisplay}>
        <Calendar size={14} className={styles.calIcon} />
        {formatDate(time)}
      </div>
    </div>
  );
}
