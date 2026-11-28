import React, { useCallback, useEffect, useState } from 'react';
import { Plug, Download, FolderOpen, AlertTriangle, CheckCircle, Loader, OctagonX, Package, ListChecks } from 'lucide-react';
import styles from './Settings.module.css';
import McpServers, { TierBadge } from './McpServers';
import { t, language } from '../i18n';
import { connectionsBridge, initialValues, missingRequired, formatBytes } from '../utils/connections';
import { mcpBridge } from '../utils/mcpBridge';

// Settings › Connections (docs/connections.md): popular apps through MCP with a few clicks. The desktop app installs
// the pinned package with its own runtimes, keeps secrets in Windows Credential Manager and starts the server with all
// its tools switched off.

const networkText = (n) => ({ offline: t('Works offline'), lan: t('Home network'), cloud: t('Cloud') }[n] || n);

const fieldErrorText = (code) => ({
  required: t('Required'),
  folder: t('Please choose a full folder path.'),
  number: t('Please enter a number from 1 to 65535.'),
  'not-local': t('Only addresses on this PC are allowed here.'),
  'lan-not-allowed': t('Only addresses on this PC are allowed here.'),
  'binds-all': t('Refused: this would listen on every network interface (0.0.0.0).'),
  'invalid-url': t('Please enter an address such as http://127.0.0.1:8188.'),
}[code] || t('This value is not valid.'));

function errorText(r) {
  const code = r && r.error;
  return ({
    offline: t('StarkLLM is fully offline: connections cannot be installed or started.'),
    'runtime-missing': t('The runtime for this connection is missing from this StarkLLM installation. Please install the current StarkLLM version.'),
    'needs-acknowledgement': t('Please confirm first that you understand the risk.'),
    'too-many': t('There are too many connections. Please remove one first.'),
    expired: t('The preview of the bundle expired. Please open the file again.'),
    'not-a-bundle': t('This is not a .mcpb file.'),
    'binds-all': t('Refused: this would listen on every network interface (0.0.0.0).'),
    invalid: t('Please check the marked fields.'),
  }[code]) || t('That did not work: {message}', { message: (r && (r.message || r.error)) || '?' });
}

function Field({ field, value, error, onChange, onPick }) {
  const id = `conn-field-${field.id}`;
  const common = { id, 'aria-invalid': error ? 'true' : undefined };
  let input;
  if (field.kind === 'checkbox') {
    input = (
      <label htmlFor={id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input {...common} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} /> {field.label}
      </label>
    );
  } else if (field.kind === 'folder') {
    input = (
      <div style={{ display: 'flex', gap: 6 }}>
        <input {...common} value={value} readOnly placeholder={t('No folder chosen')} style={{ flex: 1 }} />
        <button type="button" className="btn-secondary" onClick={onPick}><FolderOpen size={14} /> {t('Choose folder…')}</button>
      </div>
    );
  } else {
    input = (
      <input
        {...common}
        type={field.kind === 'secret' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
        autoComplete="off"
        value={value}
        placeholder={field.placeholder || ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <div className={styles.formGroup} style={{ marginBottom: '0.6rem' }}>
      {field.kind !== 'checkbox' && <label className={styles.label} htmlFor={id}>{field.label}{field.required ? ' *' : ''}</label>}
      {input}
      {field.hint && <span style={{ display: 'block', color: 'var(--text-secondary)', fontSize: '0.8rem', marginTop: 2 }}>{field.hint}</span>}
      {error && <span style={{ display: 'block', color: 'var(--danger)', fontSize: '0.82rem' }}>{fieldErrorText(error)}</span>}
    </div>
  );
}

function InstallForm({ entry, onDone, onCancel }) {
  const bridge = connectionsBridge();
  const [values, setValues] = useState(() => initialValues(entry.fields));
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  useEffect(() => bridge.onProgress((p) => { if (p && p.id === entry.id) setProgress(p); }), [bridge, entry.id]);

  const install = async () => {
    const missing = missingRequired(entry.fields, values);
    if (missing.length) { setErrors(Object.fromEntries(missing.map((id) => [id, 'required']))); return; }
    setBusy(true);
    setError('');
    setErrors({});
    const r = await bridge.install(entry.id, values, { acknowledged: ack, lang: language() });
    setBusy(false);
    setProgress(null);
    if (r && r.ok) { onDone(r); return; }
    if (r && r.errors) setErrors(Object.fromEntries(r.errors.map((e) => [e.field || '', e.error])));
    setError(errorText(r));
  };

  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '0.8rem', marginTop: '0.6rem' }}>
      {entry.steps.length > 0 && (
        <>
          <strong>{t('Before you start')}</strong>
          <ol style={{ margin: '0.3rem 0 0.8rem 1.2rem', padding: 0, fontSize: '0.88rem' }}>
            {entry.steps.map((s) => <li key={s}>{s}</li>)}
          </ol>
        </>
      )}
      {entry.readOnlyByDefault && <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('Read-only until you allow changes.')}</p>}
      {entry.network === 'lan' && (
        <div className={styles.infoBox} style={{ marginBottom: '0.6rem' }}>
          <AlertTriangle size={14} /> {t('This connection leaves this PC: it talks to a device on your home network. It is listed in Settings › Privacy & network.')}
        </div>
      )}
      {entry.fields.map((f) => (
        <Field
          key={f.id}
          field={f}
          value={values[f.id]}
          error={errors[f.id] || (f.kind === 'url' && errors.url)}
          onChange={(v) => setValues({ ...values, [f.id]: v })}
          onPick={async () => { const r = await bridge.pickFolder(); if (r && r.path) setValues({ ...values, [f.id]: r.path }); }}
        />
      ))}
      {entry.advanced && (
        <div className={styles.infoBox} style={{ margin: '0.6rem 0', borderColor: 'var(--danger)' }}>
          <AlertTriangle size={14} color="var(--danger)" /> {entry.advancedWarning}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> {t('I understand the risk and want to turn this on.')}
          </label>
        </div>
      )}
      {progress && <p style={{ fontSize: '0.85rem' }}><Loader size={13} className="spin" /> {t('Installing… step {step} of {total}', { step: progress.step, total: progress.total })}</p>}
      {busy && !progress && <p style={{ fontSize: '0.85rem' }}><Loader size={13} className="spin" /> {t('Installing…')}</p>}
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn-primary" disabled={busy || (entry.advanced && !ack)} onClick={install}><Download size={14} /> {t('Install and connect')}</button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>{t('Cancel')}</button>
      </div>
    </div>
  );
}

