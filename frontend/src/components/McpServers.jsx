import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Play, Square, Trash2, AlertTriangle, CheckCircle } from 'lucide-react';
import styles from './Settings.module.css';
import { t } from '../i18n';
import { mcpBridge } from '../utils/mcpBridge';
import { connectionsBridge, serversOfKinds, sortTools } from '../utils/connections';
import { webTaskErrorText } from '../utils/webTaskText';

// the risk tier of a tool, in words (docs/connections.md)
export const tierText = (tier) => ({
  read: t('Reads'),
  write: t('Changes'),
  exec: t('Runs, sends or deletes'),
  blocked: t('Always off'),
}[tier] || t('Runs, sends or deletes'));

const TIER_COLORS = { read: 'var(--success, #10b981)', write: '#d4af37', exec: 'var(--danger, #ef4444)', blocked: 'var(--text-secondary)' };

export function TierBadge({ tier }) {
  return (
    <span style={{ fontSize: '0.72rem', border: `1px solid ${TIER_COLORS[tier] || TIER_COLORS.exec}`, color: TIER_COLORS[tier] || TIER_COLORS.exec, borderRadius: 4, padding: '0 4px', whiteSpace: 'nowrap' }}>
      {tierText(tier)}
    </span>
  );
}

const lockedText = (why) => ({
  'read-only': t('Off while the connection is read-only'),
  blocked: t('Always off for your safety'),
  changed: t('Changed since installation: please review'),
}[why] || '');

// Tool servers of the user (docs/roadmap-2026-12.md, R6): MCP servers on this PC that StarkLLM's model may use.
// Every tool is off until it is turned on here, and every call waits for a yes in the chat.
// kinds: "manual" (Settings › Local Tools) or "catalog" and "bundle" (Settings › Connections)
export default function McpServers({ kinds = ['manual'], allowAdd = true, refreshKey = 0, onChange }) {
  const bridge = mcpBridge();
  const [servers, setServers] = useState([]);
  const [form, setForm] = useState(null); // { name, transport, command, args, url, env }
  const [error, setError] = useState('');
  const load = useCallback(() => {
    if (!bridge) return;
    bridge.list().then((r) => setServers((r && r.servers) || [])).catch(() => {});
  }, [bridge]);
  useEffect(() => { load(); }, [load, refreshKey]);
  if (!bridge) return null;

  const after = (r) => {
    if (r && r.servers) setServers(r.servers);
    if (r && r.error) setError(r.error === 'tool-read-only' ? lockedText('read-only') : r.error === 'tool-blocked' ? lockedText('blocked') : r.error === 'tool-changed' ? lockedText('changed') : webTaskErrorText(r.message || r.error));
    else setError('');
    if (onChange) onChange(r);
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
  const remove = async (s) => {
    if (!window.confirm(t('Remove the tool server “{name}”?', { name: s.name }))) return;
    const conn = connectionsBridge();
    after(s.kind !== 'manual' && conn ? await conn.uninstall(s.id) : await bridge.remove(s.id));
  };
  const shown = serversOfKinds(servers, kinds);

  return (
    <div style={{ marginTop: '1.4rem' }}>
      {allowAdd && (
        <>
          <h3>{t('Tool servers (MCP) on this PC')}</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.88rem' }}>
            {t('Add MCP servers that run on this PC, for example a file, calendar or database server. StarkLLM starts a program you name, or connects to an address on this PC. Every tool is off until you turn it on, and every call waits for your yes in the chat.')}
          </p>
          <div className={styles.infoBox} style={{ margin: '0.6rem 0' }}>
            <AlertTriangle size={14} /> {t('A server is a program of its own: it runs with your rights and may use the internet. Add only servers you trust. Your secrets are not passed to it, only the variables you set here.')}
          </div>
        </>
      )}
      {shown.map((s) => (
        <div key={s.id} style={{ border: '1px solid var(--border-color)', borderRadius: 8, padding: '0.6rem 0.8rem', marginBottom: '0.6rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <div>
              <strong>{s.name}</strong>{' '}
              <span style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                {s.kind === 'manual' ? (s.transport === 'http' ? s.url : `${s.command} ${s.args.join(' ')}`) : s.transport === 'http' ? s.url : ''}
                {s.kind === 'manual' && s.envNames.length ? ` · ${t('variables: {names}', { names: s.envNames.join(', ') })}` : ''}
                {s.readOnly ? ` · ${t('read-only')}` : ''}
                {s.allowLan ? ` · ${t('home network')}` : ''}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {s.running
                ? <button type="button" className="btn-secondary" onClick={async () => after(await bridge.stop(s.id))}><Square size={14} /> {t('Stop')}</button>
                : <button type="button" className="btn-secondary" onClick={async () => after(await bridge.start(s.id))}><Play size={14} /> {t('Start')}</button>}
              <button type="button" className="btn-secondary" onClick={() => remove(s)}><Trash2 size={14} /> {t('Remove')}</button>
            </div>
          </div>
          {s.error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem', margin: '0.4rem 0 0' }}>{webTaskErrorText(s.error)}</p>}
          {s.changedTools.length > 0 && (
            <div className={styles.infoBox} style={{ margin: '0.5rem 0' }}>
              <AlertTriangle size={14} /> {t('Some tools of this connection changed since it was installed: {tools}. They are off until you have looked at them.', { tools: s.changedTools.join(', ') })}
              {s.running && (
                <div style={{ marginTop: 6 }}>
                  <button type="button" className="btn-secondary" onClick={async () => after(await bridge.acceptChanges(s.id))}><CheckCircle size={14} /> {t('I have reviewed the changes')}</button>
                </div>
              )}
            </div>
          )}
          {s.running && (s.tools.length === 0
            ? <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{t('This server offers no tools.')}</p>
            : (
              <ul style={{ listStyle: 'none', padding: 0, margin: '0.5rem 0 0' }}>
                {sortTools(s.tools).map((tool) => (
                  <li key={tool.name} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '2px 0', opacity: tool.locked ? 0.6 : 1 }}>
                    <input
                      type="checkbox"
                      id={`mcp-${s.id}-${tool.name}`}
                      checked={s.enabledTools.includes(tool.name) && !tool.locked}
                      disabled={Boolean(tool.locked)}
                      onChange={async (e) => after(await bridge.setTool(s.id, tool.name, e.target.checked))}
                    />
                    <label htmlFor={`mcp-${s.id}-${tool.name}`}>
                      <code>{tool.name}</code> <TierBadge tier={tool.tier} />{' '}
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.84rem' }}>{tool.description}</span>
                      {tool.locked && <span style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{lockedText(tool.locked)}</span>}
                    </label>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      ))}
      {error && <p style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{error}</p>}
      {allowAdd && (form ? (
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
      ))}
    </div>
  );
}
