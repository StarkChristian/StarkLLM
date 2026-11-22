import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Play, Square, Trash2, AlertTriangle } from 'lucide-react';
import styles from './Settings.module.css';
import { t } from '../i18n';
import { mcpBridge } from '../utils/mcpBridge';

// Tool servers of the user (docs/roadmap-2026-12.md, R6): MCP servers on this PC that StarkLLM's model may use.
// Every tool is off until it is turned on here, and every call waits for a yes in the chat.
export default function McpServers() {
  const bridge = mcpBridge();
  const [servers, setServers] = useState([]);
  const [form, setForm] = useState(null); // { name, transport, command, args, url, env }
  const [error, setError] = useState('');
  const load = useCallback(() => {
    if (!bridge) return;
    bridge.list().then((r) => setServers((r && r.servers) || [])).catch(() => {});
  }, [bridge]);
  useEffect(() => { load(); }, [load]);
  if (!bridge) return null;

  const after = (r) => {
    if (r && r.servers) setServers(r.servers);
    if (r && r.error) setError(r.message || r.error);
    else setError('');
  };
  const add = async () => {
    const env = {};
    for (const line of String(form.env || '').split('\n')) {
      const k = line.indexOf('=');
      if (k > 0) env[line.slice(0, k).trim()] = line.slice(k + 1).trim();
    }
    const r = await bridge.add({ ...form, env });
    if (r && r.error === 'invalid') { setError(t('Check the server: a name, and a program to start or an address on this PC (http://127.0.0.1:…).')); return; }
    after(r);
    if (r && r.ok) setForm(null);
  };

  return (
    <div style={{ marginTop: '1.4rem' }}>
      <h3>{t('Tool servers (MCP) on this PC')}</h3>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem' }}>
        {t('Add MCP servers that run on this PC, for example a file, calendar or database server. StarkLLM starts a program you name, or connects to an address on this PC. Every tool is off until you turn it on, and every call waits for your yes in the chat.')}
      </p>
      <div className={styles.infoBox} style={{ margin: '0.6rem 0' }}>
        <AlertTriangle size={14} /> {t('A server is a program of its own: it runs with your rights and may use the internet. Add only servers you trust. Your secrets are not passed to it, only the variables you set here.')}
      </div>
      {servers.map((s) => (
        <div key={s.id} style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '0.6rem 0.8rem', marginBottom: '0.6rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <div>
              <strong>{s.name}</strong>{' '}
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                {s.transport === 'http' ? s.url : `${s.command} ${s.args.join(' ')}`}
                {s.envNames.length ? ` · ${t('variables: {names}', { names: s.envNames.join(', ') })}` : ''}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {s.running
                ? <button type="button" className="btn-secondary" onClick={async () => after(await bridge.stop(s.id))}><Square size={14} /> {t('Stop')}</button>
                : <button type="button" className="btn-secondary" onClick={async () => after(await bridge.start(s.id))}><Play size={14} /> {t('Start')}</button>}
              <button type="button" className="btn-secondary" onClick={async () => { if (window.confirm(t('Remove the tool server “{name}”?', { name: s.name }))) after(await bridge.remove(s.id)); }}><Trash2 size={14} /> {t('Remove')}</button>
            </div>
          </div>
          {s.error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: '0.4rem 0 0' }}>{s.error}</p>}
          {s.running && (s.tools.length === 0
            ? <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{t('This server offers no tools.')}</p>
            : (
              <ul style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0 0' }}>
                {s.tools.map((tool) => (
                  <li key={tool.name} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '2px 0' }}>
                    <input
                      type="checkbox"
                      id={`mcp-${s.id}-${tool.name}`}
                      checked={s.enabledTools.includes(tool.name)}
                      onChange={async (e) => after(await bridge.setTool(s.id, tool.name, e.target.checked))}
                    />
                    <label htmlFor={`mcp-${s.id}-${tool.name}`}>
                      <code>{tool.name}</code> <span style={{ color: 'var(--text-secondary)', fontSize: '0.84rem' }}>{tool.description}</span>
                    </label>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      ))}
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>}
      {form ? (
        <div style={{ display: 'grid', gap: '0.5rem', maxWidth: 560 }}>
          <input placeholder={t('Name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select value={form.transport} onChange={(e) => setForm({ ...form, transport: e.target.value })} aria-label={t('Kind of server')}>
            <option value="stdio">{t('A program StarkLLM starts')}</option>
            <option value="http">{t('A server that already runs on this PC (address)')}</option>
          </select>
          {form.transport === 'http' ? (
            <input placeholder="http://127.0.0.1:8000/mcp" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          ) : (
            <>
              <input placeholder={t('Program: a name such as npx, or the full path of the program')} value={form.command} onChange={(e) => setForm({ ...form, command: e.target.value })} />
              <input placeholder={t('Arguments, separated by spaces')} value={form.args} onChange={(e) => setForm({ ...form, args: e.target.value })} />
              <textarea rows={2} placeholder={t('Variables for this server, one NAME=value per line (optional)')} value={form.env} onChange={(e) => setForm({ ...form, env: e.target.value })} />
            </>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn-primary" onClick={add}>{t('Add and start')}</button>
            <button type="button" className="btn-secondary" onClick={() => { setForm(null); setError(''); }}>{t('Cancel')}</button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn-secondary" onClick={() => setForm({ name: '', transport: 'stdio', command: '', args: '', url: '', env: '' })}>
          <Plus size={14} /> {t('Add a tool server')}
        </button>
      )}
    </div>
  );
}
