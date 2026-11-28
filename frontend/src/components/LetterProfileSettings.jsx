import React, { useEffect, useState } from 'react';
import { Mail, Save, Loader, CheckCircle, Lock } from 'lucide-react';
import styles from './Settings.module.css';
import { useToast } from './Toast';
import { t } from '../i18n';

// The user's own name and address for reply letters from the inbox (2.8, option 10), filled in once. Stored in the
// engine's database on this PC, protected at rest when protection is on; never sent anywhere.
const FIELDS = [
  ['full_name', () => t('Full name'), 120, 'name'],
  ['street', () => t('Street and house number'), 160, 'street-address'],
  ['postal_code', () => t('Postcode'), 20, 'postal-code'],
  ['city', () => t('Town or city'), 120, 'address-level2'],
  ['country', () => t('Country (optional)'), 80, 'country-name'],
];

export default function LetterProfileSettings({ token }) {
  const toast = useToast();
  const headers = { Authorization: `Bearer ${token}` };
  const [profile, setProfile] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/v1/letters/profile', { headers });
        if (!res.ok) throw new Error(String(res.status));
        setProfile(await res.json());
      } catch (_) {
        toast.error(t('Your details for letters could not be loaded.'));
        setProfile({});
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('/api/v1/letters/profile', {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(FIELDS.map(([k]) => [k, profile[k] || '']))),
      });
      if (!res.ok) throw new Error(String(res.status));
      setProfile(await res.json());
      setSaved(true);
    } catch (_) {
      toast.error(t('Your details for letters could not be saved.'));
    } finally {
      setSaving(false);
    }
  };

  if (!profile) return <div className={styles.panel}><Loader size={18} className="spinner" /></div>;

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <Mail size={18} />
        <h2>{t('Your details for letters')}</h2>
      </div>
      <p className={styles.hint}>{t('Reply letters from the inbox carry your name and address as the sender. Fill them in once here.')}</p>
      <form onSubmit={save} className={styles.form}>
        {FIELDS.map(([key, label, max, auto]) => (
          <div className={styles.formGroup} key={key}>
            <label className={styles.label} htmlFor={`letter-${key}`}>{label()}</label>
            <input
              id={`letter-${key}`}
              className="input-field"
              value={profile[key] || ''}
              maxLength={max}
              autoComplete={auto}
              onChange={(e) => { setSaved(false); setProfile({ ...profile, [key]: e.target.value }); }}
            />
          </div>
        ))}
        <p className={styles.hint}><Lock size={12} /> {t('Stored only on this PC, and encrypted when protection is on (Settings, Protection). StarkLLM never sends letters.')}</p>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? <Loader size={14} className="spinner" /> : saved ? <CheckCircle size={14} /> : <Save size={14} />}
          {' '}{saved ? t('Saved') : t('Save')}
        </button>
      </form>
    </div>
  );
}
