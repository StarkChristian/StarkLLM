import React, { useEffect, useState } from 'react';
import { FolderOpen, Plus, Trash2, Loader, RefreshCw, AlertTriangle, CheckCircle, RotateCcw } from 'lucide-react';
import styles from './Settings.module.css';
import own from './WatchedFolders.module.css';
import { useToast } from './Toast';
import { t, locale } from '../i18n';
import { parseImportError } from '../utils/watchFolders';

// Settings > Letters from a folder (2.7, option 8): folders the engine watches; new letters there go into the inbox
// of a workspace, like an upload. The watching runs in the engine (services/watch_service.py) while StarkLLM runs.
export default function WatchedFolders({ token }) {
  const toast = useToast();
  const headers = { Authorization: `Bearer ${token}` };
  const desktop = typeof window !== 'undefined' ? window.starkllmDesktop : null;
  const [folders, setFolders] = useState(null);
  const [history, setHistory] = useState([]);
  const [workspaces, setWorkspaces] = useState([]);
  const [path, setPath] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [importExisting, setImportExisting] = useState(false);
  const [moveImported, setMoveImported] = useState(false);
  const [busy, setBusy] = useState(null);

  const addError = (detail) => ({
    'Please enter the full path of a folder on this PC.': t('Please enter the full path of a folder on this PC.'),
    'This folder was not found on this PC.': t('This folder was not found on this PC.'),
    "This is StarkLLM's own data folder. Please choose another folder.": t("This is StarkLLM's own data folder. Please choose another folder."),
    'This folder is watched already.': t('This folder is watched already.'),
  }[detail] || detail);

  const errorText = (error) => {
    const e = parseImportError(error);
    if (!e) return '';
    const sentence = {
      too_large: t('The file is larger than 100 MB.'),
      unreadable: t('The file could not be read.'),
      import: t('The file could not be imported.'),
      move: t("Imported, but the file could not be moved into the 'imported' subfolder."),
    }[e.kind];
    return sentence ? `${sentence}${e.detail ? ` (${e.detail})` : ''}` : e.detail;
  };

  const statusText = (status) => ({
    imported: t('Imported'),
    duplicate: t('Already in the inbox'),
    failed: t('Could not be imported'),
  }[status] || status);

  const load = async () => {
    try {
      const [f, h, w] = await Promise.all([
        fetch('/api/v1/watch-folders/', { headers }),
        fetch('/api/v1/watch-folders/history', { headers }),
        fetch('/api/v1/workspaces/', { headers }),
      ]);
      if (!f.ok || !h.ok || !w.ok) throw new Error(String(f.status));
      const list = await w.json();
      setFolders(await f.json());
      setHistory(await h.json());
      setWorkspaces(list);
      setWorkspaceId((now) => now || (list[0] ? String(list[0].id) : ''));
    } catch (_) {
      setFolders((now) => now || []);
      toast.error(t('Could not load the watched folders.'));
    }
  };

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (key, url, options) => {
    setBusy(key);
    try {
      const res = await fetch(url, { ...options, headers: { ...headers, 'Content-Type': 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(addError(body.detail) || String(res.status));
      await load();
      return body;
    } catch (err) {
      toast.error(err.message);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const choose = async () => {
    try {
      const r = await desktop.chooseFolder();
      if (r && r.folder) setPath(r.folder);
    } catch (_) { /* the path can be typed instead */ }
  };

  const add = async () => {
    const body = await send('add', '/api/v1/watch-folders/', {
      method: 'POST',
      body: JSON.stringify({ folder_path: path, workspace_id: Number(workspaceId), import_existing: importExisting, move_imported: moveImported }),
    });
    if (!body) return;
    setPath('');
    toast.success(t('StarkLLM now watches {folder}.', { folder: body.folder_name }));
    if (body.network) toast.warning(t('This is a network folder. Letters are imported only while it can be reached.'), 10000);
  };

  const when = (iso) => {
    if (!iso) return '';
    try { return new Date(iso.endsWith('Z') ? iso : `${iso}Z`).toLocaleString(locale()); } catch (_) { return iso; }
  };

  if (folders === null) return <div className={styles.panel}><Loader size={18} className="spinner" /></div>;

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <FolderOpen size={24} className={styles.panelIcon} />
        <h2>{t('Letters from a folder')}</h2>
      </div>
      <p className={styles.panelDesc}>
        {t('StarkLLM imports new letters from the folders you choose here, for example the folder your scanner saves to. PDFs, pictures and Word files go into the inbox of the workspace you choose and are read like an upload. Your files are not changed or deleted.')}
      </p>
      <p className={styles.hint}>
        {t('Folders are watched while StarkLLM is running. Letters that arrive while it is closed are imported at the next start.')}
      </p>

      <div className={own.addBox}>
        <div className={styles.formGroup}>
          <label className={styles.label} htmlFor="watch-path">{t('Folder')}</label>
          <div className={own.pathRow}>
            <input id="watch-path" className={styles.input} value={path} onChange={(e) => setPath(e.target.value)}
              placeholder={t('Full path of the folder')} spellCheck={false} />
            {desktop?.chooseFolder && (
              <button className="btn-secondary" onClick={choose} disabled={busy !== null}>
                <FolderOpen size={16} /> {t('Choose folder…')}
              </button>
            )}
          </div>
        </div>
        <div className={styles.formGroup}>
          <label className={styles.label} htmlFor="watch-workspace">{t('Workspace')}</label>
          <select id="watch-workspace" className={styles.input} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
            {workspaces.map((w) => <option key={w.id} value={String(w.id)}>{w.name}</option>)}
          </select>
        </div>
        <label className={own.check}>
          <input type="checkbox" checked={importExisting} onChange={(e) => setImportExisting(e.target.checked)} />
          <span>{t('Also import the files that are in the folder now')}</span>
        </label>
        <label className={own.check}>
          <input type="checkbox" checked={moveImported} onChange={(e) => setMoveImported(e.target.checked)} />
          <span>{t("Move imported files into an 'imported' subfolder")}</span>
        </label>
        <p className={styles.hint}>{t('Off: your files stay exactly where they are.')}</p>
        <button className="btn-primary" onClick={add} disabled={busy !== null || !path.trim() || !workspaceId} style={{ width: 'fit-content' }}>
          {busy === 'add' ? <Loader size={14} className="spinner" /> : <Plus size={14} />} {t('Add folder')}
        </button>
      </div>

      <h3 className={styles.panelSubheader}>{t('Watched folders')}</h3>
      {folders.length === 0 ? (
        <p className={styles.hint}>{t('No folders are watched yet.')}</p>
      ) : (
        <ul className={own.list}>
          {folders.map((f) => (
            <li key={f.id} className={own.folder}>
              <div className={own.folderHead}>
                <div className={own.folderText}>
                  <strong>{f.folder_name}</strong>
                  <code className={own.path}>{f.folder_path}</code>
                  <span className={own.meta}>
                    {t('Letters go to: {workspace}', { workspace: f.workspace_name || '—' })} · {t('{count} imported', { count: f.imported_count })}
                  </span>
                </div>
                <button className={own.small} disabled={busy !== null} title={t('Stop watching')}
                  onClick={() => send(`del${f.id}`, `/api/v1/watch-folders/${f.id}`, { method: 'DELETE' })}>
                  <Trash2 size={14} /> {t('Stop watching')}
                </button>
              </div>
              {f.network && (
                <p className={own.warn}><AlertTriangle size={14} /> {t('This is a network folder. Letters are imported only while it can be reached.')}</p>
              )}
              {!f.available && (
                <p className={own.warn}><AlertTriangle size={14} /> {t('This folder cannot be found at the moment (moved, renamed, or on a drive that is not connected).')}</p>
              )}
              <label className={own.check}>
                <input type="checkbox" checked={f.move_imported} disabled={busy !== null}
                  onChange={(e) => send(`mv${f.id}`, `/api/v1/watch-folders/${f.id}`, { method: 'PATCH', body: JSON.stringify({ move_imported: e.target.checked }) })} />
                <span>{t("Move imported files into an 'imported' subfolder")}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className={own.historyHead}>
        <h3 className={styles.panelSubheader}>{t('Import history')}</h3>
        <button className={own.small} onClick={load} disabled={busy !== null}><RefreshCw size={14} /> {t('Refresh')}</button>
      </div>
      {history.length === 0 ? (
        <p className={styles.hint}>{t('Nothing imported yet.')}</p>
      ) : (
        <ul className={own.history}>
          {history.map((h) => (
            <li key={h.id} className={`${own.entry} ${h.status === 'failed' ? own.entryFailed : ''}`}>
              <span className={own.entryIcon}>{h.status === 'failed' ? <AlertTriangle size={14} /> : <CheckCircle size={14} />}</span>
              <div className={own.entryText}>
                <span><strong>{h.file_name}</strong> · {h.folder_name} · {statusText(h.status)}</span>
                <span className={own.meta}>
                  {when(h.created_at)}
                  {h.moved ? ` · ${t("Moved into the 'imported' subfolder")}` : ''}
                </span>
                {h.error && <span className={own.error}>{errorText(h.error)}</span>}
              </div>
              {h.status === 'failed' && (
                <button className={own.small} disabled={busy !== null}
                  onClick={() => send(`retry${h.id}`, `/api/v1/watch-folders/history/${h.id}/retry`, { method: 'POST' })}>
                  <RotateCcw size={14} /> {t('Try again')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
