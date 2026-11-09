import React, { useState, useEffect, useCallback } from 'react';
import styles from './SystemStatusWidget.module.css';
import {
  Activity, RefreshCw, Server, Cpu, Zap, Brain,
  CheckCircle2, XCircle, AlertTriangle, HelpCircle, Wifi
} from 'lucide-react';
import { UI_LOCALE } from '../utils/locale';

/* ── helpers ─────────────────────────────────────────── */
const STATUS_META = {
  online:   { label: 'Online',   color: '#22c55e', Icon: CheckCircle2 },
  offline:  { label: 'Offline',  color: '#ef4444', Icon: XCircle },
  missing:  { label: 'Missing',  color: '#f59e0b', Icon: AlertTriangle },
  degraded: { label: 'Degraded', color: '#f59e0b', Icon: AlertTriangle },
  unknown:  { label: 'Unknown',  color: '#768396', Icon: HelpCircle },
};

function StatusBadge({ status }) {
  const meta = STATUS_META[status] ?? STATUS_META.unknown;
  const { label, color, Icon } = meta;
  // Convert hex to rgba for background/border (12% and 25% alpha)
  const hex2rgba = (hex, alpha) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  };
  return (
    <span
      className={styles.badge}
      style={{
        '--badge-color': color,
        background: hex2rgba(color, 0.12),
        borderColor: hex2rgba(color, 0.28),
      }}
    >
      <Icon size={11} />
      {label}
    </span>
  );
}

