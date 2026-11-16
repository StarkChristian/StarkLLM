import React, { useCallback, useEffect, useState } from 'react';
import { CalendarClock, CheckCircle, AlertTriangle, Loader, FolderOpen, Cloud } from 'lucide-react';
import styles from './Settings.module.css';
import { t } from '../i18n';

// Settings > Backup > Automatic backup. The desktop app makes the backups (it can reach the user's folders, the engine may
// not): one encrypted file per week into the chosen folder, tested twice, the oldest copies replaced.

const bridge = () => (typeof window !== 'undefined' && window.starkllmDesktop && window.starkllmDesktop.backup) || null;

const card = { background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 };
const note = (ok) => ({ padding: 12, borderRadius: 8, fontSize: '0.9rem', lineHeight: 1.5, whiteSpace: 'pre-wrap', display: 'flex', gap: 8,
  background: ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', color: ok ? '#22c55e' : '#ef4444',
  border: `1px solid ${ok ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}` });

// The desktop app sends English messages with a code; the German text is looked up here (so the UI check sees it).
const MESSAGES = {
  'no-folder': t('Choose a folder for the backups first.'),
  'folder-missing': t('The backup folder cannot be found. Is the USB drive or network folder connected?'),
  'folder-not-writable': t('StarkLLM cannot write into the backup folder. Choose another folder or check its permissions.'),
  'disk-full': t('There is not enough free space in the backup folder.'),
  'weak-passphrase': t('Use a passphrase of at least 12 characters.'),
  'no-passphrase': t('The backup passphrase is not available on this PC. Enter it again in Settings.'),
  'engine-not-ready': t('StarkLLM is not ready yet. The backup will be tried again later.'),
  busy: t('Documents are still being processed. The backup will be tried again later.'),
  locked: t('StarkLLM is locked. Unlock it in Settings > Protection; the backup will be tried again later.'),
  'copy-failed': t('The backup copy in the folder did not pass the restore test. The drive or folder may be faulty; older copies were kept.'),
  'no-key-store': t('This PC has no safe place for the passphrase (the Windows key store is not available).'),
  running: t('A backup is already running.'),
};
const say = (code, fallback) => MESSAGES[code] || fallback || t('The backup could not be made.');

export default function AutomaticBackupSettings() {
  const api = bridge();
  const [status, setStatus] = useState(null);
  const [folder, setFolder] = useState('');
  const [keep, setKeep] = useState(4);
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!api) return;
    const s = await api.status();
    if (s.error) return;
    setStatus(s);
    setFolder((f) => f || s.folder);
    setKeep(s.keep);
  }, [api]);

  useEffect(() => { refresh(); const timer = setInterval(refresh, 15000); return () => clearInterval(timer); }, [refresh]);

  if (!api) return null;

  const run = async (name, fn) => {
    setBusy(name); setError('');
    try { await fn(); await refresh(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const fail = (r) => { if (r && r.error) throw new Error(say(r.error, r.message)); return r; };

  const choose = () => run('folder', async () => { const r = fail(await api.chooseFolder()); if (r.folder) setFolder(r.folder); });
  const save = () => run('save', async () => {
    if (pass && pass !== pass2) throw new Error(t('The two passphrases are not the same.'));
    fail(await api.configure({ folder, keep, passphrase: pass || undefined }));
    setPass(''); setPass2('');
  });
  const now = () => run('now', async () => {
    const r = await api.runNow();
    if (r && r.ok === false) throw new Error(say(r.code, r.message));
  });
  const off = () => run('off', async () => { fail(await api.disable()); });

  const when = (ms) => (ms ? new Date(ms).toLocaleString() : '');

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <CalendarClock size={18} />
        <h2>{t('Automatic backup')}</h2>
      </div>
      <p className={styles.panelDesc}>
        {t('Once a week StarkLLM makes an encrypted backup into a folder you choose, tests it by restoring it into a temporary folder, and keeps the newest copies. Only its own backup files are ever replaced; nothing else in the folder is touched.')}
      </p>

      {error && <div style={note(false)}><AlertTriangle size={18} style={{ flexShrink: 0 }} />{error}</div>}

      {status && status.enabled && (
        <div style={card}>
          <strong>{t('Automatic backup is on')}</strong>
          {status.lastSuccess && (
            <div style={note(true)}>
              <CheckCircle size={18} style={{ flexShrink: 0 }} />
              <div>
                {t('Last backup: {time}, tested.', { time: when(status.lastSuccess) })}
                {status.lastReport && <div className={styles.hint}>{t('{documents} documents, {rows} database rows. File: {file}', { documents: status.lastReport.documents, rows: status.lastReport.rows, file: status.lastFile })}</div>}
              </div>
            </div>
          )}
          {status.lastError && (
            <div style={note(false)}><AlertTriangle size={18} style={{ flexShrink: 0 }} />
              <div>{say(status.lastError.code, status.lastError.message)}<div className={styles.hint}>{when(status.lastError.at)}</div></div>
            </div>
          )}
          {!status.lastSuccess && !status.lastError && <div className={styles.hint}>{t('The first backup is made soon after StarkLLM has started.')}</div>}
          {status.nextDue && <div className={styles.hint}>{t('Next backup: {time}', { time: when(status.nextDue) })}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-secondary" disabled={busy === 'now' || status.running} onClick={now}>
              {busy === 'now' || status.running ? <><Loader size={16} className="spinner" /> {t('Making and testing the backup…')}</> : t('Back up now')}
            </button>
            <button className="btn-secondary" disabled={busy === 'off'} onClick={off}>{t('Turn off')}</button>
          </div>
        </div>
      )}

      <div style={card}>
        <h4 style={{ margin: 0 }}>{status && status.enabled ? t('Change settings') : t('Turn on automatic backup')}</h4>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input readOnly value={folder} placeholder={t('Backup folder')} style={{ flex: 1 }} />
          <button className="btn-secondary" disabled={busy === 'folder'} onClick={choose}><FolderOpen size={16} /> {t('Choose folder…')}</button>
        </div>
        {status && status.cloud && (
          <div className={styles.hint}><Cloud size={14} /> {t('This folder is synced to {service}. That is fine: the backup file is encrypted, nobody can read it without your passphrase.', { service: status.cloud })}</div>
        )}
        <label style={{ fontSize: '0.9rem' }}>
          {t('Copies to keep')}{' '}
          <select value={keep} onChange={(e) => setKeep(Number(e.target.value))}>
            {[2, 4, 8, 12, 26, 52].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)}
               placeholder={status && status.hasPassphrase ? t('Passphrase (leave empty to keep the saved one)') : t('Passphrase (at least 12 characters)')} />
        <input type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} placeholder={t('Passphrase again')} />
        <div className={styles.hint}>
          {t('The passphrase is kept locked in the Windows key store of your account, so StarkLLM can make backups without asking. Write it down as well: after reinstalling Windows or on another PC you need it to open the backups.')}
        </div>
        {status && !status.keyStoreAvailable && <div style={note(false)}>{MESSAGES['no-key-store']}</div>}
        <button className="btn-primary" disabled={busy === 'save' || !folder || (!status?.hasPassphrase && pass.length < 12)} onClick={save} style={{ width: 'fit-content' }}>
          {busy === 'save' ? <Loader size={16} className="spinner" /> : null} {status && status.enabled ? t('Save') : t('Turn on automatic backup')}
        </button>
      </div>
    </div>
  );
}