function BundlePreview({ preview, onDone, onCancel }) {
  const bridge = connectionsBridge();
  const [values, setValues] = useState(() => initialValues(preview.fields));
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const m = preview.manifest;
  const install = async () => {
    const missing = missingRequired(preview.fields, values);
    if (missing.length) { setErrors(Object.fromEntries(missing.map((id) => [id, 'required']))); return; }
    setBusy(true);
    const r = await bridge.installBundle(preview.token, values);
    setBusy(false);
    if (r && r.ok) { onDone(r); return; }
    if (r && r.errors) setErrors(Object.fromEntries(r.errors.map((e) => [e.field || '', e.error])));
    setError(errorText(r));
  };
  return (
    <div style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '0.8rem', marginTop: '0.6rem' }}>
      <strong>{m.name}</strong> <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{t('Version {version}', { version: m.version })}</span>
      {m.description && <p style={{ margin: '0.3rem 0', fontSize: '0.88rem' }}>{m.description}</p>}
      <ul style={{ fontSize: '0.84rem', color: 'var(--text-secondary)', margin: '0.3rem 0', paddingLeft: '1.1rem' }}>
        {m.author && <li>{t('From: {author}', { author: m.author })}</li>}
        {m.license && <li>{t('Licence: {license}', { license: m.license })}</li>}
        <li>{t('Runs with: {type}', { type: m.serverType })} · <code>{[m.command, ...m.args].join(' ').slice(0, 200)}</code></li>
        <li>{t('{count} files, {size} unpacked', { count: m.fileCount, size: formatBytes(m.unpackedSize) })}</li>
      </ul>
      {m.tools.length > 0 && (
        <>
          <strong style={{ fontSize: '0.88rem' }}>{t('Tools it offers')}</strong>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0.3rem 0 0.6rem', fontSize: '0.85rem' }}>
            {m.tools.map((tool) => <li key={tool.name}><code>{tool.name}</code> <TierBadge tier={tool.tier} /></li>)}
          </ul>
        </>
      )}
      <div className={styles.infoBox} style={{ marginBottom: '0.6rem' }}>
        <AlertTriangle size={14} /> {t('StarkLLM has not checked this bundle. Install it only if you trust where it comes from. Its tools start switched off, and every call asks you.')}
      </div>
      {preview.fields.map((f) => (
        <Field key={f.id} field={f} value={values[f.id]} error={errors[f.id]} onChange={(v) => setValues({ ...values, [f.id]: v })}
          onPick={async () => { const r = await bridge.pickFolder(); if (r && r.path) setValues({ ...values, [f.id]: r.path }); }} />
      ))}
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn-primary" disabled={busy} onClick={install}>{busy ? <Loader size={14} className="spin" /> : <Package size={14} />} {t('Install bundle')}</button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>{t('Cancel')}</button>
      </div>
    </div>
  );
}

