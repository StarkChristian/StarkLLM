import React, { useState, useEffect, useCallback, useRef } from 'react';
import styles from './OnboardingWizard.module.css';
import { CheckCircle2, XCircle, RefreshCw, Server, Cpu, Brain, Zap, TerminalSquare, Clock } from 'lucide-react';
import { t } from '../i18n';

// How long to keep retrying before giving up and showing the error panel (seconds)
const STARTUP_RETRY_TIMEOUT_SEC = 90;
const RETRY_INTERVAL_MS = 4000;

export default function OnboardingWizard({ token, onComplete }) {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  // While the backend is booting we show a friendly "Starting…" state instead of a fatal error
  const [isStarting, setIsStarting] = useState(false);
  const [startingSeconds, setStartingSeconds] = useState(0);

  const retryTimerRef = useRef(null);
  const elapsedRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  const fetchStatus = useCallback(async (isRetry = false) => {
    if (!mountedRef.current) return;
    if (!isRetry) {
      // Manual re-check: reset counters
      elapsedRef.current = 0;
      setStartingSeconds(0);
      setIsStarting(false);
      setErrorMsg(null);
    }
    setLoading(true);
    try {
      const res = await fetch('/api/v1/dashboard/system-status', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const json = await res.json();
        if (!mountedRef.current) return;
        setData(json);
        setIsStarting(false);
        setErrorMsg(null);

        // Check if completely healthy
        const allHealthy =
          json.backend?.status === 'online' &&
          json.ollama?.status === 'online' &&
          json.text_model?.status === 'online' &&
          json.embedding_model?.status === 'online';

        if (allHealthy) {
          onComplete();
        }
      } else if ((res.status === 502 || res.status === 503 || res.status === 504) && !isRetry) {
        // First-time 502: backend probably still booting — start retry loop
        if (!mountedRef.current) return;
        setIsStarting(true);
        scheduleRetry();
      } else if (res.status === 502 || res.status === 503 || res.status === 504) {
        // Mid-retry 502: keep retrying if within timeout
        if (!mountedRef.current) return;
        if (elapsedRef.current < STARTUP_RETRY_TIMEOUT_SEC * 1000) {
          scheduleRetry();
        } else {
          setIsStarting(false);
          setErrorMsg(t('Server returned {status}. The backend did not start within {seconds} seconds.', { status: res.status, seconds: STARTUP_RETRY_TIMEOUT_SEC }));
        }
      } else {
        if (!mountedRef.current) return;
        setIsStarting(false);
        setErrorMsg(`Server returned ${res.status}`);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      // Network error — could be backend not yet up
      if (!isRetry) {
        setIsStarting(true);
        scheduleRetry();
      } else if (elapsedRef.current < STARTUP_RETRY_TIMEOUT_SEC * 1000) {
        scheduleRetry();
      } else {
        setIsStarting(false);
        setErrorMsg(err.message || t('Failed to connect to backend.'));
      }
    }
    if (mountedRef.current) setLoading(false);
  }, [token, onComplete]); // eslint-disable-line react-hooks/exhaustive-deps

  const scheduleRetry = useCallback(() => {
    elapsedRef.current += RETRY_INTERVAL_MS;
    setStartingSeconds(Math.round(elapsedRef.current / 1000));
    retryTimerRef.current = setTimeout(() => {
      fetchStatus(true);
    }, RETRY_INTERVAL_MS);
  }, [fetchStatus]);

  // Initial fetch on mount
  useEffect(() => {
    fetchStatus(false);
  }, [fetchStatus]);

  const handleSkip = () => {
    onComplete();
  };

  const handleManualRecheck = () => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    fetchStatus(false);
  };

  const StatusItem = ({ label, status, error, icon: Icon, iconColor }) => {
    const isOnline = status === 'online';

    return (
      <div className={`${styles.statusItem} ${!isOnline ? styles.statusItemError : ''}`}>
        <div className={styles.statusHeader}>
          <div className={styles.statusIcon} style={{ background: `${iconColor}22`, color: iconColor }}>
            <Icon size={18} />
          </div>
          <div className={styles.statusLabel}>{label}</div>
          <div className={styles.statusBadge}>
            {isOnline ? (
              <span className={styles.badgeSuccess}><CheckCircle2 size={16} /> {t('Ready')}</span>
            ) : (
              <span className={styles.badgeError}><XCircle size={16} /> {status || 'Unknown'}</span>
            )}
          </div>
        </div>
        {!isOnline && error && (
          <div className={styles.actionableBox}>
            <div className={styles.actionableTitle}>{t('Action Required:')}</div>
            <div className={styles.actionableText}>
              <TerminalSquare size={14} />
              {error}
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── Full-screen loader: first check in progress (no prior data or starting state)
  if (loading && !data && !isStarting) {
    return (
      <div className={styles.wizardContainer}>
        <div className={styles.loaderBox}>
          <RefreshCw size={24} className={styles.spinning} />
          <p>{t('Running system readiness checks...')}</p>
        </div>
      </div>
    );
  }

  // ── "Backend is starting" full-screen state
  if (isStarting && !data) {
    return (
      <div className={styles.wizardContainer}>
        <div className={styles.loaderBox}>
          <Clock size={28} className={styles.spinSlow} />
          <p style={{ fontWeight: 600, fontSize: '1.1rem', color: 'var(--text-primary)' }}>
            {t('Starting backend…')}
          </p>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', textAlign: 'center', maxWidth: 360 }}>
            {t('The backend is still starting. On the first run this can take 1–2 minutes.')}
            <br />{t('Please wait — the app will open automatically when ready.')}
          </p>
          {startingSeconds > 0 && (
            <p style={{ color: '#6366f1', fontSize: '0.85rem' }}>
              {t('Retrying… {seconds} s', { seconds: startingSeconds })}
            </p>
          )}
          <button className={styles.skipBtn} onClick={handleSkip} style={{ marginTop: '1rem' }}>
            {t('Skip / Proceed anyway')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.wizardContainer}>
      <div className={styles.wizardCard}>
        <div className={styles.wizardHeader}>
          <h2>{t('Welcome to StarkLLM')}</h2>
          <p>{t('Let\'s make sure your local AI environment is fully set up before we begin.')}</p>
        </div>

        <div className={styles.wizardBody}>
          {errorMsg ? (
            <div className={styles.criticalError}>
              <strong>{t('Connection Error:')}</strong> {errorMsg}
              <p>
                {t('Cannot reach the StarkLLM backend. It may still be starting: press Re-check Status in a moment, or Skip / Proceed anyway.')}
              </p>
            </div>
          ) : isStarting ? (
            <div className={styles.startingNotice}>
              <RefreshCw size={16} className={styles.spinning} />
              <span>{t('Backend is starting up — retrying automatically…')}</span>
            </div>
          ) : (
            <div className={styles.statusList}>
              <StatusItem
                icon={Server}
                iconColor="#6366f1"
                label={t('Backend API Server')}
                status={data?.backend?.status}
                error={data?.backend?.error}
              />
              <StatusItem
                icon={Cpu}
                iconColor="#06b6d4"
                label={t('Ollama Engine')}
                status={data?.ollama?.status}
                error={data?.ollama?.error}
              />
              <StatusItem
                icon={Brain}
                iconColor="#8b5cf6"
                label={`Text Model (${data?.text_model?.name || 'Required'})`}
                status={data?.text_model?.status}
                error={data?.text_model?.error}
              />
              <StatusItem
                icon={Zap}
                iconColor="#f59e0b"
                label={`Embedding Model (${data?.embedding_model?.name || 'Required'})`}
                status={data?.embedding_model?.status}
                error={data?.embedding_model?.error}
              />
            </div>
          )}
        </div>

        <div className={styles.wizardFooter}>
          <button className={styles.skipBtn} onClick={handleSkip}>
            {t('Skip / Proceed anyway')}
          </button>

          <button
            className={`${styles.recheckBtn} ${loading ? styles.spinningBtn : ''}`}
            onClick={handleManualRecheck}
            disabled={loading}
          >
            <RefreshCw size={16} className={loading ? styles.spinning : ''} />
            {loading ? t('Checking...') : t('Re-check Status')}
          </button>
        </div>
      </div>
    </div>
  );
}
