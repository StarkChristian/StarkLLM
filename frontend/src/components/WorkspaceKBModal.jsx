import React, { useState, useEffect } from 'react';
import { X, Database, Loader, CheckSquare, Square } from 'lucide-react';
import styles from './KnowledgeBase.module.css';
import { t } from '../i18n';
import { useEscape } from '../utils/useEscape';

export default function WorkspaceKBModal({ isOpen, onClose, activeWorkspace, token, onWorkspaceUpdated }) {
  useEscape(onClose, isOpen);
  const [folders, setFolders] = useState([]);
  const [activeIds, setActiveIds] = useState(null); // null means all active, [] means none, [1,2] means specific
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (isOpen && activeWorkspace) {
      if (activeWorkspace.active_kb_dir_ids) {
        try {
          const ids = JSON.parse(activeWorkspace.active_kb_dir_ids);
          setActiveIds(Array.isArray(ids) ? ids : null);
        } catch (e) {
          setActiveIds(null);
        }
      } else {
        setActiveIds(null); // default all active
      }
      fetchFolders();
    }
  }, [isOpen, activeWorkspace]);

  const fetchFolders = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/knowledge-base/folders', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to load KB folders');
      const data = await res.json();
      setFolders(data || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = (folderId) => {
    if (activeIds === null) {
      setActiveIds(folders.filter(f => f.id !== folderId).map(f => f.id));
    } else {
      if (activeIds.includes(folderId)) {
        setActiveIds(activeIds.filter(id => id !== folderId));
      } else {
        setActiveIds([...activeIds, folderId]);
      }
    }
  };

  const handleSave = async () => {
    if (!activeWorkspace) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/workspaces/${activeWorkspace.id}/kb-folders`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          active_kb_dir_ids: activeIds === null ? folders.map(f => f.id) : activeIds
        })
      });
      if (!res.ok) throw new Error('Failed to save settings');
      const updatedWs = await res.json();
      onWorkspaceUpdated(updatedWs);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className={styles.modalOverlay}>
      <div className={styles.modalContent} style={{ maxWidth: '500px' }}>
        <button className={styles.closeBtn} onClick={onClose}><X size={20} /></button>
        <h3 className={styles.modalTitle} style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Database size={20} className={styles.iconAccent} />
          {t('Knowledge Base Settings')}
        </h3>
        
        <p className={styles.modalDesc} style={{ marginBottom: '20px' }}>
          {t('Workspace documents already belong to the workspace. Here you choose which folders of your personal Knowledge Base the workspace {name} uses.', { name: activeWorkspace?.name || '' })}
        </p>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.foldersList} style={{ maxHeight: '300px', overflowY: 'auto', marginBottom: '20px', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '8px' }}>
          {loading ? (
            <div style={{ padding: '20px', textAlign: 'center' }}><Loader size={20} className={styles.spin} /></div>
          ) : folders.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary)' }}>{t('No Knowledge Base folders registered yet.')}</div>
          ) : (
            folders.map(folder => {
              const isActive = activeIds === null || activeIds.includes(folder.id);
              return (
                <div 
                  key={folder.id} 
                  onClick={() => handleToggle(folder.id)}
                  style={{ 
                    display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', 
                    cursor: 'pointer', borderRadius: '6px', 
                    backgroundColor: isActive ? 'rgba(99, 102, 241, 0.1)' : 'transparent',
                    borderBottom: '1px solid var(--border-color)' 
                  }}
                >
                  {isActive ? <CheckSquare size={20} color="var(--accent-color)" /> : <Square size={20} color="var(--text-muted)" />}
                  <div>
                    <div style={{ fontSize: '1rem', fontWeight: 500, color: 'var(--text-primary)' }}>{folder.folder_name}</div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{folder.folder_path}</div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className={styles.actions} style={{ justifyContent: 'flex-end', marginTop: '20px' }}>
          <button className={styles.cancelBtn} onClick={onClose}>{t('Cancel')}</button>
          <button className={styles.saveBtn} onClick={handleSave} disabled={saving || loading}>
            {saving ? <Loader size={16} className={styles.spin} /> : t('Save Settings')}
          </button>
        </div>
      </div>
    </div>
  );
}
