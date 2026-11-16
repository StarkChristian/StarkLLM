import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import markup from '../assets/lucy/lucy-markup.html?raw';
import '../assets/lucy/lucy.css';
import styles from './Lucy.module.css';
import { t } from '../i18n';
import { isHidden, setHidden, guideDone, setGuideDone, stepAfter, GUIDE_POSES, CHANGE_EVENT } from '../utils/lucy';

// Lucy, the helper robot. She lives inside the page (never floats over it), speaks only texts of the translation files,
// moves only when the system allows motion, can be hidden once (and is then remembered), and is not used in error
// messages. Her drawing is inline: nothing is loaded from the network.

const escapeAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false);
  useEffect(() => {
    const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return undefined;
    const on = () => setReduced(query.matches);
    query.addEventListener?.('change', on);
    return () => query.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/** Whether she is shown (the user can hide her; Settings > Appearance brings her back) and whether the guide is done. */
export function useLucy() {
  const read = () => ({ visible: !isHidden(), guideIsDone: guideDone() });
  const [state, setState] = useState(read);
  useEffect(() => {
    const on = () => setState(read());
    window.addEventListener(CHANGE_EVENT, on);
    return () => window.removeEventListener(CHANGE_EVENT, on);
  }, []);
  return state;
}

export const useLucyVisible = () => useLucy().visible;

/** The drawing. state: idle, wave, point, talk, celebrate (see assets/lucy/lucy.css). */
export function LucyFigure({ state = 'idle', size = 96 }) {
  const reduced = useReducedMotion();
  const pose = reduced && ['wave', 'point', 'talk', 'celebrate'].includes(state) ? state : null;
  const svg = markup
    .replace('Lucy, the StarkLLM robot', escapeAttr(t('Lucy, the StarkLLM robot')))
    .replace('data-state="idle"', `data-state="${state}"${pose ? ` data-pose="${pose}"` : ''}`);
  return <div className={styles.figure} style={{ width: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Lucy with a speech bubble in the flow of the page: an empty page explained. `text` is already translated. */
export function LucyHelper({ text, state = 'point' }) {
  const { visible, guideIsDone } = useLucy();
  if (!visible || !guideIsDone) return null;  // not while the first-start guide speaks: one Lucy at a time
  return (
    <aside className={styles.helper}>
      <LucyFigure state={state} />
      <div className={styles.bubble} role="status">
        <p>{text}</p>
        <button className={styles.hide} onClick={() => setHidden(true)}>
          <X size={12} /> {t('Hide Lucy')}
        </button>
      </div>
    </aside>
  );
}

/** The first-start guide: three short steps, shown once, then remembered. */
export function LucyGuide() {
  const { visible, guideIsDone: done } = useLucy();
  const [index, setIndex] = useState(0);
  if (!visible || done) return null;
  const steps = [
    t('Hi, I am Lucy! I read your letters and documents here on this PC. Nothing is sent anywhere.'),
    t('Add a letter, a scan or a photo. I find the sender, the dates and the amounts, and show you the line they stand on.'),
    t('Open the Inbox to check what I read. Click a value and you see it on the page. If a date is unclear, I ask you instead of guessing.'),
  ];
  const last = index === steps.length - 1;
  const finish = () => setGuideDone(true);
  return (
    <aside className={styles.helper} aria-label={t('First steps with Lucy')}>
      <LucyFigure state={GUIDE_POSES[index]} />
      <div className={styles.bubble} role="status">
        <p>{steps[index]}</p>
        <span className={styles.count}>{t('Step {n} of {total}', { n: index + 1, total: steps.length })}</span>
        <span className={styles.buttons}>
          {index > 0 && <button onClick={() => setIndex(stepAfter(index, steps.length, -1))}>{t('Back')}</button>}
          {last
            ? <button className={styles.primary} onClick={finish}>{t('Got it')}</button>
            : <button className={styles.primary} onClick={() => setIndex(stepAfter(index, steps.length, 1))}>{t('Next')}</button>}
          <button onClick={() => setHidden(true)}><X size={12} /> {t('Hide Lucy')}</button>
        </span>
      </div>
    </aside>
  );
}
