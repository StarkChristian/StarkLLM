import React, { useState } from 'react';
import { X, BrainCircuit, Check, AlertTriangle } from 'lucide-react';
import styles from './MemoryManager.module.css';
import { t } from '../i18n';
import { useEscape } from '../utils/useEscape';
import { rejectionCode, rememberText, MEMORY_MAX_CHARS } from '../utils/memory';
import { rejectionText } from './MemoryManager';

// "Remember this" on a message: the user sees the text, may shorten or change it, and saves it with a click. An answer
// can repeat documents, web pages or mail, so the window says so; the engine refuses text that addresses an AI.
export default function RememberThis({ msg, workspaceId, chatId, token, onClose, onSaved }) {
  useEscape(onClose, true);
  const [text, setText] = useState(() => rememberText(msg.content));
  const [saving, setSaving] = useState(false);
  const [warning, setWarning] = useState(null);

  const save = async (e) => {
    e.preventDefault();
    if (!text.trim() || !workspaceId) return;
    setSaving(true);
    setWarning(null);
    try {
      const body = { content: text.trim() };
      if (chatId) {
        body.chat_id = Number(chatId);
        if (msg.id && Number.isInteger(Number(msg.id))) body.message_id = Number(msg.id);
        body.from_role = msg.role === 'assistant' ? 'assistant' : 'user';
      }
      const res = await fetch(`/api/v1/chat/memory/${workspaceId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        onSaved && onSaved(await res.json());
        onClose();
        return;
      }
      let data = null;
      try { data = await res.json(); } catch { /* no body */ }
      setWarning(rejectionText(rejectionCode(data)));
    } catch {
      setWarning(rejectionText(null));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.overlay}>
      <form className={`${styles.modal} ${styles.rememberModal}`} onSubmit={save} role="dialog" aria-modal="true" aria-label={t('Remember this')}>
        <div className={styles.header}>
          <div className={styles.titleArea}>
            <BrainCircuit size={22} className={styles.icon} />
            <h2>{t('Remember this')}</h2>
          </div>
          <button type="button" className={styles.closeBtn} onClick={onClose} title={t('Close')}>
            <X size={20} />
          </button>
        </div>
        <div className={styles.description}>
          {t('Check or shorten the text. StarkLLM will use it in later chats of this workspace, and you can change or delete it in the memory at any time.')}
        </div>
        {msg.role === 'assistant' && (
          <div className={styles.notice}>
            {t('This text comes from an answer. Answers can repeat documents, web pages or mail: keep only what you know is true.')}
          </div>
        )}
        <div className={styles.editArea}>
          <textarea
            className={styles.editInput}
            value={text}
            maxLength={MEMORY_MAX_CHARS}
            onChange={(e) => { setText(e.target.value); setWarning(null); }}
            aria-label={t('Remember this')}
            rows={5}
            autoFocus
          />
        </div>
        {warning && (
          <div className={styles.warning} role="alert">
            <AlertTriangle size={16} className={styles.warningIcon} />
            <span>{warning}</span>
          </div>
        )}
        <div className={styles.footer}>
          <button type="button" className={styles.secondaryBtn} onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className={styles.addBtn} disabled={saving || !text.trim()}>
            <Check size={14} /> {t('Save to memory')}
          </button>
        </div>
      </form>
    </div>
  );
}
