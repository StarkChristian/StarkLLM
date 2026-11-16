import React, { useEffect, useState, useCallback } from 'react';
import { Plug, KeyRound, Trash2, Copy, Check, ShieldCheck, AlertTriangle } from 'lucide-react';
import styles from './OtherAppsPanel.module.css';
import { t } from '../i18n';

// Settings > Other apps: programs on this PC (VS Code, Cursor, Claude Desktop, scripts) can use StarkLLM through the
// OpenAI-compatible API (/v1) or as an MCP server (/mcp). Off by default; every program needs a key made here.
function CopyBox({ label, value }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className={styles.copyBox}>
      {label && <span className={styles.copyLabel}>{label}</span>}
      <div className={styles.copyRow}>
        <pre className={styles.code}>{value}</pre>
        <button type="button" className={styles.iconBtn} onClick={copy} title={t('Copy')}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}

export default function OtherAppsPanel({ token }) {
  const [state, setState] = useState(null);
  const [name, setName] = useState('');
  const [newKey, setNewKey] = useState(null);
  const [error, setError] = useState('');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const origin = window.location.origin;
  const key = newKey ? newKey.key : 'YOUR-KEY';

  const load = useCallback(async () => {
    const res = await fetch('/api/v1/connections', { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setState(await res.json());
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const toggle = async () => {
    const res = await fetch('/api/v1/connections', { method: 'PUT', headers, body: JSON.stringify({ enabled: !state.enabled }) });
    if (res.ok) setState(await res.json());
  };

  const create = async (e) => {
    e.preventDefault();
    setError('');
    const res = await fetch('/api/v1/connections/keys', { method: 'POST', headers, body: JSON.stringify({ name }) });
    if (!res.ok) { setError(t('The key could not be created.')); return; }
    setNewKey(await res.json());
    setName('');
    load();
  };

  const remove = async (id) => {
    await fetch(`/api/v1/connections/keys/${id}`, { method: 'DELETE', headers });
    if (newKey && newKey.id === id) setNewKey(null);
    load();
  };

  const when = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : t('never'));

  const vscode = JSON.stringify({ servers: { starkllm: { type: 'http', url: `${origin}/mcp`, headers: { Authorization: `Bearer ${key}` } } } }, null, 2);
  const cursor = JSON.stringify({ mcpServers: { starkllm: { url: `${origin}/mcp`, headers: { Authorization: `Bearer ${key}` } } } }, null, 2);
  const claude = JSON.stringify({ mcpServers: { starkllm: { command: 'npx', args: ['-y', 'mcp-remote', `${origin}/mcp`, '--header', 'Authorization:${STARKLLM_AUTH}'], env: { STARKLLM_AUTH: `Bearer ${key}` } } } }, null, 2);
  const python = `from openai import OpenAI\n\nclient = OpenAI(base_url="${origin}/v1", api_key="${key}")\nanswer = client.chat.completions.create(\n    model="starkllm-rag",  # answers from your documents; "starkllm-default" = the model alone\n    messages=[{"role": "user", "content": "Welche Fristen habe ich diesen Monat?"}],\n)\nprint(answer.choices[0].message.content)`;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <Plug size={18} />
        <h2>{t('Other apps')}</h2>
      </div>
      <p className={styles.desc}>
        {t('Let programs on this PC use StarkLLM: editors like VS Code and Cursor, AI assistants that support MCP, or your own scripts. They can search your documents and ask questions about them. They cannot change or delete anything.')}
      </p>

      <div className={styles.notice}>
        <ShieldCheck size={16} />
        <div>
          <p>{t('Off by default. Only programs on this PC can connect, and each one needs a key you create here.')}</p>
          <p className={styles.noticeStrong}>
            <AlertTriangle size={13} /> {t('What a program reads leaves StarkLLM. A cloud assistant sends the passages it reads to its company. Connect only programs you trust.')}
          </p>
        </div>
      </div>

      {!state ? null : (
        <>
          <div className={styles.switchRow}>
            <div>
              <strong>{t('Allow other apps')}</strong>
              <span className={styles.muted}>{state.enabled ? t('On: programs with a key can connect.') : t('Off: no program can connect, even with a key.')}</span>
            </div>
            <button type="button" role="switch" aria-checked={state.enabled}
              className={`${styles.switch} ${state.enabled ? styles.switchOn : ''}`} onClick={toggle}>
              <span />
            </button>
          </div>

          <h3 className={styles.sub}><KeyRound size={15} /> {t('Keys')}</h3>
          <form className={styles.newKey} onSubmit={create}>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60}
              placeholder={t('Name, for example "VS Code"')} aria-label={t('Key name')} />
            <button type="submit" className="btn-primary">{t('Create key')}</button>
          </form>
          {error && <p className={styles.error}>{error}</p>}
          {newKey && (
            <div className={styles.created}>
              <p>{t('Copy the key now. StarkLLM keeps only a fingerprint of it and cannot show it again.')}</p>
              <CopyBox value={newKey.key} />
            </div>
          )}
          {state.keys.length > 0 && (
            <ul className={styles.keys}>
              {state.keys.map((k) => (
                <li key={k.id}>
                  <div>
                    <strong>{k.name}</strong> <code>{k.prefix}</code>
                    <span className={styles.muted}>{t('Last used: {when}', { when: when(k.last_used) })}</span>
                  </div>
                  <button type="button" className={styles.iconBtn} onClick={() => remove(k.id)} title={t('Delete key')}>
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <h3 className={styles.sub}>{t('Addresses')}</h3>
          <div className={styles.grid}>
            <CopyBox label={t('MCP server')} value={`${origin}/mcp`} />
            <CopyBox label={t('OpenAI-compatible API (base URL)')} value={`${origin}/v1`} />
          </div>
          <p className={styles.muted}>
            {t('MCP tools: search_documents, ask_documents, upcoming_dates, list_documents. API models: starkllm-rag (answers from your documents), starkllm-default (the model alone).')}
          </p>

          <h3 className={styles.sub}>{t('Set up a program')}</h3>
          {!newKey && <p className={styles.muted}>{t('Create a key first: it is then filled in below.')}</p>}
          <CopyBox label={t('VS Code: .vscode/mcp.json')} value={vscode} />
          <CopyBox label={t('Cursor: ~/.cursor/mcp.json')} value={cursor} />
          <CopyBox label={t('Claude Desktop: claude_desktop_config.json (needs Node.js)')} value={claude} />
          <CopyBox label={t('Python (openai package)')} value={python} />
        </>
      )}
    </div>
  );
}
