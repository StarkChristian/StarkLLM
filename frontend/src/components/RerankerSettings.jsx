import React, { useEffect, useRef, useState } from 'react';
import { Download, Trash2, Loader, CheckCircle } from 'lucide-react';
import styles from './Settings.module.css';
import { useToast } from './Toast';
import { megabytes, downloadPercent } from '../utils/documentHealth';
import { t } from '../i18n';

// Settings > Document search: the optional multilingual reranker (engine: services/reranker.py). It is downloaded only
// after a click on the button that shows its size; after that it runs on this PC and needs no network.
export default function RerankerSettings({ token }) {
  const toast = useToast();
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  const headers = { Authorization: `Bearer ${token}` };

  const load = async () => {
    try {
      const res = await fetch('/api/v1/reranker', { headers });
      if (!res.ok) throw new Error(String(res.status));
      setInfo(await res.json());
    } catch (_) {
      setInfo(null);
    }
  };

  useEffect(() => {
    load();
    return () => clearTimeout(timer.current);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // while downloading: look again every two seconds
  useEffect(() => {
    clearTimeout(timer.current);
    if (info?.download?.state === 'downloading') timer.current = setTimeout(load, 2000);
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  const call = async (method, url) => {
    setBusy(true);
    try {
      const res = await fetch(url, { method, headers });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail || String(res.status));
      setInfo(body);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!info) return null;
  const size = megabytes(info.download_bytes);
  const percent = downloadPercent(info.download);

  return (
    <div className={styles.infoBox}>
      <strong>{t('Better search with a reranker (optional)')}</strong>
      <p className={styles.panelDesc}>
        {t('A second search step on this PC: a multilingual model reads the best {count} passages together with your question and puts the most fitting ones first. It is downloaded once ({size}); after that it works fully offline and nothing about you or your documents is sent.', { count: info.max_candidates, size })}
      </p>
      {info.installed ? (
        <>
          <p className={styles.panelDesc}>
            <CheckCircle size={14} /> {t('Installed and in use.')}
            {info.last_ms != null && ` ${t('Last search: {ms} ms for {count} passages.', { ms: info.last_ms, count: info.last_candidates })}`}
          </p>
          {info.auto_off && (
            <p className={styles.panelDesc}>{t('This PC is too slow for the reranker at the moment, so StarkLLM searches without it and tries again later.')}</p>
          )}
          {info.load_failed && (
            <p className={styles.panelDesc}>{t('The reranker could not be started, so StarkLLM searches without it. Remove it and download it again.')}</p>
          )}
          {info.removable && (
            <button className="btn-secondary" disabled={busy} onClick={() => call('DELETE', '/api/v1/reranker')}>
              <Trash2 size={14} /> {t('Remove')}
            </button>
          )}
        </>
      ) : percent != null ? (
        <p className={styles.panelDesc}><Loader size={14} className="spinner" /> {t('Downloading... {percent} % of {size}', { percent, size })}</p>
      ) : (
        <>
          {info.download?.state === 'failed' && (
            <p className={styles.panelDesc}>{t('The download did not work: {error}', { error: info.download.error })}</p>
          )}
          {info.offline && <p className={styles.panelDesc}>{t('Fully offline mode is on, so the model cannot be downloaded now.')}</p>}
          <button className="btn-primary" disabled={busy || info.offline} onClick={() => call('POST', '/api/v1/reranker/install')}>
            {busy ? <Loader size={14} className="spinner" /> : <Download size={14} />} {t('Download ({size})', { size })}
          </button>
          <p className={styles.panelDesc}>{t('Without it, search works exactly as before.')}</p>
        </>
      )}
    </div>
  );
}
