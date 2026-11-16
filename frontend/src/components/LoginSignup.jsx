import React, { useState } from 'react';
import styles from './LoginSignup.module.css';
import { t } from '../i18n';

export default function LoginSignup({ onLoginSuccess }) {
  const [isLogin, setIsLogin] = useState(true);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      let response;
      if (isLogin) {
        const formData = new URLSearchParams();
        formData.append('username', username);
        formData.append('password', password);
        response = await fetch('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formData.toString()
        });
      } else {
        response = await fetch('/api/v1/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
      }

      const parseResponse = async (res) => {
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          return await res.json();
        }
        const text = await res.text();
        if (res.status === 502 || res.status === 504) {
          throw new Error('Backend service unavailable (HTTP 502). Please ensure the backend container is running.');
        }
        throw new Error(`Server returned unexpected response (HTTP ${res.status}): ${text.slice(0, 120)}`);
      };

      if (!response.ok) {
        let errorMsg = t('Authentication failed');
        try {
          const errorData = await parseResponse(response);
          errorMsg = errorData.detail || errorMsg;
        } catch (parseErr) {
          errorMsg = parseErr.message || errorMsg;
        }
        throw new Error(errorMsg);
      }

      const data = await parseResponse(response);

      if (isLogin) {
        onLoginSuccess(data.access_token);
      } else {
        const formData = new URLSearchParams();
        formData.append('username', username);
        formData.append('password', password);
        const loginResponse = await fetch('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formData.toString()
        });
        if (loginResponse.ok) {
          const loginData = await parseResponse(loginResponse);
          onLoginSuccess(loginData.access_token);
        } else {
          setError(t('Account created successfully! Please log in above.'));
          setIsLogin(true);
        }
      }
    } catch (err) {
      setError(err.message || t('An unexpected error occurred'));
    } finally {
      setLoading(false);
    }
  };

  const localToken = typeof window !== 'undefined' && window.starkllmDesktop?.localToken ? window.starkllmDesktop.localToken() : null;

  return (
    <div className={styles.page}>
      {/* Background glow orbs */}
      <div className={styles.glowA} />
      <div className={styles.glowB} />

      <div className={styles.card}>
        {/* Logo + brand */}
        <div className={styles.brand}>
          <img src="/Logo.png" alt="StarkLLM" className={styles.logo} />
          <h1 className={styles.brandName}>StarkLLM</h1>
          <p className={styles.brandTagline}>{t('Your private AI assistant')}</p>
        </div>

        {/* Desktop app, single user on this PC: no account needed (see desktop/preload.js) */}
        {localToken && (
          <button type="button" className="btn-primary" style={{ width: '100%', justifyContent: 'center', marginBottom: 16 }} onClick={() => onLoginSuccess(localToken)}>
            {t('Continue on this PC')}
          </button>
        )}

        {/* Tab switcher */}
        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${isLogin ? styles.tabActive : ''}`}
            onClick={() => { setIsLogin(true); setError(null); }}
          >{t('Login')}</button>
          <button
            className={`${styles.tab} ${!isLogin ? styles.tabActive : ''}`}
            onClick={() => { setIsLogin(false); setError(null); }}
          >{t('Sign Up')}</button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className={styles.form}>
          {error && (
            <div className={styles.errorBox}>
              {error}
            </div>
          )}
          <div className={styles.field}>
            <label className={styles.label}>{t('Username')}</label>
            <input
              type="text"
              className="input-field"
              placeholder={t('Enter your username')}
              value={username}
              onChange={e => setUsername(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>{t('Password')}</label>
            <input
              type="password"
              className="input-field"
              placeholder={t('Enter your password')}
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </div>
          <button
            type="submit"
            className="btn-primary"
            disabled={loading}
            style={{ width: '100%', justifyContent: 'center', marginTop: 4 }}
          >
            {loading ? t('Processing…') : isLogin ? t('Sign In') : t('Create Account')}
          </button>
        </form>

        <p className={styles.switchHint}>
          {isLogin ? t("Don't have an account?") + ' ' : t('Already have an account?') + ' '}
          <button
            className={styles.switchBtn}
            onClick={() => { setIsLogin(!isLogin); setError(null); }}
          >
            {isLogin ? t('Sign Up') : t('Login')}
          </button>
        </p>
      </div>
    </div>
  );
}
