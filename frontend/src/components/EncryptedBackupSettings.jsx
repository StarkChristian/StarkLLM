import React, { useEffect, useRef, useState } from 'react';
import { Archive, CheckCircle, AlertTriangle, Loader, Download, Upload, ShieldCheck } from 'lucide-react';
import styles from './Settings.module.css';
import { t } from '../i18n';

// Settings > Backup (B7). One encrypted file, tested right after it is made: the engine restores it into a temporary folder
// and compares documents and database rows. The same test is available for any existing backup file.

const bridge = () => (typeof window !== 'undefined' && window.starkllmDesktop && window.starkllmDesktop.protection) || null;

const card = { background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 };
const note = (ok) => ({ padding: 12, borderRadius: 8, fontSize: '0.9rem', lineHeight: 1.5, whiteSpace: 'pre-wrap', display: 'flex', gap: 8,
  background: ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', color: ok ? '#22c55e' : '#ef4444',
  border: `1px solid ${ok ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}` });

// The engine sends a stable code with every refusal; the text shown is translated here.
const MESSAGES = {
  wrong_passphrase: t('Wrong passphrase, or the backup file was changed. Nothing was restored.'),
  weak_passphrase: t('Use a passphrase of at least 12 characters. Anyone who gets the backup file can try to guess it.'),
  not_a_backup: t('This is not a StarkLLM backup file.'),
  damaged: t('The backup file is damaged, incomplete or was changed. Nothing was restored.'),
  mismatch: t('The backup did not pass the restore test: what is inside does not match what was saved. Nothing was restored.'),
  newer_version: t('This backup was made by a newer version of StarkLLM. Update StarkLLM first.'),
  busy: t('Documents are still being processed. Make the backup when they are finished.'),
  locked: t('StarkLLM is locked. Unlock it in Settings > Protection first.'),
  locked_files: t('The data files are in use. Close StarkLLM completely and open it again to finish the restore.'),
  unreadable: t('The backup file cannot be opened.'),
};