function AuditLog() {
  const mcp = mcpBridge();
  const [rows, setRows] = useState(null);
  const toggle = async () => {
    if (rows) { setRows(null); return; }
    const r = await mcp.audit(100);
    setRows((r && r.entries) || []);
  };
  const outcome = (e) => (e.outcome === 'ok' ? t('{size} returned', { size: formatBytes(e.resultBytes) }) : e.outcome === 'refused' ? t('refused') : t('error'));
  return (
    <div style={{ marginTop: '0.8rem' }}>
      <button type="button" className="btn-secondary" onClick={toggle}><ListChecks size={14} /> {rows ? t('Hide the call log') : t('Show the call log')}</button>
      {rows && (rows.length === 0 ? <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('No calls yet.')}</p> : (
        <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
          <table style={{ fontSize: '0.8rem', borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>{[t('Time'), t('Connection'), t('Tool'), t('Risk'), t('Arguments'), t('Result')].map((h) => <th key={h} style={{ textAlign: 'start', padding: '2px 6px' }}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={`${e.time}-${i}`} style={{ borderTop: '1px solid var(--border-color)' }}>
                  <td style={{ padding: '2px 6px', whiteSpace: 'nowrap' }}>{new Date(e.time).toLocaleString(language())}</td>
                  <td style={{ padding: '2px 6px' }}>{e.server}</td>
                  <td style={{ padding: '2px 6px' }}><code>{e.tool}</code></td>
                  <td style={{ padding: '2px 6px' }}><TierBadge tier={e.tier} /></td>
                  <td style={{ padding: '2px 6px', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={e.args}><code>{e.args}</code></td>
                  <td style={{ padding: '2px 6px', whiteSpace: 'nowrap' }}>{outcome(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

export default function ConnectionsPanel() {
  const bridge = connectionsBridge();
  const mcp = mcpBridge();
  const [entries, setEntries] = useState([]);
  const [meta, setMeta] = useState({});
  const [open, setOpen] = useState('');
  const [notice, setNotice] = useState('');
  const [bundle, setBundle] = useState(null);
  const [bundleError, setBundleError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [dragging, setDragging] = useState(false);

  const load = useCallback(() => {
    if (!bridge) return;
    bridge.catalog(language()).then((r) => {
      if (r && r.entries) { setEntries(r.entries); setMeta({ secretStore: r.secretStore, offline: r.offline }); }
    }).catch(() => {});
  }, [bridge]);
  useEffect(() => { load(); }, [load, refresh]);
  // a .mcpb file opened with StarkLLM: shown here, nothing is installed before the user says yes
  useEffect(() => {
    if (!bridge) return undefined;
    const take = () => bridge.pendingBundle().then((r) => { if (r && r.ok) setBundle(r); else if (r && r.error) setBundleError(errorText(r)); }).catch(() => {});
    take();
    return bridge.onOpenBundle(take);
  }, [bridge]);
  if (!bridge || !mcp) return null;

  const installed = (r) => {
    setOpen('');
    setBundle(null);
    setNotice(r.startError ? t('Installed, but it did not start yet: {message}', { message: r.startError }) : t('Installed. All its tools are switched off: turn on the ones you want below.'));
    setRefresh((n) => n + 1);
  };
  const preview = (r) => {
    if (!r || r.canceled) return;
    if (r.ok) { setBundle(r); setBundleError(''); } else setBundleError(errorText(r));
  };
  const onDrop = async (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (!/\.(mcpb|dxt)$/i.test(file.name)) { setBundleError(errorText({ error: 'not-a-bundle' })); return; }
    preview(await bridge.previewDroppedBundle(file));
  };
  const stopAll = async () => {
    await mcp.stopAll();
    setNotice(t('All connections are stopped.'));
    setRefresh((n) => n + 1);
  };

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <Plug size={18} />
        <h2>{t('Connections')}</h2>
      </div>
      <p className={styles.panelDesc}>
        {t('Connect StarkLLM to apps on this PC with a few clicks. StarkLLM installs what is needed by itself. Every tool starts switched off, and every call asks you first.')}
      </p>
      {meta.offline && <div className={styles.infoBox}><AlertTriangle size={14} /> {errorText({ error: 'offline' })}</div>}
      {meta.secretStore === 'none' && <div className={styles.infoBox}><AlertTriangle size={14} /> {t('Secrets cannot be stored safely on this system, so connections with a password or key cannot be installed.')}</div>}
      {notice && <div className={styles.infoBox} style={{ marginTop: '0.6rem' }}><CheckCircle size={14} /> {notice}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '0.8rem', marginTop: '1rem' }}>
        {entries.map((e) => (
          <div key={e.id} style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '0.7rem 0.8rem', display: 'flex', flexDirection: 'column', gap: 4, gridColumn: open === e.id ? '1 / -1' : undefined }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'baseline' }}>
              <strong>{e.name}</strong>
              <span style={{ fontSize: '0.72rem', border: '1px solid var(--border-color)', borderRadius: 4, padding: '0 5px', whiteSpace: 'nowrap' }}>{networkText(e.network)}</span>
            </div>
            <span style={{ fontSize: '0.86rem' }}>{e.description}</span>
            <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              {t('Publisher: {name}', { name: e.publisher })} · {t('Licence: {license}', { license: e.license })}
              {e.lastUpdate ? ` · ${t('Last update: {date}', { date: e.lastUpdate })}` : ''}
            </span>
            {e.needsApp && <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{t('Needs: {app}', { app: e.needsApp })}</span>}
            <div style={{ marginTop: 'auto', paddingTop: 6, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {e.status !== 'ready' ? <span style={{ fontSize: '0.82rem' }}>{t('Coming later')}</span>
                : !e.runtimeReady ? <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{errorText({ error: 'runtime-missing' })}</span>
                  : open !== e.id && (
                    <button type="button" className={e.installed.length ? 'btn-secondary' : 'btn-primary'} disabled={meta.offline} onClick={() => { setOpen(e.id); setNotice(''); }}>
                      <Download size={14} /> {e.installed.length ? t('Add another') : t('Install')}
                    </button>
                  )}
              {e.installed.length > 0 && <span style={{ fontSize: '0.8rem', color: 'var(--success, #10b981)' }}><CheckCircle size={12} /> {t('Installed')}</span>}
            </div>
            {open === e.id && <InstallForm entry={e} onDone={installed} onCancel={() => setOpen('')} />}
          </div>
        ))}
      </div>

      <div className={styles.divider} />
      <h3 className={styles.h3}>{t('Install from a .mcpb file')}</h3>
      <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
        {t('A .mcpb file is a packaged connection. StarkLLM shows what it contains and asks before installing it.')}
      </p>
      <div
        onDragOver={(ev) => { ev.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        style={{ border: `2px dashed ${dragging ? '#d4af37' : 'var(--border-color)'}`, borderRadius: 8, padding: '0.8rem', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <button type="button" className="btn-secondary" disabled={meta.offline} onClick={async () => preview(await bridge.chooseBundle())}><Package size={14} /> {t('Choose a .mcpb file…')}</button>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{t('…or drop a .mcpb file here.')}</span>
      </div>
      {bundleError && <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{bundleError}</p>}
      {bundle && <BundlePreview key={bundle.token} preview={bundle} onDone={installed} onCancel={() => setBundle(null)} />}

      <div className={styles.divider} />
      <h3 className={styles.h3}>{t('Your connections')}</h3>
      <McpServers kinds={['catalog', 'bundle']} allowAdd={false} refreshKey={refresh} onChange={() => setRefresh((n) => n + 1)} />

      <div className={styles.divider} />
      <h3 className={styles.h3}>{t('Safety')}</h3>
      <p style={{ fontSize: '0.88rem', color: 'var(--text-secondary)' }}>
        {t('Tools that only read may be allowed for one session. Tools that change, run, send or delete ask every time and show all their arguments. Secrets stay in Windows Credential Manager.')}
      </p>
      <button type="button" className="btn-secondary" style={{ borderColor: 'var(--danger)', color: 'var(--danger)' }} onClick={stopAll}><OctagonX size={14} /> {t('Stop all connections')}</button>
      <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: 4 }}>{t('Ends every running connection at once and forgets the tools you allowed for this session.')}</span>
      <AuditLog />
    </div>
  );
}
