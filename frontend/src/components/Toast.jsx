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
    setToasts(prev => prev.filter(item => item.id !== id));
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
        {toasts.map(item => {
          const Icon = ICONS[item.type] || Info;
          return (
            <div key={item.id} className={`${styles.toast} ${styles[item.type]}`}>
              <Icon size={16} className={styles.toastIcon} />
              <div className={styles.toastContent}>
                <span className={styles.toastMsg}>{item.message}</span>
                {item.action && (
                  <button 
                    className={styles.toastAction} 
                    onClick={() => { item.action.onClick(); dismiss(item.id); }}
                  >
                    {item.action.label}
                  </button>
                )}
              </div>
              <button
                className={styles.dismissBtn}
                onClick={() => dismiss(item.id)}
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
