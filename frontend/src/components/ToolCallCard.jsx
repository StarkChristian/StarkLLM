import React, { useState } from 'react';
import styles from './ToolCallCard.module.css';
import { Terminal, Check, X, AlertTriangle, Play, Loader2, Send } from 'lucide-react';

const TOOL_DESCRIPTIONS = {
  list_workspace_files: "Lists documents uploaded into the current workspace.",
  search_local_kb: "Searches the local Knowledge Base index and returns passage locators.",
  fetch_cited_chunk: "Fetches the exact text chunk for a cited document locator."
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

  const [jsonError, setJsonError] = useState(null);
  const [status, setStatus] = useState('pending'); // 'pending' | 'running' | 'executed' | 'cancelled' | 'error'
  const [execResult, setExecResult] = useState(null);
  const [execError, setExecError] = useState(null);

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

  const toolName = parsedCall.name;
  const toolDesc = TOOL_DESCRIPTIONS[toolName] || "Local read-only Model Context Protocol tool.";

  const handleArgsChange = (val) => {
    setEditedArgs(val);
    try {
      JSON.parse(val);
      setJsonError(null);
    } catch (err) {
      setJsonError("Invalid JSON syntax: " + err.message);
    }
  };

  const handleCancel = () => {
    setStatus('cancelled');
  };

  const handleConfirmRun = async () => {
    let argsObj = {};
    try {
      argsObj = JSON.parse(editedArgs);
    } catch (err) {
      setJsonError("Cannot run: JSON is invalid.");
      return;
    }

    setStatus('running');
    setExecError(null);

    try {
      const headers = {
        'Content-Type': 'application/json'
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const res = await fetch('/api/v1/mcp/execute', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          tool_name: toolName,
          arguments: argsObj,
          workspace_id: workspaceId
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
          <span className={styles.toolBadge}>MCP Tool Call</span>
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
            <span className={styles.argsLabelNote}>Review or edit parameters before running</span>
          </div>
          <textarea
            className={styles.argsTextarea}
            value={editedArgs}
            onChange={(e) => handleArgsChange(e.target.value)}
            rows={Math.min(8, editedArgs.split('\n').length + 1)}
          />
          {jsonError && <div className={styles.argsError}>{jsonError}</div>}

          <div className={styles.btnRow}>
            <button className={styles.cancelBtn} onClick={handleCancel}>
              <X size={13} style={{ marginRight: '4px', verticalAlign: 'middle' }} /> Cancel
            </button>
            <button
              className={styles.confirmBtn}
              onClick={handleConfirmRun}
              disabled={Boolean(jsonError)}
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
        <div className={styles.argsError}>
          <strong>Error:</strong> {execError}
        </div>
      )}
    </div>
  );
}
