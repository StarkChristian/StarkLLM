import React, { useState, useEffect, useCallback } from 'react';
import { X, Trash2, Plus, BrainCircuit, Pin, PinOff, Edit2, Check, Download, AlertTriangle, Lightbulb } from 'lucide-react';
import styles from './MemoryManager.module.css';
import { useToast } from './Toast';
import { t } from '../i18n';
import { useEscape } from '../utils/useEscape';
import { UI_LOCALE } from '../utils/locale';
import { downloadFile } from '../utils/download';
import { provenance, rejectionCode, sortMemories, MEMORY_MAX_CHARS } from '../utils/memory';

// Long-term memory (2.8): every entry with where it came from; the user edits, pins, deletes, exports. New memory only
// comes from the user: typed here, "Remember this" on a message, or a suggestion the user accepts.

/** The warning for a memory the engine refused (422), in the user's language. */
export function rejectionText(code) {
  if (code === 'addresses_ai') return t('This text speaks to an AI assistant (for example “ignore previous instructions” or a note for assistants). It is not saved as memory, because it could steer later answers.');
  if (code === 'too_long') return t('A memory can have at most {count} characters.', { count: MEMORY_MAX_CHARS });
  if (code === 'empty') return t('The memory is empty.');
  return t('The memory could not be saved.');
}

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(UI_LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
}

function provenanceLine(entry) {
  const { kind, chat } = provenance(entry);
  const date = when(entry.created_at);
  switch (kind) {
    case 'userMessage': return t('Saved by you from your message in “{chat}” · {date}', { chat, date });
    case 'answer': return t('Saved by you from an answer in “{chat}” · {date}', { chat, date });
    case 'chat': return t('Saved by you from the chat “{chat}” · {date}', { chat, date });
    case 'deletedChat': return t('Saved by you from a chat that was deleted · {date}', { date });
    case 'acceptedFrom': return t('Suggestion you accepted, from “{chat}” · {date}', { chat, date });
    case 'accepted': return t('Suggestion you accepted · {date}', { date });
    case 'suggestedFrom': return t('Suggested from your messages in “{chat}” · {date}', { chat, date });
    case 'suggested': return t('Suggested from your messages · {date}', { date });
    case 'legacy': return t('Saved by an older version of StarkLLM · {date}', { date });
    default: return t('Written by you · {date}', { date });
  }
}

