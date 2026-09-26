import React, { useState, useEffect, useRef } from 'react';
import styles from './ToolCallCard.module.css';
import { Terminal, Check, X, AlertTriangle, Play, Loader2, Send } from 'lucide-react';

const TOOL_DESCRIPTIONS = {
  list_workspace_files: "Lists documents and files uploaded to the current workspace (read-only).",
  search_local_kb: "Searches the local Knowledge Base index and returns passage locators (read-only).",
  fetch_cited_chunk: "Fetches the exact text chunk for a cited document locator from local Chroma store."
};

export default function ToolCallCard({
  rawCallText,
  parsedCall,
  isBrokenJson,
  workspaceId,
  token,
  onToolExecuted,
  onSendToolResult
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

  const toolName = parsedCall?.name || '';
  const toolDesc = TOOL_DESCRIPTIONS[toolName] || "Local read-only tool.";

  // Execution Gate: register pending tool call server-side on mount
  useEffect(() => {
    if (isBrokenJson || !parsedCall || !parsedCall.name || pendingRegisteredRef.current) {
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
        <span>⚠️ Malformed Tool Call JSON from model</span>
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
      setJsonError("Invalid JSON syntax: " + err.message);
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

  const handleConfirmRun = async () => {
    let argsObj = {};
    try {
      argsObj = JSON.parse(editedArgs);
    } catch (err) {
      setJsonError("Cannot run: JSON is invalid.");
      return;
    }

    if (!callId) {
      setExecError("Execution Gate Error: No authorized server-side pending call ID.");
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
      setExecError(err.message || 'Execution error');
      setStatus('error');
    }
  };

  const handleSendToChat = () => {
    if (onSendToolResult && execResult) {
      const formatted = `[Tool Result: ${toolName}]\n\`\`\`json\n${JSON.stringify(execResult, null, 2)}\n\`\`\``;
      onSendToolResult(formatted);
    }
  };

  return (
    <div className={styles.toolCard}>
      <div className={styles.toolHeader}>
        <div className={styles.toolTitleWrap}>
          <Terminal size={16} color="#d4af37" />
          <span className={styles.toolBadge}>Local Tool Call</span>
          <span className={styles.toolName}>{toolName}</span>
        </div>

        {status === 'cancelled' && (
          <span className={`${styles.statusChip} ${styles.statusChipCancelled}`}>
            <X size={12} /> Cancelled
          </span>
        )}
        {status === 'executed' && (
          <span className={`${styles.statusChip} ${styles.statusChipSuccess}`}>
            <Check size={12} /> Executed
          </span>
        )}
        {status === 'error' && (
          <span className={`${styles.statusChip} ${styles.statusChipError}`}>
            <AlertTriangle size={12} /> Execution Error
          </span>
        )}
      </div>

      <div className={styles.toolDesc}>{toolDesc}</div>

      {status === 'pending' && (
        <>
          <div className={styles.argsLabel}>
            <span>Arguments (Editable):</span>
            <span className={styles.argsLabelNote}>
              {callId ? `Gated ID: ${callId.slice(0, 10)}...` : (gatePending ? 'Authorizing...' : '')}
            </span>
          </div>
          <textarea
            className={styles.argsTextarea}
            value={editedArgs}
            onChange={(e) => handleArgsChange(e.target.value)}
            rows={Math.min(8, editedArgs.split('\n').length + 1)}
            disabled={gatePending}
          />
          {jsonError && <div className={styles.argsError}>{jsonError}</div>}
          {execError && <div className={styles.argsError}>{execError}</div>}

          <div className={styles.btnRow}>
            <button className={styles.cancelBtn} onClick={handleCancel}>
              <X size={13} style={{ marginRight: '4px', verticalAlign: 'middle' }} /> Cancel
            </button>
            <button
              className={styles.confirmBtn}
              onClick={handleConfirmRun}
              disabled={Boolean(jsonError) || gatePending || !callId}
            >
              <Play size={13} /> Confirm &amp; Run
            </button>
          </div>
        </>
      )}

      {status === 'running' && (
        <div className={`${styles.statusChip} ${styles.statusChipSuccess}`} style={{ color: '#d4af37' }}>
          <Loader2 size={14} className="spin" /> Executing {toolName} locally...
        </div>
      )}

      {status === 'executed' && execResult && (
        <div>
          <div className={styles.argsLabel} style={{ color: '#10b981', marginTop: '0.4rem' }}>
            Tool Result:
          </div>
          <div className={styles.resultBox}>
            {typeof execResult === 'object' ? JSON.stringify(execResult, null, 2) : String(execResult)}
          </div>
          {onSendToolResult && (
            <div className={styles.btnRow} style={{ marginTop: '0.6rem' }}>
              <button className={styles.confirmBtn} onClick={handleSendToChat}>
                <Send size={13} /> Send Result to Assistant
              </button>
            </div>
          )}
        </div>
      )}

      {status === 'error' && execError && (
        <div className={styles.argsError} style={{ marginTop: '0.5rem' }}>
          <strong>Error:</strong> {execError}
        </div>
      )}
    </div>
  );
}
