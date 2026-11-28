import React, { useCallback, useEffect, useState } from 'react';
import { Mail, Loader, RefreshCw, Trash2, Pencil, AlertTriangle, CheckCircle, History, FolderOpen } from 'lucide-react';
import styles from './Settings.module.css';
import own from './MailImportSettings.module.css';
import { useToast } from './Toast';
import { t, locale } from '../i18n';
import { emptyForm, formFromAccount, accountBody, formProblem, portFor } from '../utils/mailImport';

// Settings > Letters from e-mail (docs/mail-import.md): attachments of new e-mails become documents of a workspace.
// The password is handed to the desktop app (Windows key store) and never sent to the engine by this page.
const bridge = () => (typeof window !== 'undefined' ? window.starkllmDesktop?.mail : null);

function errorText(code) {
  switch (code) {
    case 'offline': return t('Fully offline mode is on: no e-mail is checked.');
    case 'password_missing': return t('The password is missing. Enter it again.');
    case 'login_failed': return t('The mail server did not accept the user name or the password. For Gmail, use an app password.');
    case 'tls_required': return t('The mail server does not offer an encrypted connection. StarkLLM does not log in without encryption.');
    case 'tls_failed': return t('The encrypted connection failed: the certificate of the mail server is not trusted.');
    case 'folder_failed': return t('A folder could not be opened. Please check the folder names.');
    case 'unreachable': return t('The mail server could not be reached.');
    case 'timeout': return t('The mail server did not answer in time.');
    case 'locked': return t('Protection is locked. Please unlock StarkLLM first.');
    case 'workspace_missing': return t('The workspace of this account no longer exists.');
    case 'bad_host': return t('Enter the name of the mail server, for example imap.gmail.com.');
    case 'bad_port': return t('Enter a port between 1 and 65535.');
    case 'bad_interval': return t('Choose between 5 and 1440 minutes.');
    case 'incomplete': return t('Please enter the server, the user name, the password and the workspace.');
    case 'busy': return t('A check is already running.');
    case 'no-key-store': return t('This PC has no safe place for the password (the Windows key store is not available).');
    default: return t('The check failed.');
  }
}

function outcomeText(item) {
  switch (item.outcome) {
    case 'imported': return t('Imported');
    case 'duplicate': return t('Already there');
    case 'skipped': return item.detail === 'too_large' ? t('Skipped: too large') : t('Skipped: the file does not match its type');
    default: return errorText(item.detail);
  }
}

const when = (iso) => (iso ? new Date(iso).toLocaleString(locale()) : '');

