import React, { useEffect, useMemo, useState } from 'react';
import { X, Briefcase, ShieldAlert, Sparkles, Lock } from 'lucide-react';
import { t, language } from '../i18n';
import { UI_LOCALE } from '../utils/locale';
import { useEscape } from '../utils/useEscape';
import {
  MIN_PASSWORD, CATEGORY_IDS, defaultYear, yearChoices, effectiveRows, overridesFrom, passwordProblem, counts,
  nameFromDisposition, saveZip,
} from '../utils/taxPack';
import styles from './TaxPackDialog.module.css';

// Inbox > "Export for my tax advisor" (StarkLLM 2.8, option 11): one year's financial letters and receipts as a ZIP,
// renamed and sorted into category folders, with an overview (CSV, Excel) and a short summary. The user checks the
// list first and can change a category or leave a document out. Made on this PC; nothing is sent anywhere.

const REASON = {
  scam: t('Possible scam: left out'),
  duplicate: t('Same letter as another document: left out'),
  replaced: t('Replaced by a newer letter'),
  not_financial: t('Not a financial letter'),
  user: t('Left out by you'),
  missing: t('The file could not be read'),
};

const fmtDate = (iso) => (iso ? new Date(`${iso}T12:00:00`).toLocaleDateString(UI_LOCALE) : '');
const fmtAmount = (r) => {
  if (r.number == null) return '';
  const n = Number(r.number);
  if (!Number.isFinite(n)) return r.amount || '';
  try {
    return new Intl.NumberFormat(UI_LOCALE, { style: 'currency', currency: r.currency || 'EUR' }).format(n);
  } catch (_) {
    return `${n.toFixed(2)} ${r.currency || ''}`.trim();
  }
};

