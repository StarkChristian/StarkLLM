import React, { useEffect, useState } from 'react';
import { ScanText, Download, Trash2, Loader, CheckCircle } from 'lucide-react';
import styles from './Settings.module.css';
import own from './OcrSettings.module.css';
import { useToast } from './Toast';
import { t } from '../i18n';

// The languages photos and scans are read in (Tesseract, on this PC). English and German come with the program; any
// other language is a download of a few MB, only when asked here. Changing languages is for the administrator.
export default function OcrSettings({ token }) {
  const toast = useToast();
  const headers = { Authorization: `Bearer ${token}` };
  const [info, setInfo] = useState(null);
  const [chosen, setChosen] = useState([]);
  const [busy, setBusy] = useState(null); // code being downloaded, or 'save'
  const [saved, setSaved] = useState(false);

  const take = (body) => {
    setInfo(body);
    setChosen(body.wanted);
  };

  const load = async () => {
    try {
      const res = await fetch('/api/v1/ocr/languages', { headers });
      if (!res.ok) throw new Error(String(res.status));
      take(await res.json());
    } catch (_) {
      toast.error(t('Could not load the reading languages.'));
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const call = async (url, options, key) => {
    setBusy(key);
    try {
      const res = await fetch(url, { ...options, headers: { ...headers, 'Content-Type': 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.detail || String(res.status));
      take(body);
      return true;
    } catch (err) {
      toast.error(err.message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const toggle = (code) => {
    setSaved(false);
    setChosen((now) => (now.includes(code) ? now.filter((c) => c !== code) : [...now, code].slice(0, info?.max_languages || 4)));
  };

  const save = async () => {
    if (await call('/api/v1/ocr/languages', { method: 'PUT', body: JSON.stringify({ languages: chosen }) }, 'save')) setSaved(true);
  };

  if (!info) return <div className={styles.panel}><Loader size={18} className="spinner" /></div>;

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <ScanText size={24} className={styles.panelIcon} />
        <h2>{t('Reading photos and scans')}</h2>
      </div>
      <p className={styles.panelDesc}>
        {t('StarkLLM reads photos of letters and scanned pages on this PC. English and German come with the program. For other languages, download the language first; this is the only time something is fetched from the internet, and nothing about you or your documents is sent.')}
      </p>
      {!info.available && (
        <p className={styles.panelDesc}>{t('Text recognition is not available on this installation. Pictures are described by the image model instead.')}</p>
      )}
      {info.missing.length > 0 && (
        <p className={own.warn}>{t('Not installed: {codes}. They are skipped.', { codes: info.missing.join(', ') })}</p>
      )}
      <ul className={own.list}>
        {info.catalog.map((lang) => (
          <li key={lang.code} className={own.row}>
            <label className={own.name}>
              <input
                type="checkbox"
                checked={chosen.includes(lang.code)}
                disabled={!lang.installed || busy !== null}
                onChange={() => toggle(lang.code)}
              />
              <span>{lang.name}</span>
              <code>{lang.code}</code>
            </label>
            {lang.installed ? (
              lang.downloaded ? (
                <button className={own.small} disabled={busy !== null} onClick={() => call(`/api/v1/ocr/languages/${lang.code}`, { method: 'DELETE' }, lang.code)} title={t('Remove')}>
                  <Trash2 size={14} /> {t('Remove')}
                </button>
              ) : (
                <span className={own.state}>{lang.bundled ? t('Comes with StarkLLM') : t('Installed')}</span>
              )
            ) : (
              <button className={own.small} disabled={busy !== null || !info.available} onClick={() => call(`/api/v1/ocr/languages/${lang.code}/install`, { method: 'POST' }, lang.code)}>
                {busy === lang.code ? <Loader size={14} className="spinner" /> : <Download size={14} />} {t('Download')}
              </button>
            )}
          </li>
        ))}
      </ul>
      <button className="btn-primary" onClick={save} disabled={busy !== null || chosen.length === 0 || !info.available}>
        {saved ? <><CheckCircle size={14} /> {t('Saved')}</> : t('Save languages')}
      </button>
      <p className={styles.panelDesc}>{t('Up to {count} languages at once: more make reading slower and less sure. A page is read again only when you add it again.', { count: info.max_languages })}</p>
    </div>
  );
}