export default function MemoryManager({ workspace, token, onClose }) {
  useEscape(onClose, true);
  const toast = useToast();
  const [memories, setMemories] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newMemory, setNewMemory] = useState('');
  const [adding, setAdding] = useState(false);
  const [warning, setWarning] = useState(null);
  const [editing, setEditing] = useState(null); // { id, text, suggestion }

  const base = `/api/v1/chat/memory/${workspace.id}`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const fetchAll = useCallback(async () => {
    try {
      setLoading(true);
      const auth = { headers: { Authorization: `Bearer ${token}` } };
      const [m, s] = await Promise.all([fetch(base, auth), fetch(`${base}/suggestions`, auth)]);
      if (!m.ok) throw new Error('memories');
      setMemories(sortMemories(await m.json()));
      setSuggestions(s.ok ? await s.json() : []);
      setError(null);
    } catch {
      setError(t('The memories could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, [base, token]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // a refused text shows its warning in the panel; anything else is a short message
  const send = async (url, method, body) => {
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (res.ok) return res.json();
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    const code = rejectionCode(data);
    if (code) {
      setWarning(rejectionText(code));
      return null;
    }
    throw new Error(String(res.status));
  };

  const handleAddMemory = async (e) => {
    e.preventDefault();
    if (!newMemory.trim()) return;
    setWarning(null);
    try {
      setAdding(true);
      const saved = await send(base, 'POST', { content: newMemory.trim() });
      if (!saved) return;
      setMemories((prev) => sortMemories([saved, ...prev]));
      setNewMemory('');
    } catch {
      toast.error(t('The memory could not be saved.'));
    } finally {
      setAdding(false);
    }
  };

  const saveEdit = async () => {
    if (!editing || !editing.text.trim()) return;
    setWarning(null);
    try {
      if (editing.suggestion) {
        const saved = await send(`${base}/${editing.id}/accept`, 'POST', { content: editing.text.trim() });
        if (!saved) return;
        setSuggestions((prev) => prev.filter((s) => s.id !== editing.id));
        setMemories((prev) => sortMemories([saved, ...prev]));
      } else {
        const saved = await send(`${base}/${editing.id}`, 'PATCH', { content: editing.text.trim() });
        if (!saved) return;
        setMemories((prev) => sortMemories(prev.map((m) => (m.id === saved.id ? { ...m, ...saved } : m))));
      }
      setEditing(null);
    } catch {
      toast.error(t('The memory could not be saved.'));
    }
  };

  const togglePin = async (mem) => {
    try {
      const saved = await send(`${base}/${mem.id}`, 'PATCH', { pinned: !mem.pinned });
      if (saved) setMemories((prev) => sortMemories(prev.map((m) => (m.id === saved.id ? { ...m, ...saved } : m))));
    } catch {
      toast.error(t('The memory could not be saved.'));
    }
  };

  const accept = async (sug) => {
    setWarning(null);
    try {
      const saved = await send(`${base}/${sug.id}/accept`, 'POST', {});
      if (!saved) return;
      setSuggestions((prev) => prev.filter((s) => s.id !== sug.id));
      setMemories((prev) => sortMemories([saved, ...prev]));
    } catch {
      toast.error(t('The memory could not be saved.'));
    }
  };

  const remove = async (id, isSuggestion) => {
    try {
      const res = await fetch(`${base}/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(String(res.status));
      if (isSuggestion) setSuggestions((prev) => prev.filter((s) => s.id !== id));
      else setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch {
      toast.error(t('The memory could not be deleted.'));
    }
  };

  const handleExport = async () => {
    const day = new Date().toISOString().slice(0, 10);
    const ok = await downloadFile(`${base}/export`, { Authorization: `Bearer ${token}` }, `starkllm-memory-${workspace.id}-${day}.json`)
      .catch(() => false);
    if (!ok) toast.error(t('The memory could not be exported.'));
  };

  const handleClearAll = async () => {
    if (!window.confirm(t('Do you really want to delete all memories and suggestions of this workspace? This cannot be undone.'))) return;
    try {
      const res = await fetch(base, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(String(res.status));
      setMemories([]);
      setSuggestions([]);
    } catch {
      toast.error(t('The memory could not be deleted.'));
    }
  };

  const editor = (
    <div className={styles.editArea}>
      <textarea
        className={styles.editInput}
        value={editing ? editing.text : ''}
        maxLength={MEMORY_MAX_CHARS}
        onChange={(e) => setEditing({ ...editing, text: e.target.value })}
        aria-label={t('Edit memory')}
        autoFocus
      />
      <div className={styles.editButtons}>
        <button type="button" className={styles.secondaryBtn} onClick={() => setEditing(null)}>{t('Cancel')}</button>
        <button type="button" className={styles.addBtn} onClick={saveEdit} disabled={!editing || !editing.text.trim()}>
          <Check size={14} /> {editing && editing.suggestion ? t('Accept') : t('Save')}
        </button>
      </div>
    </div>
  );

  return (
    <div className={styles.overlay}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-label={t('Long-Term Memory')}>
        <div className={styles.header}>
          <div className={styles.titleArea}>
            <BrainCircuit size={24} className={styles.icon} />
            <h2>{t('Long-Term Memory')}</h2>
          </div>
          <button className={styles.closeBtn} onClick={onClose} title={t('Close')}>
            <X size={20} />
          </button>
        </div>

        <div className={styles.description}>
          {t('StarkLLM keeps only what you choose: use “Remember this” on a message, add a fact here, or accept a suggestion. Text from documents, web pages, mail or tools never becomes memory on its own.')}
        </div>

        <form onSubmit={handleAddMemory} className={styles.addForm}>
          <input
            type="text"
            placeholder={t('E.g., I prefer Python over JavaScript...')}
            value={newMemory}
            maxLength={MEMORY_MAX_CHARS}
            onChange={(e) => { setNewMemory(e.target.value); setWarning(null); }}
            disabled={adding}
            className={styles.input}
          />
          <button type="submit" disabled={!newMemory.trim() || adding} className={styles.addBtn}>
            <Plus size={16} />
            {t('Add')}
          </button>
        </form>

        {warning && (
          <div className={styles.warning} role="alert">
            <AlertTriangle size={16} className={styles.warningIcon} />
            <span>{warning}</span>
          </div>
        )}

        <div className={styles.memoryList}>
          {loading ? (
            <div className={styles.emptyState}>{t('Loading memories...')}</div>
          ) : error ? (
            <div className={styles.errorState}>{error}</div>
          ) : (
            <>
              {suggestions.length > 0 && (
                <div className={styles.suggestions}>
                  <div className={styles.sectionTitle}>
                    <Lightbulb size={14} /> {t('Suggestions')}
                  </div>
                  <div className={styles.sectionHint}>
                    {t('StarkLLM suggests these facts from your own messages. They are not used until you accept them.')}
                  </div>
                  {suggestions.map((sug) => (
                    <div key={sug.id} className={`${styles.memoryItem} ${styles.suggestionItem}`}>
                      {editing && editing.id === sug.id ? editor : (
                        <>
                          <div className={styles.memoryBody}>
                            <div className={styles.memoryContent}>{sug.content}</div>
                            <div className={styles.provenance}>{provenanceLine(sug)}</div>
                          </div>
                          <div className={styles.itemActions}>
                            <button type="button" className={styles.acceptBtn} onClick={() => accept(sug)} title={t('Accept')}>
                              <Check size={14} /> {t('Accept')}
                            </button>
                            <button type="button" className={styles.iconBtn} onClick={() => setEditing({ id: sug.id, text: sug.content, suggestion: true })} title={t('Edit memory')}>
                              <Edit2 size={15} />
                            </button>
                            <button type="button" className={styles.deleteBtn} onClick={() => remove(sug.id, true)} title={t('Dismiss')}>
                              <X size={16} />
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {memories.length === 0 ? (
                <div className={styles.emptyState}>{t('No memories saved yet. Use “Remember this” on a message or add a fact here.')}</div>
              ) : (
                memories.map((mem) => (
                  <div key={mem.id} className={`${styles.memoryItem} ${mem.pinned ? styles.pinnedItem : ''}`}>
                    {editing && editing.id === mem.id ? editor : (
                      <>
                        <div className={styles.memoryBody}>
                          <div className={styles.memoryContent}>{mem.content}</div>
                          <div className={styles.provenance}>
                            {mem.pinned && <span className={styles.badge}>{t('Pinned')}</span>}
                            {mem.edited && <span className={styles.badge}>{t('Edited')}</span>}
                            {provenanceLine(mem)}
                          </div>
                        </div>
                        <div className={styles.itemActions}>
                          <button
                            type="button"
                            className={`${styles.iconBtn} ${mem.pinned ? styles.iconBtnActive : ''}`}
                            onClick={() => togglePin(mem)}
                            title={mem.pinned ? t('Unpin') : t('Pin: use this memory in every answer')}
                            aria-pressed={mem.pinned}
                          >
                            {mem.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                          </button>
                          <button type="button" className={styles.iconBtn} onClick={() => setEditing({ id: mem.id, text: mem.content, suggestion: false })} title={t('Edit memory')}>
                            <Edit2 size={15} />
                          </button>
                          <button type="button" className={styles.deleteBtn} onClick={() => remove(mem.id, false)} title={t('Delete memory')}>
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                ))
              )}
            </>
          )}
        </div>

        <div className={styles.footer}>
          <button type="button" className={styles.secondaryBtn} onClick={handleExport} disabled={loading || (!memories.length && !suggestions.length)}>
            <Download size={14} /> {t('Export memory (JSON)')}
          </button>
          <button type="button" className={styles.clearBtn} onClick={handleClearAll} disabled={loading || (!memories.length && !suggestions.length)}>
            {t('Delete all memory')}
          </button>
        </div>
      </div>
    </div>
  );
}
