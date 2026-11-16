import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { ShieldCheck, WifiOff, Download, Trash2, RefreshCw, AlertTriangle } from 'lucide-react';
import styles from './PrivacyPanel.module.css';
import { t } from '../i18n';
import { readOffline, setOffline, onOfflineChange, readNetworkLog, clearNetworkLog, toCsv, download } from '../utils/privacy';

// Settings > Privacy & network (roadmap phase 3, "provable privacy"): the fully offline switch and the list of every
// outgoing connection of the app and the engine, kept on this PC. The list holds hosts, purposes and sizes, never a
// path, a search term or a file name.

function featureLabel(key) {
  switch (key) {
    case 'model_download': return t('AI model download');
    case 'ollama_cloud_model': return t('Ollama cloud model');
    case 'web_search': return t('Web search');
    case 'web_import': return t('Web page import');
    case 'youtube_import': return t('YouTube import');
    case 'github_import': return t('GitHub import');
    case 'market_prices': return t('Live prices widget');
    case 'cloud_llm': return t('Online AI provider');
    case 'speech_model_download': return t('Speech model download');
    case 'ocr_language_pack': return t('OCR language download');
    case 'update_check': return t('Update check');
    case 'update_download': return t('Update download');
    case 'ollama_install': return t('Ollama installer download');
    case 'engine_download': return t('Engine download');
    case 'engine_build': return t('Engine build (packages)');
    case 'ui': return t('Request of the app window');
    case 'unattributed': return t('Not through the network layer');
    default: return key;
  }
}

function outcomeLabel(o) {
  if (o === 'blocked') return t('Blocked (offline)');
  if (o === 'error') return t('Failed');
  return t('Sent');
}

function bytes(n) {
  if (n === null || n === undefined) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function PrivacyPanel({ token }) {
  const [offline, setOfflineState] = useState(null);
  const [error, setError] = useState('');
  const [data, setData] = useState({ entries: [], localRequests: 0 });
  const [filter, setFilter] = useState('all');
  const [live, setLive] = useState(true);

  const load = useCallback(async () => setData(await readNetworkLog(token)), [token]);

  useEffect(() => {
    readOffline(token).then((s) => setOfflineState(s.offline));
    return onOfflineChange(setOfflineState);
  }, [token]);

  useEffect(() => {
    load();
    if (!live) return undefined;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [load, live]);

  const toggle = async () => {
    setError('');
    try {
      setOfflineState(await setOffline(token, !offline));
    } catch (e) {
      if (e.code === 'not_allowed') setError(t('Only the administrator of this StarkLLM, or the account that turned "Fully offline" on, can turn it off.'));
      else if (e.code === 'engine_unreachable') setError(t('The engine on this PC could not be reached, so its switch was not changed. Try again when StarkLLM has started.'));
      else setError(t('The switch could not be changed: {error}', { error: e.message }));
      // the switch shows what really is set, not what was asked for
      readOffline(token).then((s) => setOfflineState(s.offline)).catch(() => {});
    }
    load();
  };

  const rows = useMemo(() => data.entries.filter((e) => (filter === 'blocked' ? e.outcome === 'blocked' : filter === 'left' ? e.outcome !== 'blocked' : true)), [data, filter]);
  const left = data.entries.filter((e) => e.outcome !== 'blocked').length;
  const blocked = data.entries.length - left;

  const exportAs = (kind) => {
    const stamp = new Date().toISOString().slice(0, 10);
    if (kind === 'csv') download(`starkllm-network-log-${stamp}.csv`, toCsv(data.entries), 'text/csv;charset=utf-8');
    else download(`starkllm-network-log-${stamp}.json`, JSON.stringify(data.entries, null, 2), 'application/json');
  };
  const clear = async () => {
    if (!window.confirm(t('Delete the list of connections? This does not change anything else.'))) return;
    await clearNetworkLog(token);
    load();
  };

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <ShieldCheck size={18} />
        <h2>{t('Privacy & network')}</h2>
      </div>
      <p className={styles.desc}>
        {t('StarkLLM makes no connection to the internet unless you turn on a feature that needs one. This page shows every connection the app and its engine make, and lets you cut them all.')}
      </p>

      <div className={`${styles.switchRow} ${offline ? styles.switchRowOn : ''}`}>
        <div>
          <strong>{t('Fully offline')}</strong>
          <span className={styles.muted}>
            {offline
              ? t('On: nothing leaves this PC. No update check, no model downloads, no web search, no online AI providers. Only the AI engine (Ollama) on this PC is used.')
              : t('Off: connections you turned on (updates, model downloads, web search, online providers) are allowed. They are listed below.')}
          </span>
        </div>
        {offline !== null && (
          <button type="button" role="switch" aria-checked={offline} aria-label={t('Fully offline')}
            className={`${styles.switch} ${offline ? styles.switchOn : ''}`} onClick={toggle}>
            <span />
          </button>
        )}
      </div>
      {error && <p className={styles.error}>{error}</p>}
      {offline && (
        <p className={styles.notice}><WifiOff size={14} /> {t('The first start needs internet once, to download the engine and an AI model. Do this before you turn the switch on.')}</p>
      )}

      <h3 className={styles.sub}>{t('Connections')}</h3>
      <p className={styles.summary}>
        {t('{left} left this PC, {blocked} were blocked. {local} requests stayed on this PC (they are only counted).', { left, blocked, local: data.localRequests })}
      </p>
      <div className={styles.toolbar}>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={t('Show')}>
          <option value="all">{t('All')}</option>
          <option value="left">{t('Left this PC')}</option>
          <option value="blocked">{t('Blocked')}</option>
        </select>
        <label className={styles.liveLabel}>
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> {t('Live')}
        </label>
        <button type="button" className={styles.btn} onClick={load}><RefreshCw size={14} /> {t('Refresh')}</button>
        <button type="button" className={styles.btn} onClick={() => exportAs('csv')}><Download size={14} /> CSV</button>
        <button type="button" className={styles.btn} onClick={() => exportAs('json')}><Download size={14} /> JSON</button>
        <button type="button" className={styles.btn} onClick={clear}><Trash2 size={14} /> {t('Clear list')}</button>
      </div>

      {rows.length === 0 ? (
        <p className={styles.empty}><ShieldCheck size={14} /> {t('No connection to the internet so far.')}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>{t('Time')}</th><th>{t('Destination')}</th><th>{t('What for')}</th><th>{t('Made by')}</th>
                <th>{t('Sent')}</th><th>{t('Received')}</th><th>{t('Result')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className={e.outcome === 'blocked' ? styles.rowBlocked : e.outcome === 'error' ? styles.rowError : ''}>
                  <td>{new Date(e.time).toLocaleString()}</td>
                  <td><code>{e.host}</code>{e.via ? <span className={styles.muted}> ({t('via the local Ollama')})</span> : null}</td>
                  <td title={e.purpose}>{featureLabel(e.feature)}</td>
                  <td>{e.source === 'app' ? t('App') : t('Engine')}</td>
                  <td>{bytes(e.bytes_out)}</td>
                  <td>{bytes(e.bytes_in)}</td>
                  <td title={e.error || ''}>{outcomeLabel(e.outcome)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className={styles.fine}>
        <AlertTriangle size={13} /> {t('The list shows the host and the size, never the address path, a search term or a file name. It is kept on this PC only. Connections of other programs (Ollama itself, Docker, your browser) are not StarkLLM\'s: see docs/verify-privacy.md to check them with Windows tools.')}
      </p>
    </div>
  );
}
