import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Smartphone, AlertTriangle, CheckCircle, Loader, Trash2, QrCode, WifiOff } from 'lucide-react';
import styles from './Settings.module.css';
import { t } from '../i18n';

// Settings > Phone: the StarkLLM app for Android on the home network (desktop/phonelink.js, docs/android-companion.md).
// The desktop app does everything; this page switches it on, shows the pairing QR code and lists the paired phones.

const bridge = () => (typeof window !== 'undefined' && window.starkllmDesktop && window.starkllmDesktop.phoneLink) || null;
export const hasPhoneLink = () => Boolean(bridge());

const card = { background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', borderRadius: 12, padding: 20, display: 'flex', flexDirection: 'column', gap: 12 };
const note = (ok) => ({ padding: 12, borderRadius: 8, fontSize: '0.9rem', lineHeight: 1.5, display: 'flex', gap: 8,
  background: ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)', color: ok ? '#22c55e' : '#ef4444',
  border: `1px solid ${ok ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}` });

const MESSAGES = {
  offline: t('The phone link is closed while StarkLLM is fully offline (Settings > Privacy & network).'),
  'port-busy': t('The phone link could not start: its network ports are used by another program.'),
  certificate: t('The phone link could not create its encryption certificate.'),
  failed: t('The phone link could not start.'),
  'no-network': t('This PC is not connected to a home network (Wi-Fi or cable), so a phone cannot reach it.'),
  'too-many-devices': t('Ten phones are paired already. Remove one first.'),
  'not-on': t('Turn on the phone link first.'),
};
const say = (code, fallback) => MESSAGES[code] || fallback || t('The phone link could not start.');

// What a paired phone may do (desktop/phonelink.js, LEVELS)
const LEVELS = [
  ['ask', t('Ask only')],
  ['work', t('Ask and send documents')],
  ['manage', t('Ask, send and manage this PC')],
];
const LEVEL_HINTS = {
  ask: t('Reads workspaces, chats, the inbox and deadlines, and asks questions. Changes nothing.'),
  work: t('Also sends photos and documents, deletes chats and marks deadlines as done.'),
  manage: t('Also starts a backup now and can switch StarkLLM fully offline. The phone asks for your fingerprint first.'),
};

// The QR code as squares (the desktop app makes it; no library and no network here). Dark on white with a quiet zone,
// also in the dark theme, so every phone camera reads it.
function QrSquares({ matrix }) {
  const n = matrix.length;
  const runs = [];
  matrix.forEach((row, y) => {
    let x = 0;
    while (x < n) {
      if (!row[x]) { x += 1; continue; }
      let end = x;
      while (end < n && row[end]) end += 1;
      runs.push(<rect key={`${y}-${x}`} x={x + 4} y={y + 4} width={end - x} height={1} />);
      x = end;
    }
  });
  return (
    <svg viewBox={`0 0 ${n + 8} ${n + 8}`} width={320} height={320} shapeRendering="crispEdges" role="img" aria-label={t('QR code for pairing a phone')}
         style={{ background: '#fff', borderRadius: 8, alignSelf: 'center' }}>
      <g fill="#000">{runs}</g>
    </svg>
  );
}

