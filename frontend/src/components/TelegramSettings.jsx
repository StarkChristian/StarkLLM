import React, { useEffect, useState } from 'react';
import { Send, Smartphone, Trash2, KeyRound, ShieldCheck } from 'lucide-react';
import styles from './Settings.module.css';
import { t } from '../i18n';

// Settings > Telegram: ask StarkLLM from the phone through the user's own Telegram bot (backend: api/telegram.py).
export default function TelegramSettings({ token }) {
  const [status, setStatus] = useState(null);
  const [botToken, setBotToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const call = async (method, path = '', body) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/v1/telegram${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      setStatus(data);
      return data;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    call('GET');
    // the code expires and the paired list changes when the phone sends the code
    const timer = setInterval(() => call('GET'), 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveToken = async (e) => {
    e.preventDefault();
    if (await call('PUT', '', { token: botToken, enabled: true })) setBotToken('');
  };

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <Send size={18} />
        <h2>{t('Telegram')}</h2>
      </div>
      <p className={styles.panelDesc}>
        {t('Ask StarkLLM from your phone through your own Telegram bot. StarkLLM only connects out to Telegram; your PC opens no port and stays unreachable from the internet.')}
      </p>

      <div className={styles.infoBox}>
        <strong>{t('Privacy:')}</strong>{' '}
        {t('Questions you send from the phone and the answers pass through Telegram\'s servers. Your documents stay on this PC; only the answer and the names of its sources are sent.')}
      </div>

      {error && <p className={styles.hint} style={{ color: 'var(--danger)' }}>{error}</p>}

      {status && !status.configured && (
        <form onSubmit={saveToken} className={styles.form}>
          <div className={styles.panelSubheader}><KeyRound size={15} /> {t('1. Create your bot')}</div>
          <p className={styles.hint}>
            {t('In Telegram, open @BotFather, send /newbot and choose a name. BotFather replies with a token; paste it here.')}
          </p>
          <div className={styles.formGroup}>
            <label className={styles.label}>{t('Bot token')}</label>
            <input
              type="password"
              className="input-field"
              placeholder="123456789:AA…"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              autoComplete="off"
              required
            />
          </div>
          <button type="submit" className="btn-primary" disabled={busy || !botToken.trim()}>
            {busy ? t('Checking...') : t('Connect bot')}
          </button>
        </form>
      )}

      {status && status.configured && (
        <>
          <div className={styles.formGroup}>
            <label className={styles.label}>{t('Bot')}</label>
            <p className={styles.hint} style={{ marginTop: 0 }}>
              @{status.bot_username} · {status.enabled ? (status.running ? t('active') : t('starting…')) : t('off')}
              {status.last_error ? ` · ${t('Problem: {error}', { error: status.last_error })}` : ''}
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => call('PUT', '', { enabled: !status.enabled })}>
                {status.enabled ? t('Switch off') : t('Switch on')}
              </button>
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => window.confirm(t('Remove the bot and all paired phones from StarkLLM?')) && call('PUT', '', { token: '' })}>
                {t('Remove bot')}
              </button>
            </div>
          </div>

          <div className={styles.divider} />
          <div className={styles.panelSubheader}><Smartphone size={15} /> {t('2. Pair your phone')}</div>
          {status.pairing_code ? (
            <p className={styles.hint}>
              {t('Send this code to @{bot} in Telegram (valid for {minutes} more minutes):', { bot: status.bot_username, minutes: Math.max(1, Math.ceil(status.pairing_expires_in / 60)) })}
              <span style={{ display: 'block', fontSize: '2rem', fontWeight: 700, letterSpacing: '0.2em', margin: '10px 0', color: 'var(--text-primary)' }}>{status.pairing_code}</span>
            </p>
          ) : (
            <button type="button" className="btn-primary" disabled={busy || !status.enabled} onClick={() => call('POST', '/pairing-code')}>
              {t('Show pairing code')}
            </button>
          )}

          <div className={styles.divider} />
          <div className={styles.panelSubheader}><ShieldCheck size={15} /> {t('Paired phones')}</div>
          {status.chats.length === 0 ? (
            <p className={styles.hint}>{t('No phone is paired yet. Only paired Telegram chats get answers.')}</p>
          ) : (
            status.chats.map((c) => (
              <div key={c.chat_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 0' }}>
                <span>{c.name}</span>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => call('DELETE', `/chats/${c.chat_id}`)} title={t('Unpair')}>
                  <Trash2 size={14} /> {t('Unpair')}
                </button>
              </div>
            ))
          )}
          <p className={styles.hint}>{t('In Telegram, /new starts a new conversation. Answers use your first workspace and your knowledge base.')}</p>
        </>
      )}
    </div>
  );
}
