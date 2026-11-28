import React, { useState, useEffect, useRef } from 'react';
import styles from './ToolCallCard.module.css';
import { Terminal, Check, X, AlertTriangle, Play, Loader2, Send } from 'lucide-react';
import { t } from '../i18n';
import { isExternalTool, externalToolLabel, mcpBridge } from '../utils/mcpBridge';
import { TierBadge } from './McpServers';

// read tools allowed for the session run by themselves once, in the newest answer only (not again on a re-render or
// when an older chat is opened)
const autoRan = new Set();
const autoKey = (chatId, raw) => `${chatId || ''}|${raw || ''}`;
function alreadyRan(key) {
  if (autoRan.has(key)) return true;
  try { return window.sessionStorage.getItem(`starkllm-autoran:${key}`) === '1'; } catch (e) { return false; }
}
function markRan(key) {
  autoRan.add(key);
  try { window.sessionStorage.setItem(`starkllm-autoran:${key}`, '1'); } catch (e) { /* memory only */ }
}

// in the user's language when the card is shown (not when the file is loaded)
const TOOL_DESCRIPTIONS = {
  list_workspace_files: () => t('Lists the documents of the current workspace (read only).'),
  search_local_kb: () => t('Searches your Knowledge Base and returns where the passages are (read only).'),
  fetch_cited_chunk: () => t('Fetches the exact text chunk for a cited document locator from local Chroma store.')
};