function StatusRow({ icon: Icon, iconColor, label, sublabel, status, extra, error }) {
  return (
    <div className={styles.rowWrapper}>
      <div className={styles.row}>
        <div className={styles.rowIcon} style={{ background: `${iconColor}1a`, color: iconColor }}>
          <Icon size={15} />
        </div>
        <div className={styles.rowBody}>
          <span className={styles.rowLabel}>{label}</span>
          {sublabel && <span className={styles.rowSublabel} title={sublabel}>{sublabel}</span>}
        </div>
        <div className={styles.rowRight}>
          {extra && <span className={styles.rowExtra}>{extra}</span>}
          <StatusBadge status={status} />
        </div>
      </div>
      {error && (
        <div className={styles.rowError}>
          <AlertTriangle size={12} />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

/* ── derive overall health from a status object ──────── */
function deriveOverall(data) {
  if (!data) return 'unknown';
  const statuses = [
    data.ollama?.status,
    data.text_model?.status,
    data.embedding_model?.status,
  ];
  if (statuses.includes('offline'))  return 'offline';
  if (statuses.includes('missing') || statuses.includes('degraded')) return 'degraded';
  if (statuses.every(s => s === 'online')) return 'online';
  return 'unknown';
}

/* ── main component ──────────────────────────────────── */
export default function SystemStatusWidget({ token }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [lastChecked, setLastChecked] = useState(null);
  // open by default: collapsed, the card was a thin strip next to the clock and the prices
  const [expanded, setExpanded] = useState(true);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/dashboard/system-status', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const json = await res.json();
        setData(json);
        setLastChecked(new Date());
      }
    } catch (_) {}
    setLoading(false);
  }, [token]);

  // Initial fetch + 30-second auto-refresh
  useEffect(() => {
    if (!token) return;
    fetchStatus();
    const interval = setInterval(fetchStatus, 30_000);
    return () => clearInterval(interval);
  }, [fetchStatus, token]);

  const overall = deriveOverall(data);
  const overallMeta = STATUS_META[overall] ?? STATUS_META.unknown;
  const { color: overallColor } = overallMeta;

  const ollamaLatency = data?.ollama?.latency_ms != null
    ? `${data.ollama.latency_ms} ms`
    : null;

  // Full model name: "qwen3.8" hid which size (27b) is used
  const shortModel = (name) => name ?? '—';

  const timeAgo = lastChecked
    ? lastChecked.toLocaleTimeString(UI_LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  return (
    <div className={`${styles.widget} ${expanded ? styles.expanded : ''}`}>
      {/* ── Header ── */}
      <button
        className={styles.header}
        onClick={() => setExpanded(prev => !prev)}
        title={expanded ? 'Collapse' : 'Expand system status'}
      >
        <div className={styles.headerLeft}>
          <div className={styles.headerIcon} style={{ '--icon-color': overallColor }}>
            <Activity size={15} />
          </div>
          <span className={styles.headerTitle}>System Status</span>
          {/* Animated pulse dot */}
          <span
            className={`${styles.pulseOuter} ${overall === 'online' ? styles.pulseGreen : overall === 'offline' ? styles.pulseRed : styles.pulseAmber}`}
          >
            <span className={styles.pulseInner} />
          </span>
        </div>
        <div className={styles.headerRight}>
          <StatusBadge status={overall} />
          <button
            className={`${styles.refreshBtn} ${loading ? styles.spinning : ''}`}
            onClick={(e) => { e.stopPropagation(); fetchStatus(); }}
            title="Refresh status"
            disabled={loading}
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </button>

      {/* ── Collapsed summary ── */}
      {!expanded && data && (
        <div className={styles.summary}>
          <span className={styles.summaryItem}>
            <Wifi size={11} />
            Ollama {data.ollama?.latency_ms != null ? `${data.ollama.latency_ms}ms` : data.ollama?.status}
          </span>
          <span className={styles.summaryDot} />
          <span className={styles.summaryItem}>
            <Brain size={11} />
            {shortModel(data.text_model?.name)}
          </span>
          {timeAgo && (
            <>
              <span className={styles.summaryDot} />
              <span className={styles.summaryTime}>{timeAgo}</span>
            </>
          )}
        </div>
      )}

      {/* ── Expanded detail rows ── */}
      {expanded && (
        <div className={styles.detail}>
          <StatusRow
            icon={Server}
            iconColor="#6366f1"
            label="Backend API"
            sublabel="FastAPI server"
            status={data?.backend?.status ?? 'online'}
            error={data?.backend?.error}
          />
          <StatusRow
            icon={Cpu}
            iconColor="#06b6d4"
            label="Ollama"
            sublabel={data?.ollama?.url?.replace('http://', '') ?? '—'}
            status={data?.ollama?.status ?? 'unknown'}
            extra={ollamaLatency}
            error={data?.ollama?.error}
          />
          <StatusRow
            icon={Brain}
            iconColor="#8b5cf6"
            label="Text Model"
            sublabel={data?.text_model?.name ?? '—'}
            status={data?.text_model?.status ?? 'unknown'}
            error={data?.text_model?.error}
          />
          <StatusRow
            icon={Zap}
            iconColor="#f59e0b"
            label="Embedding Model"
            sublabel={data?.embedding_model?.name ?? '—'}
            status={data?.embedding_model?.status ?? 'unknown'}
            error={data?.embedding_model?.error}
          />

          {/* Available models list */}
          {data?.available_models?.length > 0 && (
            <div className={styles.modelList}>
              <span className={styles.modelListLabel}>Pulled models</span>
              <div className={styles.modelPills}>
                {data.available_models.map((m) => (
                  <span
                    key={m}
                    className={`${styles.modelPill} ${
                      m === data.text_model?.name || m.startsWith(data.text_model?.name?.split(':')[0])
                        ? styles.modelPillActive
                        : ''
                    }`}
                  >
                    {m}
                  </span>
                ))}
              </div>
            </div>
          )}

          {timeAgo && (
            <p className={styles.lastChecked}>Last checked: {timeAgo}</p>
          )}
        </div>
      )}

      {/* Loading skeleton overlay */}
      {loading && !data && (
        <div className={styles.skeleton}>
          <div className={styles.skeletonRow} />
          <div className={styles.skeletonRow} style={{ width: '70%' }} />
          <div className={styles.skeletonRow} style={{ width: '85%' }} />
        </div>
      )}
    </div>
  );
}

/* ── Tiny sidebar indicator (exported separately) ─────── */
export function SidebarStatusDot({ token }) {
  const [overall, setOverall] = useState('unknown');

  useEffect(() => {
    if (!token) return;
    const check = async () => {
      try {
        const res = await fetch('/api/v1/dashboard/system-status', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const json = await res.json();
          setOverall(deriveOverall(json));
        }
      } catch (_) {
        setOverall('offline');
      }
    };
    check();
    const interval = setInterval(check, 30_000);
    return () => clearInterval(interval);
  }, [token]);

  const color =
    overall === 'online'  ? '#22c55e' :
    overall === 'offline' ? '#ef4444' :
    overall === 'degraded'? '#f59e0b' : '#768396';

  return (
    <span
      className={styles.sidebarDot}
      style={{ '--dot-color': color }}
      title={`System: ${overall}`}
    />
  );
}
