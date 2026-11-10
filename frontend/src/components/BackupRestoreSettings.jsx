import React, { useState, useRef } from 'react';
import { Download, Upload, AlertTriangle, Loader, CheckCircle } from 'lucide-react';
import styles from './Settings.module.css'; // Reusing standard Settings styles

import { useToast } from './Toast';
import { t } from '../i18n';

export default function BackupRestoreSettings({ token }) {
  const toast = useToast();
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState(null); // { type: 'success' | 'error', message: '' }
  const fileInputRef = useRef(null);

  const handleBackup = async () => {
    setIsBackingUp(true);
    try {
      const response = await fetch('/api/v1/system/backup', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      
      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.detail || t('Backup failed'));
      }

      // Trigger download
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Get filename from header if possible, else fallback
      const contentDisposition = response.headers.get('content-disposition');
      let filename = `starkllm_backup_${new Date().toISOString().split('T')[0]}.zip`;
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="(.+)"/);
        if (match && match[1]) filename = match[1];
      }
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      toast.error(err.message);
    } finally {
      setIsBackingUp(false);
    }
  };

  const handleFileClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    // Reset file input so the same file can be selected again if needed
    e.target.value = null;

    if (!window.confirm(t('DANGER: Restoring from a backup will overwrite ALL your current workspaces, chats, documents, and settings. This cannot be undone. Are you sure you want to proceed?'))) {
      return;
    }

    setIsRestoring(true);
    setRestoreStatus(null);
    
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('/api/v1/system/restore', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
      });

      const data = await response.json().catch(() => ({}));
      
      if (!response.ok) {
        throw new Error(data.detail || t('Restore failed'));
      }

      setRestoreStatus({
        type: 'success',
        message: t('Restore completed successfully! The application will now reload to apply the changes.')
      });
      
      // Give the user a moment to see the success message before reloading
      setTimeout(() => {
        window.location.reload();
      }, 3000);
      
    } catch (err) {
      console.error(err);
      setRestoreStatus({
        type: 'error',
        message: err.message
      });
    } finally {
      setIsRestoring(false);
    }
  };

  return (
    <div className={styles.settingsSection}>
      <h3 className={styles.sectionTitle}>{t('Backup & Restore')}</h3>
      <p className={styles.sectionDesc}>
        {t('Safely export and import your local application data, including chats, uploaded documents, and vector embeddings.')}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', marginTop: '20px' }}>
        
        {/* Backup Card */}
        <div style={{ 
          background: 'rgba(255,255,255,0.03)', 
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '12px',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px'
        }}>
          <h4 style={{ margin: 0, fontSize: '1rem', color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Download size={18} /> {t('Export Backup')}
          </h4>
          <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            {t('Creates a downloadable .zip archive of all your current StarkLLM data. Keep this safe!')}
          </p>
          <button 
            className={styles.primaryBtn} 
            onClick={handleBackup} 
            disabled={isBackingUp}
            style={{ width: 'fit-content', marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}
          >
            {isBackingUp ? <><Loader size={16} className="spinner" /> {t('Zipping data...')}</> : t('Download Backup')}
          </button>
        </div>

        {/* Restore Card */}
        <div style={{ 
          background: 'rgba(239, 68, 68, 0.05)', 
          border: '1px solid rgba(239, 68, 68, 0.2)',
          borderRadius: '12px',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px'
        }}>
          <h4 style={{ margin: 0, fontSize: '1rem', color: '#ef4444', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Upload size={18} /> {t('Restore from Backup')}
          </h4>
          <p style={{ margin: 0, fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            {t('Upload a previously exported .zip backup.')} <strong style={{ color: '#ef4444' }}>{t('Warning: This will permanently overwrite your current data.')}</strong>
          </p>
          
          <input
            type="file"
            ref={fileInputRef}
            style={{ display: 'none' }}
            onChange={handleFileChange}
            accept=".zip"
          />
          
          <button 
            className={styles.dangerBtn} 
            onClick={handleFileClick} 
            disabled={isRestoring}
            style={{ width: 'fit-content', marginTop: '8px', display: 'flex', alignItems: 'center', gap: '8px' }}
          >
            {isRestoring ? <><Loader size={16} className="spinner" /> {t('Restoring...')}</> : t('Select Backup Zip')}
          </button>

          {restoreStatus && (
            <div style={{ 
              marginTop: '12px',
              padding: '12px',
              borderRadius: '8px',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '10px',
              background: restoreStatus.type === 'success' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
              border: `1px solid ${restoreStatus.type === 'success' ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`,
              color: restoreStatus.type === 'success' ? '#22c55e' : '#ef4444',
              fontSize: '0.9rem'
            }}>
              {restoreStatus.type === 'success' ? <CheckCircle size={18} style={{ flexShrink: 0 }} /> : <AlertTriangle size={18} style={{ flexShrink: 0 }} />}
              <div style={{ whiteSpace: 'pre-wrap', lineHeight: '1.5' }}>
                {restoreStatus.message}
              </div>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