export default function PhoneSettings() {
  const api = bridge();
  const [status, setStatus] = useState(null);
  const [pairing, setPairing] = useState(null);     // { qr, expiresAt, addresses, port, devicesBefore }
  const [justPaired, setJustPaired] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [clock, setClock] = useState(Date.now());
  const pairingRef = useRef(null);
  pairingRef.current = pairing;

  const refresh = useCallback(async () => {
    if (!api) return;
    const s = await api.status();
    if (!s || s.error) return;
    setStatus(s);
    const p = pairingRef.current;
    if (p && s.devices.length > p.devicesBefore) {
      setJustPaired(s.devices[s.devices.length - 1].name);
      setPairing(null);
    } else if (p && !s.pairing) {
      setPairing(null);                              // expired, or closed after wrong codes
    }
  }, [api]);

  useEffect(() => {
    if (!api) return undefined;
    refresh();
    const off = api.onChange ? api.onChange(refresh) : () => {};
    const timer = setInterval(refresh, 10000);
    return () => { off(); clearInterval(timer); };
  }, [api, refresh]);

  useEffect(() => {
    if (!pairing) return undefined;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  if (!api) return null;

  const run = async (name, fn) => {
    setBusy(name); setError('');
    try { await fn(); await refresh(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };
  const check = (r) => { if (r && r.error) throw new Error(say(r.error, r.message)); return r; };

  const toggle = () => run('enable', async () => {
    const s = check(await api.setEnabled(!(status && status.enabled)));
    if (!s.enabled) setPairing(null);
    setJustPaired('');
  });
  const pair = () => run('pair', async () => {
    setJustPaired('');
    const p = check(await api.startPairing());
    setPairing({ ...p, devicesBefore: status ? status.devices.length : 0 });
  });
  const cancel = () => run('cancel', async () => { await api.cancelPairing(); setPairing(null); });
  const remove = (d) => {
    if (!window.confirm(t('Remove "{name}"? The phone can no longer reach StarkLLM until you pair it again.', { name: d.name }))) return;
    run(`remove-${d.id}`, async () => { check(await api.removeDevice(d.id)); });
  };

  const setLevel = (d, level) => run(`level-${d.id}`, async () => { check(await api.setLevel(d.id, level)); });

  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');
  const left = pairing ? Math.max(0, Math.round((pairing.expiresAt - clock) / 1000)) : 0;
  const on = Boolean(status && status.enabled);

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <Smartphone size={18} />
        <h2>{t('Phone')}</h2>
        <span className="badge badge-accent">{t('Preview')}</span>
      </div>
      <p className={styles.panelDesc}>
        {t('Ask about your documents and send photos of letters from your Android phone. The documents and the AI model stay on this PC: the phone connects over your home network, encrypted, and only after you paired it here.')}
      </p>
      <p className={styles.hint}>
        {t('The StarkLLM app for Android is in a closed test on Google Play before everyone can download it. How to take part:')}{' '}
        <a href="https://www.starkllm.com/android" target="_blank" rel="noreferrer">www.starkllm.com/android</a>
      </p>

      {error && <div style={note(false)}><AlertTriangle size={18} style={{ flexShrink: 0 }} />{error}</div>}

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'space-between' }}>
          <div>
            <strong>{t('Allow a phone on the home network')}</strong>
            <div className={styles.hint}>{on && status.listening ? t('On: paired phones can reach StarkLLM while this PC is on and StarkLLM runs.') : t('Off: no phone can reach StarkLLM.')}</div>
          </div>
          <button className={on ? 'btn-secondary' : 'btn-primary'} disabled={busy === 'enable' || !status} onClick={toggle}>
            {busy === 'enable' ? <Loader size={16} className="spinner" /> : null} {on ? t('Turn off') : t('Turn on')}
          </button>
        </div>
        {status && status.offline && <div style={note(false)}><WifiOff size={18} style={{ flexShrink: 0 }} />{MESSAGES.offline}</div>}
        {status && on && !status.offline && status.error && <div style={note(false)}><AlertTriangle size={18} style={{ flexShrink: 0 }} />{say(status.error)}</div>}
        {on && <div className={styles.hint}>{t('Windows may ask once whether StarkLLM may be reached on networks. Allow it for private networks (your home) only.')}</div>}
      </div>

      {on && status.listening && (
        <div style={card}>
          <h4 style={{ margin: 0 }}>{t('Pair a phone')}</h4>
          {justPaired && <div style={note(true)}><CheckCircle size={18} style={{ flexShrink: 0 }} />{t('"{name}" is paired.', { name: justPaired })}</div>}
          {!pairing && (
            <>
              <div className={styles.hint}>{t('Install the StarkLLM app on your Android phone, connect the phone to the same Wi-Fi as this PC, then show the QR code and scan it with the app.')}</div>
              <button className="btn-primary" style={{ width: 'fit-content' }} disabled={busy === 'pair'} onClick={pair}>
                {busy === 'pair' ? <Loader size={16} className="spinner" /> : <QrCode size={16} />} {t('Show QR code')}
              </button>
            </>
          )}
          {pairing && (
            <>
              <QrSquares matrix={pairing.qr} />
              <div className={styles.hint} style={{ textAlign: 'center' }}>
                {left > 0 ? t('Scan it with the StarkLLM app. The code works once and for {seconds} more seconds.', { seconds: left }) : t('The code has expired. Show a new one.')}
              </div>
              <div className={styles.hint} style={{ textAlign: 'center' }}>{t('Only show this code to your own phone: whoever scans it can use StarkLLM from the home network.')}</div>
              <button className="btn-secondary" style={{ width: 'fit-content', alignSelf: 'center' }} onClick={left > 0 ? cancel : pair}>
                {left > 0 ? t('Cancel') : t('Show QR code')}
              </button>
            </>
          )}
        </div>
      )}

      {status && status.devices.length > 0 && (
        <div style={card}>
          <h4 style={{ margin: 0 }}>{t('Paired phones')}</h4>
          {status.devices.map((d) => (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Smartphone size={18} style={{ flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div>{d.name}</div>
                <div className={styles.hint}>{t('Paired {time}', { time: when(d.created) })}{d.lastSeen ? ` · ${t('last seen {time}', { time: when(d.lastSeen) })}` : ''}</div>
                <label className={styles.hint} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  {t('This phone may:')}
                  <select value={d.level || 'work'} disabled={busy === `level-${d.id}`} onChange={(e) => setLevel(d, e.target.value)}>
                    {LEVELS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
                <div className={styles.hint}>{LEVEL_HINTS[d.level || 'work']}</div>
              </div>
              <button className="btn-secondary" disabled={busy === `remove-${d.id}`} onClick={() => remove(d)} title={t('Remove')}>
                <Trash2 size={16} /> {t('Remove')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
