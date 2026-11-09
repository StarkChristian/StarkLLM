import React, { useState, useEffect } from 'react';
import { X, Trash2, Plus, BrainCircuit } from 'lucide-react';
import styles from './MemoryManager.module.css';
import { useToast } from './Toast';
import { t } from '../i18n';

export default function MemoryManager({ workspace, token, onClose }) {
  const toast = useToast();
  const [memories, setMemories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newMemory, setNewMemory] = useState('');
  const [adding, setAdding] = useState(false);

  const fetchMemories = async () => {
    try {
      setLoading(true);
      const res = await fetch(`/api/v1/chat/memory/${workspace.id}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (!res.ok) throw new Error('Failed to fetch memories');
      const data = await res.json();
      setMemories(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMemories();
  }, [workspace.id, token]);

  const handleAddMemory = async (e) => {
    e.preventDefault();
    if (!newMemory.trim()) return;
    
    try {
      setAdding(true);
      const res = await fetch(`/api/v1/chat/memory/${workspace.id}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ content: newMemory.trim() })
      });
      if (!res.ok) throw new Error('Failed to add memory');
      
      const saved = await res.json();
      setMemories(prev => [...prev, saved]);
      setNewMemory('');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async (memoryId) => {
    try {
      const res = await fetch(`/api/v1/chat/memory/${workspace.id}/${memoryId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (!res.ok) throw new Error('Failed to delete memory');
      setMemories(prev => prev.filter(m => m.id !== memoryId));
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleClearAll = async () => {
    if (!window.confirm(t('Are you sure you want to clear ALL long-term memories for this workspace?'))) return;
    try {
      const res = await fetch(`/api/v1/chat/memory/${workspace.id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (!res.ok) throw new Error('Failed to clear memories');
      setMemories([]);
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <div className={styles.header}>
          <div className={styles.titleArea}>
            <BrainCircuit size={24} className={styles.icon} />
            <h2>{t('Long-Term Memory')}</h2>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <div className={styles.description}>
          {t('StarkLLM extracts and remembers important facts, preferences, and context from your conversations. You can also manually add things you want the assistant to remember here.')}
        </div>

        <form onSubmit={handleAddMemory} className={styles.addForm}>
          <input
            type="text"
            placeholder={t('E.g., I prefer Python over JavaScript...')}
            value={newMemory}
            onChange={(e) => setNewMemory(e.target.value)}
            disabled={adding}
            className={styles.input}
          />
          <button type="submit" disabled={!newMemory.trim() || adding} className={styles.addBtn}>
            <Plus size={16} />
            {t('Add')}
          </button>
        </form>

        <div className={styles.memoryList}>
          {loading ? (
            <div className={styles.emptyState}>{t('Loading memories...')}</div>
          ) : error ? (
            <div className={styles.errorState}>{error}</div>
          ) : memories.length === 0 ? (
            <div className={styles.emptyState}>{t('No memories saved yet. StarkLLM will remember important facts as you chat!')}</div>
          ) : (
            memories.map(mem => (
              <div key={mem.id} className={styles.memoryItem}>
                <div className={styles.memoryContent}>{mem.content}</div>
                <button 
                  className={styles.deleteBtn}
                  onClick={() => handleDelete(mem.id)}
                  title={t('Delete memory')}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))
          )}
        </div>

        {memories.length > 0 && (
          <div className={styles.footer}>
            <button className={styles.clearBtn} onClick={handleClearAll}>
              {t('Clear All Memories')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
