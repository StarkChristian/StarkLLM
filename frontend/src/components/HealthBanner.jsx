import React, { useState, useEffect } from 'react';
import { AlertTriangle, Server, Cpu, Brain, Zap, X } from 'lucide-react';
import styles from './HealthBanner.module.css';
import { t } from '../i18n';

export default function HealthBanner({ token }) {
  const [data, setData] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!token) return;

    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/v1/dashboard/system-status', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const json = await res.json();
          setData(json);
        }
      } catch (err) {
        console.error("Failed to fetch system status", err);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 30_000);
    return () => clearInterval(interval);
  }, [token]);

  if (!data || dismissed) return null;

  const errors = [];
  
  if (data.backend?.status === 'offline') {
    errors.push({ icon: Server, msg: data.backend.error || t('Backend is unreachable.') });
  } else {
    if (data.ollama?.status === 'offline' || data.ollama?.status === 'degraded') {
      errors.push({ icon: Cpu, msg: data.ollama.error || t('Ollama is offline.') });
    }
    if (data.ollama?.outdated) {
      errors.push({ icon: Cpu, msg: t('Ollama {version} has a known security flaw. Please update Ollama to {min} or newer: ollama.com/download', { version: data.ollama.version, min: data.ollama.min_version }) });
    }
    if (data.text_model?.status === 'missing') {
      errors.push({ icon: Brain, msg: data.text_model.error || t('Text model missing.') });
    }
    if (data.embedding_model?.status === 'missing') {
      errors.push({ icon: Zap, msg: data.embedding_model.error || t('Embedding model missing.') });
    }
  }

  if (errors.length === 0) return null;

  return (
    <div className={styles.bannerContainer}>
      <div className={styles.bannerContent}>
        <div className={styles.iconWrapper}>
          <AlertTriangle size={18} />
        </div>
        <div className={styles.errorList}>
          <h4 className={styles.bannerTitle}>{t('System Issues Detected')}</h4>
          {errors.map((err, idx) => (
            <div key={idx} className={styles.errorItem}>
              <err.icon size={14} className={styles.itemIcon} />
              <span>{err.msg}</span>
            </div>
          ))}
        </div>
      </div>
      <button 
        className={styles.dismissBtn} 
        onClick={() => setDismissed(true)}
        title={t('Dismiss warning')}
      >
        <X size={16} />
      </button>
    </div>
  );
}
