import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import styles from './Toast.module.css';
import { X, CheckCircle, AlertCircle, AlertTriangle, Info } from 'lucide-react';
import { t } from '../i18n';

const ToastContext = createContext(null);

let _id = 0;
const ICONS = {
  success: CheckCircle,
  error:   AlertCircle,
  warning: AlertTriangle,
  info:    Info,
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef({});

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current[id]);
    delete timers.current[id];
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const addToast = useCallback((type, message, duration = 5000, action = null) => {
    const id = ++_id;
    setToasts(prev => [...prev, { id, type, message, action }]);
    if (duration > 0) {
      timers.current[id] = setTimeout(() => dismiss(id), duration);
    }
    return id;
  }, [dismiss]);

  const toast = {
    success: (msg, duration, action) => addToast('success', msg, duration, action),
    error:   (msg, duration, action) => addToast('error',   msg, duration ?? 8000, action),
    warning: (msg, duration, action) => addToast('warning', msg, duration, action),
    info:    (msg, duration, action) => addToast('info',    msg, duration, action),
  };

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className={styles.container} aria-live="polite">
        {toasts.map(t => {
          const Icon = ICONS[t.type] || Info;
          return (
            <div key={t.id} className={`${styles.toast} ${styles[t.type]}`}>
              <Icon size={16} className={styles.toastIcon} />
              <div className={styles.toastContent}>
                <span className={styles.toastMsg}>{t.message}</span>
                {t.action && (
                  <button 
                    className={styles.toastAction} 
                    onClick={() => { t.action.onClick(); dismiss(t.id); }}
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
              <button
                className={styles.dismissBtn}
                onClick={() => dismiss(t.id)}
                aria-label={t('Dismiss')}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}