export default function TaxPackDialog({ token, onClose }) {
  const headers = { Authorization: `Bearer ${token}` };
  const lang = ['en', 'de', 'es', 'fr', 'it', 'tr'].includes(language()) ? language() : 'en';
  const [year, setYear] = useState(defaultYear());
  const [workspaces, setWorkspaces] = useState(null);   // [{ id, name }]
  const [chosen, setChosen] = useState([]);
  const [includeKb, setIncludeKb] = useState(true);
  const [suggest, setSuggest] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [changes, setChanges] = useState({});
  const [password, setPassword] = useState('');
  const [repeated, setRepeated] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  useEscape(onClose, true);

  useEffect(() => {
    let alive = true;
    fetch('/api/v1/workspaces', { headers })
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => {
        if (!alive) return;
        const spaces = (list || []).map((w) => ({ id: w.id, name: w.name }));
        setWorkspaces(spaces);
        setChosen(spaces.map((w) => w.id));
      })
      .catch(() => { if (alive) setWorkspaces([]); });
    return () => { alive = false; };
  }, [token]);

  useEffect(() => {
    if (workspaces === null) return undefined;
    let alive = true;
    setLoading(true);
    setError('');
    setResult(null);
    fetch('/api/v1/taxpack/preview', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, workspaces: chosen, include_kb: includeKb, lang, suggest }),
    })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then((body) => {
        if (!alive) return;
        setData(body);
        // the model's suggestions are offered as changes the user can take back; the rules' category stays known
        const fromModel = {};
        for (const r of body.rows || []) if (r.suggested) fromModel[r.key] = { category: r.suggested, source: 'model' };
        setChanges(fromModel);
      })
      .catch(() => { if (alive) setError(t('The list could not be loaded. Is StarkLLM running?')); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [workspaces, year, chosen.join(','), includeKb, suggest]);

  const rows = useMemo(() => effectiveRows(data?.rows, changes), [data, changes]);
  const total = counts(rows);
  const categoryName = Object.fromEntries((data?.categories || []).map((c) => [c.id, c.name]));
  const problem = passwordProblem(password, repeated);

  const change = (key, patch) => setChanges((all) => ({ ...all, [key]: { ...(all[key] || {}), ...patch } }));
  const toggleSpace = (id) => setChosen((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]));

  const exportZip = async () => {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch('/api/v1/taxpack/export', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          year, workspaces: chosen, include_kb: includeKb, lang,
          overrides: overridesFrom(data?.rows, changes), password: password || null,
        }),
      });
      if (!res.ok) {
        setError(res.status === 413 ? t('The documents are too large for one package. Choose fewer workspaces.') : t('The package could not be created.'));
        return;
      }
      const name = nameFromDisposition(res.headers.get('Content-Disposition'), data?.package || 'StarkLLM.zip');
      const saved = await saveZip(await res.blob(), name);
      if (saved === null) return;
      if (!saved) {
        setError(t('The file could not be saved.'));
        return;
      }
      setResult({
        documents: Number(res.headers.get('X-Package-Documents') || total.included),
        missing: Number(res.headers.get('X-Package-Missing') || 0),
      });
    } catch (_) {
      setError(t('The package could not be created.'));
    } finally {
      setBusy(false);
    }
  };

  const years = yearChoices(data?.years);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="taxpack-title" onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3 id="taxpack-title" className={styles.title}><Briefcase size={18} /> {t('Export for my tax advisor')}</h3>
          <button className={styles.close} onClick={onClose} aria-label={t('Close')}><X size={18} /></button>
        </div>

        <div className={styles.body}>
          <p className={styles.note}>
            {t('StarkLLM puts the financial letters and receipts of one year into a ZIP file: renamed, sorted into folders, with an overview as CSV and Excel table and a short summary. Nothing is sent anywhere; you give the file to your tax advisor yourself.')}
          </p>

          <div className={styles.choices}>
            <label className={styles.field}>
              <span>{t('Year')}</span>
              <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </label>
            <fieldset className={styles.spaces}>
              <legend>{t('Workspaces')}</legend>
              {(workspaces || []).map((w) => (
                <label key={w.id} className={styles.check}>
                  <input type="checkbox" checked={chosen.includes(w.id)} onChange={() => toggleSpace(w.id)} /> {w.name}
                </label>
              ))}
              <label className={styles.check}>
                <input type="checkbox" checked={includeKb} onChange={(e) => setIncludeKb(e.target.checked)} /> {t('Knowledge base')}
              </label>
            </fieldset>
          </div>
          <label className={styles.check}>
            <input type="checkbox" checked={suggest} onChange={(e) => setSuggest(e.target.checked)} />
            {' '}{t('Let the local AI model suggest a category for documents the rules could not sort (optional, slower)')}
          </label>

          {loading ? (
            <p className={styles.note}>{t('Reading your documents…')}</p>
          ) : rows.length === 0 ? (
            data && <p className={styles.note}>{t('No financial letters found for {year} in the chosen places.', { year })}</p>
          ) : (
            <>
              <p className={styles.summary}>
                {t('{count} documents go into the package, {left} are left out. Check the list, change a category or leave a document out.', { count: total.included, left: total.excluded })}
              </p>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col"><span className={styles.srOnly}>{t('In the package')}</span></th>
                      <th scope="col">{t('Date')}</th>
                      <th scope="col">{t('From')}</th>
                      <th scope="col">{t('Kind')}</th>
                      <th scope="col">{t('Amount')}</th>
                      <th scope="col">{t('Category')}</th>
                      <th scope="col">{t('Note')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key} className={r.included ? '' : styles.excluded} title={r.included && r.new_name ? t('Name in the package: {name}', { name: r.new_name }) : r.filename}>
                        <td>
                          <input
                            type="checkbox"
                            checked={r.included}
                            aria-label={t('Put {file} into the package', { file: r.filename })}
                            onChange={(e) => change(r.key, { included: e.target.checked })}
                          />
                        </td>
                        <td className={styles.nowrap}>
                          {fmtDate(r.date)}
                          {r.date_source === 'added' && <span className={styles.muted}> · {t('date when added')}</span>}
                        </td>
                        <td>{r.sender || r.filename}</td>
                        <td>{r.kind_label}</td>
                        <td className={styles.amount}>{fmtAmount(r)}</td>
                        <td>
                          <select
                            value={r.category}
                            aria-label={t('Category of {file}', { file: r.filename })}
                            onChange={(e) => change(r.key, { category: e.target.value, source: 'user' })}
                          >
                            {CATEGORY_IDS.map((c) => <option key={c} value={c}>{categoryName[c] || c}</option>)}
                          </select>
                        </td>
                        <td className={styles.reason}>
                          {!r.included && r.excluded_reason && (
                            <span className={r.excluded_reason === 'scam' ? styles.badgeDanger : styles.badgeMuted}>
                              {r.excluded_reason === 'scam' && <ShieldAlert size={12} />} {REASON[r.excluded_reason] || r.excluded_reason}
                            </span>
                          )}
                          {r.included && r.excluded_reason === 'scam' && (
                            <span className={styles.badgeDanger}><ShieldAlert size={12} /> {t('Possible scam: check it before you add it')}</span>
                          )}
                          {r.category_source === 'model' && (
                            <span className={styles.badgeAi}><Sparkles size={12} /> {t('Category suggested by the AI model')}</span>
                          )}
                          {r.category_source === 'rules' && r.category_reason && (
                            <span className={styles.muted}>{t('Sorted by the word "{word}" on page {page}', { word: r.category_reason.word, page: r.category_reason.page })}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <section className={styles.protect}>
            <p className={styles.warning}>
              <ShieldAlert size={16} />
              <span>{t('The ZIP file is not encrypted unless you set a password. Anyone who gets the file can read your documents. Keep it safe and delete it when your tax advisor has it.')}</span>
            </p>
            <div className={styles.choices}>
              <label className={styles.field}>
                <span><Lock size={13} /> {t('Password for the ZIP (optional)')}</span>
                <input type="password" autoComplete="new-password" value={password} maxLength={200} onChange={(e) => setPassword(e.target.value)} />
              </label>
              <label className={styles.field}>
                <span>{t('Repeat the password')}</span>
                <input type="password" autoComplete="new-password" value={repeated} maxLength={200} onChange={(e) => setRepeated(e.target.value)} />
              </label>
            </div>
            {problem === 'short' && <p className={styles.error}>{t('The password needs at least {count} characters.', { count: MIN_PASSWORD })}</p>}
            {problem === 'different' && <p className={styles.error}>{t('The two passwords are not the same.')}</p>}
            {password && (
              <p className={styles.hint}>
                {t('AES-256 encryption. The file names in the ZIP stay readable. Your tax advisor needs a program such as 7-Zip or WinRAR to open it; the Windows Explorer cannot. Tell the password by phone or in person, not in the same email.')}
              </p>
            )}
          </section>

          {error && <p className={styles.error}>{error}</p>}
          {result && (
            <p className={styles.success}>
              {t('Saved. {count} documents are in the package.', { count: result.documents })}
              {result.missing > 0 && ` ${t('{count} files could not be read and are not in the package.', { count: result.missing })}`}
            </p>
          )}
        </div>

        <div className={styles.footer}>
          <span className={styles.hint}>{t('Read by fixed rules from your documents. Please check the list before you save it.')}</span>
          <div className={styles.actions}>
            <button className="btn-secondary" onClick={onClose}>{t('Close')}</button>
            <button className="btn-primary" disabled={busy || loading || total.included === 0 || Boolean(problem)} onClick={exportZip}>
              {busy ? t('Creating the package…') : t('Save ZIP…')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