async function request(token, path, options = {}) {
  const res = await fetch(`/api/v1/system/backup${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = body.detail;
    const message = d && d.code && MESSAGES[d.code] ? MESSAGES[d.code] : (typeof d === 'string' ? d : (d && d.message) || t('Something went wrong.'));
    throw new Error(message);
  }
  return body;
}

function Report({ report }) {
  return (
    <div style={note(true)}>
      <ShieldCheck size={18} style={{ flexShrink: 0 }} />
      <div>
        <strong>{t('Restore test passed.')}</strong>{' '}
        {t('The backup was restored into a temporary folder and compared with your data: {documents} documents, {rows} database rows in {tables} tables, {collections} search collections. Your real data was not touched.', {
          documents: report.documents, rows: report.rows, tables: report.tables, collections: report.collections })}
        {report.protected && <div>{t('Your documents stay locked inside the backup.')}</div>}
      </div>
    </div>
  );
}

export default function EncryptedBackupSettings({ token }) {
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [made, setMade] = useState(null);          // { id, filename, report }
  const [verifyReport, setVerifyReport] = useState(null);
  const [restoreInfo, setRestoreInfo] = useState(null);
  const [undo, setUndo] = useState(false);
  const verifyFile = useRef(null);
  const restoreFile = useRef(null);
  const [verifyPass, setVerifyPass] = useState('');
  const [restorePass, setRestorePass] = useState('');
  const [sure, setSure] = useState(false);

  useEffect(() => { request(token, '/status').then((s) => setUndo(s.undo_available)).catch(() => {}); }, [token, restoreInfo]);

  const run = async (name, fn) => {
    setBusy(name); setError('');
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  const create = () => run('create', async () => {
    if (pass !== pass2) throw new Error(t('The two passphrases are not the same.'));
    setMade(null);
    setMade(await request(token, '/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: pass }) }));
  });

  // Choose where to save (a folder, a USB drive, a NAS) when the browser can; else the normal download.
  const save = () => run('save', async () => {
    let handle = null;
    if (window.showSaveFilePicker) {
      try { handle = await window.showSaveFilePicker({ suggestedName: made.filename, types: [{ description: 'StarkLLM backup', accept: { 'application/octet-stream': ['.starkbackup'] } }] }); }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const res = await fetch(`/api/v1/system/backup/download/${made.id}?filename=${encodeURIComponent(made.filename)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(t('The backup is no longer here. Make a new one.'));
    const blob = await res.blob();
    if (handle) {
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = made.filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
    setMade(null); setPass(''); setPass2('');
  });

  const verify = () => run('verify', async () => {
    const file = verifyFile.current && verifyFile.current.files[0];
    if (!file) throw new Error(t('Choose a backup file first.'));
    setVerifyReport(null);
    const form = new FormData(); form.append('file', file); form.append('passphrase', verifyPass);
    setVerifyReport(await request(token, '/verify', { method: 'POST', body: form }));
  });

  const restore = () => run('restore', async () => {
    const file = restoreFile.current && restoreFile.current.files[0];
    if (!file) throw new Error(t('Choose a backup file first.'));
    if (!window.confirm(t('Restoring replaces ALL your current documents, chats and settings with the backup. Your current data is kept aside until you delete it. Continue?'))) return;
    const form = new FormData(); form.append('file', file); form.append('passphrase', restorePass);
    const r = await request(token, '/restore', { method: 'POST', body: form });
    let recovery = null;
    if (r.data_key && bridge()) {                               // the backup was locked: its key becomes this PC's key
      const stored = await bridge().storeKey(r.data_key);
      if (stored.error) throw new Error(stored.message);
      recovery = stored.recoveryKey;
      if (r.restored) await bridge().unlock();
    }
    setRestoreInfo({ ...r, recovery });
    if (r.restored && !recovery) setTimeout(() => window.location.reload(), 2500);
  });

  const discard = () => run('discard', async () => { await request(token, '/discard-undo', { method: 'POST' }); setUndo(false); });

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <Archive size={18} />
        <h2>{t('Encrypted backup')}</h2>
      </div>
      <p className={styles.panelDesc}>
        {t('One file with all your documents, chats and settings, locked with a passphrase you choose. Put it on a USB drive, a NAS or in a cloud folder: without the passphrase nobody can read it. StarkLLM tests every backup right after making it.')}
      </p>

      {error && <div style={note(false)}><AlertTriangle size={18} style={{ flexShrink: 0 }} />{error}</div>}

      <div style={card}>
        <h4 style={{ margin: 0 }}><Download size={16} /> {t('Make a backup')}</h4>
        <input type="password" autoComplete="new-password" placeholder={t('Passphrase (at least 12 characters)')} value={pass} onChange={(e) => setPass(e.target.value)} />
        <input type="password" autoComplete="new-password" placeholder={t('Passphrase again')} value={pass2} onChange={(e) => setPass2(e.target.value)} />
        <div className={styles.hint}>{t('Write the passphrase down. If you lose it, nobody can open the backup, including us.')}</div>
        <button className="btn-primary" disabled={busy === 'create' || pass.length < 12} onClick={create} style={{ width: 'fit-content' }}>
          {busy === 'create' ? <><Loader size={16} className="spinner" /> {t('Making and testing the backup…')}</> : t('Make backup')}
        </button>
        {made && (
          <>
            <Report report={made.report} />
            <button className="btn-primary" disabled={busy === 'save'} onClick={save} style={{ width: 'fit-content' }}>{t('Save the backup file…')}</button>
          </>
        )}
      </div>

      <div style={card}>
        <h4 style={{ margin: 0 }}><ShieldCheck size={16} /> {t('Test a backup file')}</h4>
        <div className={styles.hint}>{t('Unpacks the file into a temporary folder and compares it with what it says it contains. Your data is not changed.')}</div>
        <input type="file" ref={verifyFile} accept=".starkbackup" aria-label={t('Test a backup file')} />
        <input type="password" placeholder={t('Passphrase')} aria-label={t('Passphrase')} value={verifyPass} onChange={(e) => setVerifyPass(e.target.value)} />
        <button className="btn-secondary" disabled={busy === 'verify' || !verifyPass} onClick={verify} style={{ width: 'fit-content' }}>
          {busy === 'verify' ? <Loader size={16} className="spinner" /> : null} {t('Test the backup')}
        </button>
        {verifyReport && <Report report={verifyReport} />}
      </div>

      <div style={{ ...card, border: '1px solid rgba(239,68,68,0.25)', background: 'rgba(239,68,68,0.05)' }}>
        <h4 style={{ margin: 0, color: '#ef4444' }}><Upload size={16} /> {t('Restore from a backup')}</h4>
        <div className={styles.hint}>{t('The file is tested first. A file that is damaged, changed, or opened with the wrong passphrase is refused and nothing changes.')}</div>
        <input type="file" ref={restoreFile} accept=".starkbackup" aria-label={t('Restore from a backup')} />
        <input type="password" placeholder={t('Passphrase')} aria-label={t('Passphrase')} value={restorePass} onChange={(e) => setRestorePass(e.target.value)} />
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.9rem' }}>
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
          {t('I understand that this replaces my current data.')}
        </label>
        <button className="btn-danger" disabled={busy === 'restore' || !restorePass || !sure} onClick={restore} style={{ width: 'fit-content' }}>
          {busy === 'restore' ? <><Loader size={16} className="spinner" /> {t('Testing and restoring…')}</> : t('Restore')}
        </button>
        {restoreInfo && (
          <>
            <Report report={restoreInfo.report} />
            <div style={note(restoreInfo.restored)}>
              {restoreInfo.restored ? <CheckCircle size={18} style={{ flexShrink: 0 }} /> : <AlertTriangle size={18} style={{ flexShrink: 0 }} />}
              <div>{restoreInfo.restored ? t('Restored. Reload this page to see your data.') : t('Close StarkLLM completely and open it again to finish the restore.')}</div>
            </div>
            {restoreInfo.recovery && (
              <div style={note(false)}>
                <div>
                  <strong>{t('New recovery key for this PC')}</strong>
                  <div style={{ fontFamily: 'monospace', wordBreak: 'break-all', margin: '8px 0' }}>{restoreInfo.recovery}</div>
                  {t('Write it down now. It is shown only once.')}
                  <div><button className="btn-secondary" style={{ marginTop: 8 }} onClick={() => window.location.reload()}>{t('I wrote it down, reload')}</button></div>
                </div>
              </div>
            )}
          </>
        )}
        {undo && (
          <div className={styles.hint}>
            {t('The data from before the restore is kept aside on this PC. When you have checked the restored data, delete it.')}{' '}
            <button className="btn-secondary" disabled={busy === 'discard'} onClick={discard}>{t('Delete the old data')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
