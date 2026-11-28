import React from 'react';
import { CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import styles from './ModelFitBadge.module.css';
import { fitLabel, fitReason } from '../utils/modelFitText';

// "Fits well" / "Tight (slower)" / "Will not fit" for one model, with the reason in one line (the model picker).
export default function ModelFitBadge({ fit, compact = false }) {
  if (!fit || !fit.fit) return null;
  const Icon = fit.fit === 'good' ? CheckCircle2 : fit.fit === 'tight' ? AlertTriangle : XCircle;
  const tone = fit.fit === 'good' ? styles.good : fit.fit === 'tight' ? styles.tight : styles.no;
  return (
    <div className={styles.fit}>
      <span className={`${styles.badge} ${tone}`}>
        <Icon size={12} /> {fitLabel(fit)}
      </span>
      {!compact && <span className={styles.reason}>{fitReason(fit)}</span>}
    </div>
  );
}
