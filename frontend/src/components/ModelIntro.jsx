import React, { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';
import styles from './ModelIntro.module.css';
import { t } from '../i18n';
import { recommendationSentence } from '../utils/modelFitText';

const SEEN_KEY = 'starkllm_model_intro_seen';
const norm = (name) => (String(name || '').includes(':') ? String(name) : `${name}:latest`);

// The first start: the desktop app preselected the model recommended for this PC's hardware (model_tiers.json);
// the dashboard explains that choice once, in one sentence.
export default function ModelIntro({ token }) {
  const [text, setText] = useState('');

  useEffect(() => {
    let seen = false;
    try { seen = localStorage.getItem(SEEN_KEY) === '1'; } catch (_) { /* private mode */ }
    if (seen || !token) return undefined;
    let alive = true;
    const headers = { Authorization: `Bearer ${token}` };
    Promise.all([
      fetch('/api/v1/chat/models/hardware', { headers }).then((r) => (r.ok ? r.json() : null)),
      fetch('/api/v1/dashboard/system-status', { headers }).then((r) => (r.ok ? r.json() : null)),
    ]).then(([pc, status]) => {
      const chosen = status?.text_model?.name;
      if (!alive || !pc?.recommendation?.text?.name || !chosen) return;
      // only when the chat model in use is the recommended one (a model the user chose or had installed is theirs)
      if (norm(chosen) === norm(pc.recommendation.text.name)) setText(recommendationSentence(pc.recommendation, pc.hardware));
    }).catch(() => {});
    return () => { alive = false; };
  }, [token]);

  if (!text) return null;
  const close = () => {
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (_) { /* private mode */ }
    setText('');
  };
  return (
    <div className={styles.intro} role="status">
      <Sparkles size={18} className={styles.icon} />
      <div className={styles.body}>
        <strong className={styles.title}>{t('AI model chosen for this PC')}</strong>
        <span>{text} {t('You can choose another model in the Model Hub, which shows for every model whether it fits this PC.')}</span>
      </div>
      <button type="button" className={styles.close} onClick={close} title={t('Close')} aria-label={t('Close')}>
        <X size={16} />
      </button>
    </div>
  );
}