export default function ToolCallCard({
  rawCallText,
  parsedCall,
  isBrokenJson,
  workspaceId,
  token,
  onToolExecuted,
  onSendToolResult,
  chatId,
  isLatest
}) {
  const [editedArgs, setEditedArgs] = useState(() => {
    if (parsedCall && parsedCall.arguments) {
      try {
        return JSON.stringify(parsedCall.arguments, null, 2);
      } catch {
        return "{}";
      }
    }
    return "{}";
  });

  const [callId, setCallId] = useState(null);
  const [gatePending, setGatePending] = useState(true);
  const [jsonError, setJsonError] = useState(null);
  const [status, setStatus] = useState('pending'); // 'pending' | 'running' | 'executed' | 'cancelled' | 'error'
  const [execResult, setExecResult] = useState(null);
  const [execError, setExecError] = useState(null);
  const pendingRegisteredRef = useRef(false);
  // the rules of the desktop app for this call (docs/connections.md): risk tier, session allowance, second tick
  const [policy, setPolicy] = useState(null);
  const [checked, setChecked] = useState(false);
  const [allowForSession, setAllowForSession] = useState(false);
  const [autoRun, setAutoRun] = useState(false);

  const toolName = parsedCall?.name || '';
  // a tool of one of the user's MCP servers (R6): run by the desktop app after the yes below, not by the engine
  const external = isExternalTool(toolName);

  useEffect(() => {
    if (!external || isBrokenJson) return;
    const b = mcpBridge();
    if (!b || !b.check) return;
    b.check(toolName, chatId).then((r) => { if (r && r.ok) setPolicy(r); }).catch(() => {});
  }, [external, isBrokenJson, toolName, chatId]);

  const runRef = useRef(null);
  useEffect(() => {
    if (!policy || !policy.sessionAllowed || !isLatest || status !== 'pending') return;
    const key = autoKey(chatId, rawCallText);
    if (alreadyRan(key)) return;
    markRan(key);
    setAutoRun(true);
    if (runRef.current) runRef.current(true);
  }, [policy, isLatest]); // eslint-disable-line react-hooks/exhaustive-deps
  const toolDesc = external ? t('A tool of an MCP server you added ({tool}). It runs on this PC only after you press Confirm and run.', { tool: externalToolLabel(toolName) })
    : TOOL_DESCRIPTIONS[toolName] ? TOOL_DESCRIPTIONS[toolName]() : t('Local read-only tool.');

  // Execution Gate: register pending tool call server-side on mount
  useEffect(() => {
    if (isBrokenJson || !parsedCall || !parsedCall.name || pendingRegisteredRef.current || isExternalTool(parsedCall.name)) {
      setGatePending(false);
      return;
    }

    pendingRegisteredRef.current = true;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    fetch('/api/v1/mcp/create-pending', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        tool_name: parsedCall.name,
        arguments: parsedCall.arguments || {},
        workspace_id: workspaceId
      })
    })
      .then(async (res) => {
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || `Server rejected tool call (${res.status})`);
        }
        return res.json();
      })
      .then((data) => {
        if (data.call_id) {
          setCallId(data.call_id);
        }
        setGatePending(false);
      })
      .catch((err) => {
        console.warn('Execution gate registration error:', err.message);
        setExecError(err.message);
        setGatePending(false);
      });
  }, [parsedCall, isBrokenJson, workspaceId, token]);

  if (isBrokenJson) {
    return (
      <div className={`${styles.statusChip} ${styles.statusChipError}`}>
        <AlertTriangle size={14} />
        <span>{t('⚠️ Malformed Tool Call JSON from model')}</span>
      </div>
    );
  }

  if (!parsedCall || !parsedCall.name) {
    return null;
  }

  const handleArgsChange = (val) => {
    setEditedArgs(val);
    try {
      JSON.parse(val);
      setJsonError(null);
    } catch (err) {
      setJsonError(t('Invalid JSON syntax: ') + err.message);
    }
  };

  const handleCancel = async () => {
    setStatus('cancelled');
    if (callId) {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      try {
        await fetch('/api/v1/mcp/cancel', {
          method: 'POST',
          headers,
          body: JSON.stringify({ call_id: callId })
        });
      } catch (err) {
        console.warn('Failed to cancel pending call:', err);
      }
    }
  };

  // auto: a read tool allowed for this session, started by the card itself (no click)
  const handleConfirmRun = async (auto = false) => {
    let argsObj = {};
    try {
      argsObj = JSON.parse(editedArgs);
    } catch (err) {
      setJsonError(t('Cannot run: JSON is invalid.'));
      return;
    }

    if (external) {
      const bridge = mcpBridge();
      if (!bridge) { setExecError(t('Tools of MCP servers work in the StarkLLM desktop app only.')); setStatus('error'); return; }
      setStatus('running');
      setExecError(null);
      if (auto !== true && allowForSession && policy && policy.canAllowSession && bridge.allowSession) await bridge.allowSession(toolName);
      const r = await bridge.call(toolName, argsObj, { confirmed: auto !== true, checked, chatId });
      if (!r || !r.ok) {
        const why = r && r.error;
        setExecError(why === 'tool-off' ? t('This tool is turned off in Settings › Tools.') : why === 'not-running' ? t('The tool server is not running.') : why === 'offline' ? t('StarkLLM is fully offline: tool servers are off.')
          : why === 'needs-check' ? t('Please tick the box to confirm that you checked the arguments.') : why === 'tool-blocked' ? t('This tool is always off for your safety.')
            : why === 'needs-approval' ? t('This tool needs your confirmation.') : (r && r.message) || t('Execution error'));
        setStatus(why === 'needs-check' || why === 'needs-approval' ? 'pending' : 'error');
        return;
      }
      setExecResult(r.result);
      setStatus('executed');
      if (onToolExecuted) onToolExecuted(toolName, argsObj, r.result);
      return;
    }

    if (!callId) {
      setExecError(t('Execution Gate Error: No authorized server-side pending call ID.'));
      setStatus('error');
      return;
    }

    setStatus('running');
    setExecError(null);

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch('/api/v1/mcp/execute', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          call_id: callId,
          arguments: argsObj
        })
      });

      const data = await res.json();
      if (!res.ok || data.success === false) {
        throw new Error(data.error || data.detail || `Tool execution failed (${res.status})`);
      }

      setExecResult(data.result);
      setStatus('executed');
      if (onToolExecuted) {
        onToolExecuted(toolName, argsObj, data.result);
      }
    } catch (err) {
      setExecError(err.message || t('Execution error'));
      setStatus('error');
    }
  };

  runRef.current = handleConfirmRun;
  const tier = external && policy ? policy.tier : '';
  const blockedByCheck = Boolean(policy && policy.needsCheck && !checked);

  const handleSendToChat = () => {
    if (onSendToolResult && execResult) {
      // the result as the user's next message: a short line in the user's language, then the result
      const label = external ? externalToolLabel(toolName) : toolName;
      const body = typeof execResult === 'string' ? execResult : `\`\`\`json\n${JSON.stringify(execResult, null, 2)}\n\`\`\``;
      const formatted = `${t('Result of the tool {tool}:', { tool: label })}\n\n${body}`;
      onSendToolResult(formatted);
    }
  };

  return (
    <div className={styles.toolCard}>
      <div className={styles.toolHeader}>
        <div className={styles.toolTitleWrap}>
          <Terminal size={16} color="#d4af37" />
          <span className={styles.toolBadge}>{t('Local Tool Call')}</span>
          <span className={styles.toolName}>{toolName}</span>
          {tier && <TierBadge tier={tier} />}
        </div>

        {status === 'cancelled' && (
          <span className={`${styles.statusChip} ${styles.statusChipCancelled}`}>
            <X size={12} /> {t('Cancelled')}
          </span>
        )}
        {status === 'executed' && (
          <span className={`${styles.statusChip} ${styles.statusChipSuccess}`}>
            <Check size={12} /> {t('Executed')}
          </span>
        )}
        {status === 'error' && (
          <span className={`${styles.statusChip} ${styles.statusChipError}`}>
            <AlertTriangle size={12} /> {t('Execution Error')}
          </span>
        )}
      </div>

      <div className={styles.toolDesc}>{toolDesc}</div>

      {status === 'pending' && (
        <>
          <div className={styles.argsLabel}>
            <span>{t('Arguments (Editable):')}</span>
            <span className={styles.argsLabelNote}>
              {!external && !callId && gatePending ? t('Authorizing...') : ''}
            </span>
          </div>
          <textarea
            className={styles.argsTextarea}
            value={editedArgs}
            onChange={(e) => handleArgsChange(e.target.value)}
            rows={Math.min(8, editedArgs.split('\n').length + 1)}
            disabled={!external && gatePending}
          />
          {jsonError && <div className={styles.argsError}>{jsonError}</div>}
          {execError && <div className={styles.argsError}>{execError}</div>}
          {tier === 'exec' && (
            <div className={styles.argsError}>
              <AlertTriangle size={13} /> {t('This tool can run programs, send or delete. Please check every argument above before you run it.')}
            </div>
          )}
          {policy && policy.needsCheck && (
            <div className={styles.argsError}>
              {t('Content from {source} was read into this chat. It may contain hidden instructions. Run this only if you asked for exactly this.', { source: policy.taintedBy })}
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> {t('I have checked the arguments and want this to run.')}
              </label>
            </div>
          )}
          {policy && policy.canAllowSession && (
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.82rem', marginTop: 4 }}>
              <input type="checkbox" checked={allowForSession} onChange={(e) => setAllowForSession(e.target.checked)} /> {t('Allow this reading tool without asking until StarkLLM is closed')}
            </label>
          )}

          <div className={styles.btnRow}>
            <button className={styles.cancelBtn} onClick={handleCancel}>
              <X size={13} style={{ marginRight: '4px', verticalAlign: 'middle' }} /> {t('Cancel')}
            </button>
            <button
              className={styles.confirmBtn}
              onClick={() => handleConfirmRun(false)}
              disabled={Boolean(jsonError) || blockedByCheck || (!external && (gatePending || !callId))}
            >
              <Play size={13} /> {t('Confirm and run')}
            </button>
          </div>
        </>
      )}

      {status === 'running' && (
        <div className={`${styles.statusChip} ${styles.statusChipSuccess}`} style={{ color: '#d4af37' }}>
          <Loader2 size={14} className="spin" /> {t('Running {tool} on this PC…', { tool: external ? externalToolLabel(toolName) : toolName })}
        </div>
      )}

      {status === 'executed' && execResult && (
        <div>
          {autoRun && <div className={styles.argsLabelNote}>{t('Allowed for this session: it ran without asking.')}</div>}
          <div className={styles.argsLabel} style={{ color: '#10b981', marginTop: '0.4rem' }}>
            {t('Result of the tool:')}
          </div>
          <div className={styles.resultBox}>
            {typeof execResult === 'object' ? JSON.stringify(execResult, null, 2) : String(execResult)}
          </div>
          {onSendToolResult && (
            <div className={styles.btnRow} style={{ marginTop: '0.6rem' }}>
              <button className={styles.confirmBtn} onClick={handleSendToChat}>
                <Send size={13} /> {t('Send the result to the assistant')}
              </button>
            </div>
          )}
        </div>
      )}

      {status === 'error' && execError && (
        <div className={styles.argsError} style={{ marginTop: '0.5rem' }}>
          <strong>{t('Error:')}</strong> {execError}
        </div>
      )}
    </div>
  );
}
