import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, Unlock, ShieldCheck, ShieldAlert, Loader, CheckCircle, Copy } from 'lucide-react';
import styles from './Settings.module.css';
import { t } from '../i18n';

// Settings > Protection (B6, docs/encryption-design.md). The key is made and kept by the desktop app (window.starkllmDesktop.protection);
// this page only asks for it, shows the recovery key once, and starts the migration in the engine.

const bridge = () => (typeof window !== 'undefined' && window.starkllmDesktop && window.starkllmDesktop.protection) || null;

const card = { background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 };
const note = (ok) => ({ padding: 12, borderRadius: 8, fontSize: '0.9rem', lineHeight: 1.5, whiteSpace: 'pre-wrap',
  background: ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', color: ok ? '#22c55e' : '#ef4444',
  border: `1px solid ${ok ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}` });

const STEP_TEXT = { database: t('Chats and settings'), files: t('Documents'), vectors: t('Search index'), start: t('Starting'), done: t('Done') };

// Texts the engine sends (English): the German is looked up here, so the UI check can see them.
const ENGINE_TEXT = {
  'Documents you add (the original files)': t('Documents you add (the original files)'),
  'Chat messages and the sources shown with them': t('Chat messages and the sources shown with them'),
  'The text of every indexed document and every memory (the search index)': t('The text of every indexed document and every memory (the search index)'),
  'Your profile text, custom instructions, prompt templates, workspace instructions': t('Your profile text, custom instructions, prompt templates, workspace instructions'),
  'Titles, senders and cases you set in the inbox': t('Titles, senders and cases you set in the inbox'),
  'Names of files in your Knowledge Base folder and of documents added before protection was turned on (the files carry the same names on disk)': t('Names of files in your Knowledge Base folder and of documents added before protection was turned on (the files carry the same names on disk)'),
  'Names and titles: workspaces, folders, chats, document file names, prompt templates': t('Names and titles: workspaces, folders, chats, document file names, prompt templates'),
  'The search index itself: its numbers, and the file names, pages and paths stored with every piece of text': t('The search index itself: its numbers, and the file names, pages and paths stored with every piece of text'),
  'The numbers the search index uses to find similar text, and the file names, pages and paths stored with each piece of text (they show topics, not words). Turn on the encrypted search index to lock them.': t('The numbers the search index uses to find similar text, and the file names, pages and paths stored with each piece of text (they show topics, not words). Turn on the encrypted search index to lock them.'),
  'How many pieces of text each search collection holds, and when the search index file last changed': t('How many pieces of text each search collection holds, and when the search index file last changed'),
  'Turn on protection first.': t('Turn on protection first.'),
  'Files in your Knowledge Base folder (they are your own files and stay where they are)': t('Files in your Knowledge Base folder (they are your own files and stay where they are)'),
  'Anything on your PC while StarkLLM is open and you are signed in to Windows': t('Anything on your PC while StarkLLM is open and you are signed in to Windows'),
  'Other programs running under your Windows account': t('Other programs running under your Windows account'),
  'The key is not available: unlock StarkLLM first.': t('The key is not available: unlock StarkLLM first.'),
  'Documents are still being processed. Try again when they are finished.': t('Documents are still being processed. Try again when they are finished.'),
  'Not enough free disk space to convert the largest document.': t('Not enough free disk space to convert the largest document.'),
};
const engineText = (text) => ENGINE_TEXT[text] || text;