export default function MailImportSettings({ token }) {
  const toast = useToast();
  const headers = { Authorization: `Bearer ${token}` };
  const desktop = bridge();
  const [storeOk, setStoreOk] = useState(true);
  const [data, setData] = useState(null);           // { accounts, offline }
  const [history, setHistory] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [form, setForm] = useState(null);           // the account being added or edited
  const [editing, setEditing] = useState(null);     // id, or null for a new one
  const [busy, setBusy] = useState(false);
  const [folders, setFolders] = useState(null);
  const [olderFor, setOlderFor] = useState(null);
  const [olderSince, setOlderSince] = useState(() => new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10));

  const load = useCallback(async () => {
    try {
      const [a, h] = await Promise.all([
        fetch('/api/v1/mail/accounts', { headers }),
        fetch('/api/v1/mail/history?limit=50', { headers }),
      ]);
      if (!a.ok || !h.ok) throw new Error(String(a.status));
      setData(await a.json());
      setHistory((await h.json()).items || []);
    } catch (_) {
      toast.error(t('Could not load the e-mail accounts.'));
    }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    (async () => {
      if (desktop) {
        try {
          setStoreOk(Boolean((await desktop.available())?.available));
          await desktop.deliver();      // the engine may have restarted and forgotten the passwords
        } catch (_) { /* shown by password_saved */ }
      }
      try {
        const res = await fetch('/api/v1/workspaces/', { headers });
        if (res.ok) setWorkspaces(await res.json());
      } catch (_) { /* the list stays empty */ }
      load();
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const running = data?.accounts?.some((a) => a.running);
  useEffect(() => {
    if (!running) return undefined;
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [running, load]);

  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }));

  const startAdd = () => {
    setEditing(null);
    setFolders(null);
    setForm(emptyForm(workspaces[0]?.id));
  };

  const startEdit = (acc) => {
    setEditing(acc.id);
    setFolders(null);
    setForm(formFromAccount(acc));
  };

  const save = async () => {
    const problem = formProblem(form, { needPassword: editing === null });
    if (problem) {
      toast.error(errorText(problem));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(editing === null ? '/api/v1/mail/accounts' : `/api/v1/mail/accounts/${editing}`, {
        method: editing === null ? 'POST' : 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(accountBody(form)),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'failed');
      if (form.password) {
        const stored = await desktop.setPassword(body.id, form.password);
        if (!stored?.ok) {
          if (editing === null) await fetch(`/api/v1/mail/accounts/${body.id}`, { method: 'DELETE', headers });
          throw new Error(stored?.error || 'failed');
        }
      }
      setForm(null);
      toast.success(t('Saved'));
      load();
    } catch (err) {
      toast.error(errorText(err.message));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (acc) => {
    if (!window.confirm(t('Remove this e-mail account? Documents that were already imported stay in the workspace.'))) return;
    await fetch(`/api/v1/mail/accounts/${acc.id}`, { method: 'DELETE', headers });
    try { await desktop?.forgetPassword(acc.id); } catch (_) { /* nothing stored */ }
    load();
  };

  const post = async (url, body) => {
    const res = await fetch(url, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) toast.error(errorText(answer.detail));
    else if (answer.started === false) toast.error(errorText('busy'));
    load();
  };

  const showFolders = async () => {
    setFolders('loading');
    const res = await fetch(`/api/v1/mail/accounts/${editing}/folders`, { headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      setFolders(null);
      toast.error(errorText(body.detail));
      return;
    }
    setFolders(body.folders || []);
  };

  const addFolder = (name) => {
    const list = form.folders.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!list.includes(name)) set('folders', [...list, name].join('\n'));
  };

  if (!data) return <div className={styles.panel}><Loader size={18} className="spinner" /></div>;
  const canAdd = Boolean(desktop) && storeOk;
  const wsName = (id) => workspaces.find((w) => w.id === id)?.name || `#${id}`;

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <Mail size={24} className={styles.panelIcon} />
        <h2>{t('Letters from e-mail')}</h2>
      </div>
      <p className={styles.panelDesc}>
        {t('StarkLLM can take letters that arrive as e-mail attachments (PDF, pictures, Word) and add them to a workspace, where they are read like an upload. Only the attachments are kept, with sender, subject and date; the text of the e-mail is never stored. StarkLLM only reads: it does not move, delete or send any e-mail.')}
      </p>
      {data.offline && <p className={own.warn}><AlertTriangle size={14} /> {errorText('offline')}</p>}
      {!desktop && <p className={own.warn}>{t('E-mail accounts can only be added in the StarkLLM desktop app: the password is kept in the Windows key store there.')}</p>}
      {desktop && !storeOk && <p className={own.warn}>{errorText('no-key-store')}</p>}

      {data.accounts.length === 0 && !form && <p className={styles.hint}>{t('No e-mail account yet.')}</p>}
      <ul className={own.list}>
        {data.accounts.map((acc) => (
          <li key={acc.id} className={own.card}>
            <div className={own.cardHead}>
              <div>
                <strong>{acc.username}</strong> <span className={own.muted}>{acc.host}:{acc.port}</span>
                <div className={own.muted}>
                  {t('Into: {workspace}', { workspace: wsName(acc.workspace_id) })} · {t('Checks every {count} minutes while StarkLLM runs.', { count: acc.interval_minutes })}
                </div>
                <div className={own.muted}>
                  {acc.last_check_at ? t('Last check: {time}', { time: when(acc.last_check_at) }) : t('Not checked yet')}
                  {' · '}
                  {acc.password_saved ? t('Password saved in the Windows key store') : t('The password is missing. Enter it again.')}
                </div>
                {acc.last_error && <div className={own.error}><AlertTriangle size={13} /> {errorText(acc.last_error)}</div>}
              </div>
              <div className={own.actions}>
                <button className={own.small} disabled={acc.running || data.offline || !acc.password_saved} onClick={() => post(`/api/v1/mail/accounts/${acc.id}/check`)}>
                  {acc.running ? <Loader size={14} className="spinner" /> : <RefreshCw size={14} />} {acc.running ? t('Checking…') : t('Check now')}
                </button>
                <button className={own.small} disabled={acc.running || data.offline || !acc.password_saved} onClick={() => setOlderFor(olderFor === acc.id ? null : acc.id)}>
                  <History size={14} /> {t('Import older messages')}
                </button>
                <button className={own.small} disabled={!canAdd} onClick={() => startEdit(acc)}><Pencil size={14} /> {t('Edit')}</button>
                <button className={own.small} onClick={() => remove(acc)}><Trash2 size={14} /> {t('Remove')}</button>
              </div>
            </div>
            {olderFor === acc.id && (
              <div className={own.older}>
                <label className={styles.label}>{t('Import the e-mails from this day until the account was added')}</label>
                <input type="date" className={styles.input} value={olderSince} max={(acc.created_at || '').slice(0, 10)} onChange={(e) => setOlderSince(e.target.value)} />
                <button className="btn-primary" onClick={() => { setOlderFor(null); post(`/api/v1/mail/accounts/${acc.id}/import-older`, { since: olderSince }); }}>{t('Import')}</button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {!form && canAdd && <button className="btn-primary" onClick={startAdd}>{t('Add an e-mail account')}</button>}

      {form && (
        <div className={own.form}>
          <div className={styles.panelSubheader}><Mail size={15} /> {editing === null ? t('Add an e-mail account') : t('Edit the e-mail account')}</div>
          <div className={own.grid}>
            <div className={styles.formGroup}>
              <label className={styles.label}>{t('Mail server (IMAP)')}</label>
              <input className={styles.input} value={form.host} placeholder="imap.example.org" onChange={(e) => set('host', e.target.value)} />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>{t('Encryption')}</label>
              <select className={styles.input} value={form.security} onChange={(e) => setForm((f) => ({ ...f, security: e.target.value, port: portFor(e.target.value, f.port) }))}>
                <option value="ssl">{t('IMAPS (TLS, port 993)')}</option>
                <option value="starttls">{t('STARTTLS (port 143)')}</option>
              </select>
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>{t('Port')}</label>
              <input className={styles.input} type="number" value={form.port} onChange={(e) => set('port', e.target.value)} />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>{t('User name')}</label>
              <input className={styles.input} value={form.username} autoComplete="off" onChange={(e) => set('username', e.target.value)} />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>{editing === null ? t('Password or app password') : t('New password (leave empty to keep it)')}</label>
              <input className={styles.input} type="password" value={form.password} autoComplete="new-password" onChange={(e) => set('password', e.target.value)} />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>{t('Workspace')}</label>
              <select className={styles.input} value={form.workspace_id} onChange={(e) => set('workspace_id', e.target.value)}>
                {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </div>
          </div>
          <p className={styles.hint}>{t('For Gmail, create an app password in your Google account (2-Step Verification must be on). Outlook.com and Microsoft 365 no longer accept passwords for IMAP and cannot be used yet.')}</p>
          <div className={styles.formGroup}>
            <label className={styles.label}>{t('Folders to watch')}</label>
            <textarea className={styles.input} rows={2} value={form.folders} onChange={(e) => set('folders', e.target.value)} />
            <p className={styles.hint}>{t('One per line. Most letters arrive in INBOX.')}</p>
            {editing !== null && (
              <button className={own.small} onClick={showFolders} disabled={folders === 'loading'}>
                {folders === 'loading' ? <Loader size={14} className="spinner" /> : <FolderOpen size={14} />} {t('Show folders')}
              </button>
            )}
            {Array.isArray(folders) && (
              <div className={own.chips}>
                {folders.map((f) => <button key={f} className={own.small} onClick={() => addFolder(f)}>{f}</button>)}
              </div>
            )}
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label}>{t('Only from these senders (optional)')}</label>
            <textarea className={styles.input} rows={2} value={form.senders} placeholder="@finanzamt.de" onChange={(e) => set('senders', e.target.value)} />
            <p className={styles.hint}>{t('One address or domain per line. A sender can be forged: this keeps the workspace tidy, it does not prove who sent a letter.')}</p>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label}>{t('Only with these words in the subject (optional)')}</label>
            <textarea className={styles.input} rows={2} value={form.subjects} onChange={(e) => set('subjects', e.target.value)} />
            <p className={styles.hint}>{t('One word or phrase per line. With both lists empty, every new e-mail with an attachment is imported.')}</p>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label}>{t('Check every (minutes)')}</label>
            <input className={styles.input} type="number" min={5} max={1440} value={form.interval_minutes} onChange={(e) => set('interval_minutes', e.target.value)} />
          </div>
          <label className={own.check}>
            <input type="checkbox" checked={form.mark_read} onChange={(e) => set('mark_read', e.target.checked)} />
            <span>{t('Mark imported e-mails as read')}</span>
          </label>
          <p className={styles.hint}>{t('Off by default: then StarkLLM changes nothing in your mailbox.')}</p>
          <div className={own.actions}>
            <button className="btn-primary" onClick={save} disabled={busy}>
              {busy ? <Loader size={14} className="spinner" /> : <CheckCircle size={14} />} {t('Save account')}
            </button>
            <button className={own.small} onClick={() => setForm(null)} disabled={busy}>{t('Cancel')}</button>
          </div>
        </div>
      )}

      <div className={styles.panelSubheader}><History size={15} /> {t('Import history')}</div>
      {history.length === 0 ? <p className={styles.hint}>{t('No imports yet.')}</p> : (
        <ul className={own.history}>
          {history.map((item) => (
            <li key={item.id} className={item.outcome === 'error' ? own.error : undefined}>
              <span className={own.muted}>{when(item.at)}</span>{' '}
              <strong>{outcomeText(item)}</strong>
              {item.filename && <> · {item.filename}</>}
              {(item.sender || item.subject) && <div className={own.muted}>{item.sender}{item.subject ? ` · ${item.subject}` : ''}</div>}
              {item.flagged && <div className={own.warn}><AlertTriangle size={13} /> {t('The sender or subject contains text written to an AI. StarkLLM ignores it; please treat this letter with care.')}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
