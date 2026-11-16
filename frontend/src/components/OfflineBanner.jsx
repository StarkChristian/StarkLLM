import React, { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import styles from './OfflineBanner.module.css';
import { t } from '../i18n';
import { readOffline, onOfflineChange } from '../utils/privacy';

// The state of the fully offline switch, visible on every page. useOffline() is also used to switch off the features
// that need the internet (web search).
export function useOffline(token) {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    if (!token) return undefined;
    let alive = true;
    const read = () => readOffline(token).then((s) => alive && setOffline(s.offline));
    read();
    const timer = setInterval(read, 20_000);
    const off = onOfflineChange(setOffline);
    return () => { alive = false; clearInterval(timer); off(); };
  }, [token]);
  return offline;
}

export default function OfflineBanner({ offline }) {
  if (!offline) return null;
  return (
    <div className={styles.banner} role="status">
      <WifiOff size={14} />
      <span>{t('Fully offline: StarkLLM makes no connection to the internet. Only the AI engine on this PC is used.')}</span>
    </div>
  );
}