export default function ProtectionSettings({ token }) {
  const [status, setStatus] = useState(null);       // engine: { enabled, locked, migration, ... }
  const [summary, setSummary] = useState(null);     // engine: what is protected for this user, with counts
  const [keyInfo, setKeyInfo] = useState(null);     // desktop app: { keyStoreAvailable, hasKey, passphrase }
  const [step, setStep] = useState('idle');         // idle | key | plan | running | turning-off
  const [recoveryKey, setRecoveryKey] = useState('');
  const [saved, setSaved] = useState(false);
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState('');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [passCurrent, setPassCurrent] = useState('');
  const timer = useRef(null);

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const call = useCallback(async (path, options = {}) => {
    const res = await fetch(`/api/v1/system/protection${path}`, { headers, ...options });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof body.detail === 'string' ? body.detail : t('Something went wrong.'));
    return body;
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(async () => {
    try {
      const [s, sum] = await Promise.all([call('/status'), call('/summary')]);
      setStatus(s);
      setSummary(sum);
      if (bridge()) setKeyInfo(await bridge().status());
      return s;
    } catch (e) {
      setError(e.message);
      return null;
    }
  }, [call]);

  useEffect(() => { refresh(); return () => clearInterval(timer.current); }, [refresh]);

  const watchMigration = () => {
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      const s = await refresh();
      const m = s && s.migration;
      if (m && m.state !== 'running' && !s.running) {
        clearInterval(timer.current);
        setBusy(false);
        setStep('idle');
        if (m.state === 'done' && m.direction === 'disable') {
          // protection is off for good: the safety copy (locked with the key) and the key are no longer needed
          try { await call('/finalize', { method: 'POST' }); if (bridge()) await bridge().forgetKey(); } catch (e) { /* the page shows the state */ }
          await refresh();
        }
        if (m.state === 'failed' || m.state === 'rolled_back') {
          setError(t('Protection could not be switched on. Nothing was lost: your documents and chats are as they were.') + (m.error ? `\n${m.error}` : ''));
        }
      }
    }, 1500);
  };

  const begin = async () => {
    setError('');
    if (!bridge()) { setError(t('Protection needs the StarkLLM desktop app, because only it can use the Windows key store.')); return; }
    if (!keyInfo || !keyInfo.keyStoreAvailable) { setError(t('This PC has no safe place for the key (the Windows key store is not available).')); return; }
    setBusy(true);
    try {
      if (keyInfo.hasKey) {
        const r = await bridge().unlock();
        if (r.error) throw new Error(r.message);
        setStep('plan');
        setPlan(await call('/plan', { method: 'POST', body: JSON.stringify({ direction: 'enable' }) }));
      } else {
        const r = await bridge().createKey();
        if (r.error) throw new Error(r.message);
        setRecoveryKey(r.recoveryKey);
        setSaved(false);
        setStep('key');
      }
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const afterKey = async () => {
    setBusy(true); setError('');
    try {
      setPlan(await call('/plan', { method: 'POST', body: JSON.stringify({ direction: 'enable' }) }));
      setStep('plan');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const migrate = async (direction) => {
    setBusy(true); setError('');
    try {
      await call('/migrate', { method: 'POST', body: JSON.stringify({ direction }) });
      setStep('running');
      watchMigration();
    } catch (e) { setError(e.message); setBusy(false); }
  };

  const turnOff = async () => {
    if (!window.confirm(t('Turn protection off? Your documents and chats are written back as plain files and text on this PC.'))) return;
    setStep('turning-off');
    await migrate('disable');
  };

  const unlock = async () => {
    setBusy(true); setError('');
    try {
      const r = recoveryInput ? await bridge().recover(recoveryInput) : await bridge().unlock();
      if (r.error) throw new Error(r.message);
      setRecoveryInput('');
      await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const setPassphrase = async () => {
    setBusy(true); setError('');
    try {
      if (pass !== pass2) throw new Error(t('The two passphrases are not the same.'));
      const r = await bridge().setPassphrase(pass);
      if (r.error) throw new Error(r.error === 'weak-passphrase' ? t('Use a passphrase of at least 12 characters.') : r.message);
      setPass(''); setPass2('');
      await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const removePassphrase = async () => {
    setBusy(true); setError('');
    try {
      const r = await bridge().removePassphrase(passCurrent);
      if (r.error) throw new Error(r.error === 'wrong-passphrase' ? t('The passphrase is not right. Try again.') : r.message);
      setPassCurrent('');
      await refresh();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const finalize = async () => { await call('/finalize', { method: 'POST' }); await refresh(); };

  // Move the search index into the encrypted index (mode "secure") or back to the normal one ("chroma").
  const moveIndex = async (mode) => {
    setBusy(true); setError('');
    try {
      const p = await call('/vectors/plan', { method: 'POST', body: JSON.stringify({ mode }) });
      if (!p.ok) throw new Error(p.problems.map(engineText).join(' '));
      const question = mode === 'secure'
        ? t('{collections} collections with {chunks} pieces of text will be moved into the locked search index. Nothing is deleted before the copy is complete. Continue?', p)
        : t('{collections} collections with {chunks} pieces of text will be moved back to the normal search index. Its numbers, file names and paths are then readable on disk again. Continue?', p);
      if (!window.confirm(question)) { setBusy(false); return; }
      await call('/vectors/migrate', { method: 'POST', body: JSON.stringify({ mode }) });
      setStep('running');
      watchMigration();
    } catch (e) { setError(e.message); setBusy(false); }
  };

  const m = (status && status.migration) || {};
  const on = status && status.enabled;
  const locked = status && status.locked;
  const working = step === 'running' || step === 'turning-off' || (status && status.running);

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <Lock size={18} />
        <h2>{t('Protection')}</h2>
      </div>

      <p className={styles.panelDesc}>
        {t('StarkLLM can lock your documents and the text it keeps about them. If someone copies the files from this PC (a lost laptop, a backup in a cloud folder, another person using this computer), they see only scrambled data. The key stays in the Windows key store of your account; you do not type a password.')}
      </p>

      {status && (
        <div style={{ ...card, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          {locked ? <ShieldAlert color="#ef4444" /> : on ? <ShieldCheck color="#22c55e" /> : <Unlock color="var(--text-muted)" />}
          <div>
            <strong>{locked ? t('Locked') : on ? t('Protection is on') : t('Protection is off')}</strong>
            <div className={styles.hint}>
              {locked ? t('The key has not been handed to StarkLLM yet. Protected documents cannot be opened until it is.')
                : on ? t('New documents and messages are stored locked.') : t('Your documents and chats are stored as ordinary files and text.')}
            </div>
          </div>
        </div>
      )}

      {error && <div style={note(false)}>{error}</div>}

      {locked && (
        <div style={card}>
          <h4 style={{ margin: 0 }}>{t('Unlock')}</h4>
          {keyInfo && keyInfo.passphrase ? (
            <>
              <input type="password" autoComplete="off" value={passCurrent} onChange={(e) => setPassCurrent(e.target.value)} placeholder={t('Passphrase')} />
              <button className="btn-primary" disabled={busy || !passCurrent} style={{ width: 'fit-content' }}
                      onClick={async () => { setBusy(true); setError(''); const r = await bridge().unlock(passCurrent); setPassCurrent(''); if (r.error) setError(r.error === 'wrong-passphrase' ? t('The passphrase is not right. Try again.') : r.message); await refresh(); setBusy(false); }}>
                {t('Unlock with passphrase')}
              </button>
            </>
          ) : (
            <button className="btn-primary" disabled={busy} onClick={unlock} style={{ width: 'fit-content' }}>{t('Unlock with the Windows key store')}</button>
          )}
          <div className={styles.hint}>{t('On a new PC or a new Windows account, enter your recovery key instead:')}</div>
          <input className={styles.input || ''} style={{ fontFamily: 'monospace' }} value={recoveryInput} placeholder="XXXXX-XXXXX-XXXXX-…"
                 onChange={(e) => setRecoveryInput(e.target.value)} />
          <button className="btn-secondary" disabled={busy || !recoveryInput} onClick={unlock} style={{ width: 'fit-content' }}>{t('Unlock with recovery key')}</button>
        </div>
      )}

      {summary && (
        <div style={card}>
          <h4 style={{ margin: 0 }}>{t('What this means for you')}</h4>
          <div className={styles.hint}>
            {t('{documents} of your {total} documents and {messages} of your {chats} chat messages are protected.', {
              documents: summary.documents.protected, total: summary.documents.total,
              messages: summary.messages.protected, chats: summary.messages.total })}
          </div>
          <strong style={{ fontSize: '0.85rem' }}>{t('Protected')}</strong>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            {summary.protects.map((p) => <li key={p}>{engineText(p)}</li>)}
          </ul>
          <strong style={{ fontSize: '0.85rem' }}>{t('Not protected')}</strong>
          <ul style={{ margin: 0, paddingLeft: 20, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            {summary.does_not_protect.map((p) => <li key={p}>{engineText(p)}</li>)}
          </ul>
        </div>
      )}

      {/* Turn on */}
      {status && !on && step === 'idle' && (
        <div style={card}>
          <h4 style={{ margin: 0 }}>{t('Turn on protection')}</h4>
          <div className={styles.hint}>
            {t('You get a recovery key once. Write it down and keep it away from this PC: it is the only way back in if you reinstall Windows or move to a new PC. Turning on takes a few minutes for a big archive; keep StarkLLM open.')}
          </div>
          <button className="btn-primary" disabled={busy} onClick={begin} style={{ width: 'fit-content' }}>
            {busy ? <Loader size={16} className="spinner" /> : <Lock size={16} />} {t('Turn on protection')}
          </button>
        </div>
      )}

      {step === 'key' && (
        <div style={card}>
          <h4 style={{ margin: 0 }}>{t('Your recovery key')}</h4>
          <div style={{ fontFamily: 'monospace', fontSize: '1.05rem', letterSpacing: 1, wordBreak: 'break-all', padding: 12, background: 'var(--bg-primary)', borderRadius: 8 }}>
            {recoveryKey}
          </div>
          <button className="btn-secondary" style={{ width: 'fit-content' }} onClick={() => navigator.clipboard && navigator.clipboard.writeText(recoveryKey)}>
            <Copy size={14} /> {t('Copy')}
          </button>
          <div style={note(false)}>
            {t('This key is shown only now and is not stored anywhere. Without it and without your Windows account, protected documents cannot be opened by anyone, including us.')}
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.9rem' }}>
            <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
            {t('I have written the recovery key down and keep it in a safe place.')}
          </label>
          <button className="btn-primary" disabled={!saved || busy} onClick={afterKey} style={{ width: 'fit-content' }}>{t('Continue')}</button>
        </div>
      )}

      {step === 'plan' && plan && (
        <div style={card}>
          <h4 style={{ margin: 0 }}>{t('Check before turning on')}</h4>
          <div className={styles.hint}>
            {t('{files} documents, {rows} stored texts and {chunks} search entries will be locked. Nothing is deleted.', {
              files: plan.files.todo,
              rows: Object.values(plan.database).reduce((n, v) => n + v.todo, 0),
              chunks: plan.vectors.todo })}
          </div>
          {plan.problems.map((p) => <div key={p} style={note(false)}>{engineText(p)}</div>)}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-primary" disabled={!plan.ok || busy} onClick={() => migrate('enable')}>{t('Lock everything now')}</button>
            <button className="btn-secondary" onClick={() => setStep('idle')}>{t('Cancel')}</button>
          </div>
        </div>
      )}

      {working && (
        <div style={card}>
          <Loader size={18} className="spinner" />
          <strong>{STEP_TEXT[m.step] || t('Working')}{m.done ? ` – ${m.done}` : ''}</strong>
          <div className={styles.hint}>{t('Keep StarkLLM open. If it stops, start it again: nothing is lost, and you can continue.')}</div>
        </div>
      )}

      {!working && on && m.state === 'done' && (
        <div style={note(true)}>
          <CheckCircle size={16} /> {t('Done. Everything that was there before is now locked.')}
        </div>
      )}

      {on && !working && m.safety_copy && (
        <div style={card}>
          <h4 style={{ margin: 0 }}>{t('Safety copy')}</h4>
          <div className={styles.hint}>
            {t('Before locking, StarkLLM kept a locked copy of its database so that everything could be undone. When you have checked that your chats and documents open, delete it.')}
          </div>
          <button className="btn-secondary" style={{ width: 'fit-content' }} onClick={finalize}>{t('Delete the safety copy')}</button>
        </div>
      )}

      {on && !working && !locked && bridge() && keyInfo && keyInfo.hasKey && (
        <div style={card}>
          <h4 style={{ margin: 0 }}>{t('Start-up passphrase')}</h4>
          {keyInfo.passphrase ? (
            <>
              <div className={styles.hint}>{t('StarkLLM asks for your passphrase every time it starts. The passphrase is never saved; if you forget it, your recovery key opens StarkLLM.')}</div>
              <input type="password" autoComplete="off" value={passCurrent} onChange={(e) => setPassCurrent(e.target.value)} placeholder={t('Current passphrase')} />
              <button className="btn-secondary" disabled={busy || !passCurrent} onClick={removePassphrase} style={{ width: 'fit-content' }}>{t('Stop asking for a passphrase')}</button>
            </>
          ) : (
            <>
              <div className={styles.hint}>{t('Optional: ask for a passphrase every time StarkLLM starts. Without it, anyone who can use your open Windows account can open your documents. With it, they also need the passphrase. It is never saved; the recovery key is the way back in if you forget it.')}</div>
              <input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={t('Passphrase (at least 12 characters)')} />
              <input type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} placeholder={t('Passphrase again')} />
              <button className="btn-secondary" disabled={busy || pass.length < 12} onClick={setPassphrase} style={{ width: 'fit-content' }}>{t('Ask for a passphrase at start')}</button>
            </>
          )}
        </div>
      )}

      {on && !working && !locked && (
        <div style={card}>
          <h4 style={{ margin: 0 }}>{t('Locked search index')}</h4>
          <div className={styles.hint}>
            {t('The search index keeps a list of numbers for every piece of text, plus its file name, page and path. Locking the search index hides these too, so nothing about your documents can be read from the disk. It needs more memory while StarkLLM runs (about 400 MB for every 100,000 pieces of text, which is several thousand letters) and is loaded when StarkLLM starts.')}
          </div>
          <strong style={{ fontSize: '0.9rem' }}>
            {status.vector_mode === 'secure' ? t('The search index is locked.') : t('The search index is not locked yet.')}
          </strong>
          {status.vector_mode === 'secure'
            ? <button className="btn-secondary" disabled={busy} style={{ width: 'fit-content' }} onClick={() => moveIndex('chroma')}>{t('Go back to the normal search index')}</button>
            : <button className="btn-primary" disabled={busy} style={{ width: 'fit-content' }} onClick={() => moveIndex('secure')}>{t('Lock the search index')}</button>}
        </div>
      )}

      <div style={card}>
        <h4 style={{ margin: 0 }}>{t('Windows drive encryption (recommended as well)')}</h4>
        <div className={styles.hint}>
          {t('Protection in StarkLLM locks your documents, chats and search index. Windows can also lock the whole drive (BitLocker, or "Device encryption" on many PCs). That covers what StarkLLM cannot: file names and titles, the programs themselves, and traces of files that were deleted earlier. Open Windows Settings > Privacy & security > Device encryption (or search for "BitLocker") and turn it on. Keep the recovery key it shows you in a safe place, away from this PC.')}
        </div>
      </div>

      {on && !working && !locked && (
        <div style={card}>
          <h4 style={{ margin: 0 }}>{t('Turn off protection')}</h4>
          <div className={styles.hint}>{t('Writes your documents and chats back as ordinary files and text.')}</div>
          <button className="btn-danger" style={{ width: 'fit-content' }} onClick={turnOff}>{t('Turn off protection')}</button>
        </div>
      )}
    </div>
  );
}
