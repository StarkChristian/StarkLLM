import React from 'react';
import { ShieldAlert, Info, SearchX } from 'lucide-react';
import styles from './ChatArea.module.css';
import { t } from '../i18n';
import { noSourceActions, splitWarnings } from '../utils/documentHealth';

// "No good source" (2.7, source_quality.py): no passage answered the question well, so the answer did not use any.
// Says so plainly and what the user can do, instead of a silent "not found" or a guess.
function NoGoodSource({ warning }) {
  const actions = noSourceActions(warning);
  return (
    <div className={styles.docNotice} role="note">
      <SearchX size={16} className={styles.docNoticeIcon} />
      <div>
        <p><strong>{t('No passage in your documents answers this well.')}</strong> {t('StarkLLM therefore did not answer from them, so as not to guess.')}</p>
        <p>{t('What you can do:')}</p>
        <ul className={styles.docNoticeList}>
          {actions.includes('check') && <li>{t('Check the document: in the document list, "Document health" shows what StarkLLM could read from it.')}</li>}
          {actions.includes('rephrase') && <li>{t('Ask again in other words, for example with the term the document itself uses.')}</li>}
          {actions.includes('web') && <li>{t('Turn on web search if the answer may be on the internet.')}</li>}
        </ul>
      </div>
    </div>
  );
}

// Warnings from StarkLLM's own rules on the documents an answer used (document_checks.py). They do not depend on the
// model: a small model may overlook or even contradict them in its text.
//   red:    text that instructs AI assistants, hidden text that was left out, several signs of a scam, one sender with two accounts
//   yellow: a sender announces a new bank account (normal, but worth confirming before paying)
function signText(sign) {
  switch (sign) {
    case 'foreign_account_authority': return t('an authority asks for payment to a foreign account');
    case 'foreign_account': return t('payment to a foreign account');
    case 'voucher_payment': return t('payment with vouchers, gift cards or crypto');
    case 'payment_link': return t('payment through a link');
    case 'advance_fee': return t('a fee before a prize or money is paid out');
    case 'arrest_threat': return t('a threat of arrest or police over money');
    case 'urgency': return t('extreme time pressure');
    case 'secrecy': return t('a request to keep it secret');
    default: return sign;
  }
}

function accountsText(w) {
  return (w.accounts || []).map((a) => `${a.iban}: ${(a.files || []).join(', ')}`).join(' | ');
}

function message(w) {
  if (w.kind === 'ai_instructions') {
    return t('{file} contains text that tries to instruct AI assistants. Genuine letters never do this: treat it as a possible scam.', { file: w.file });
  }
  if (w.kind === 'hidden_text') {
    return t('{file} contains text that cannot be seen on the page (white, tiny, hidden or invisible characters). StarkLLM left it out. Genuine letters do not hide text: treat this document with care.', { file: w.file });
  }
  if (w.kind === 'scam_signs') {
    return t('{file} shows several typical signs of a scam: {signs}. Do not pay, click links or send codes. Check with the organisation using contact details you already know.', {
      file: w.file,
      signs: (w.signs || []).map(signText).join(', '),
    });
  }
  if (w.kind === 'account_change') {
    return t('{sender} announces a new bank account ({accounts}). That is normal, but before you change a standing order, you can confirm it using the phone number you already know.', {
      sender: w.sender, accounts: accountsText(w),
    });
  }
  return t('Two letters from {sender} name different bank accounts ({accounts}). Before you pay, check with the sender using a phone number or address you already know.', {
    sender: w.sender, accounts: accountsText(w),
  });
}

export default function DocumentWarnings({ warnings }) {
  const { serious, notes, noSource } = splitWarnings(warnings);
  return (
    <>
      {noSource && <NoGoodSource warning={noSource} />}
      {serious.length > 0 && (
        <div className={styles.docWarning} role="alert">
          <ShieldAlert size={16} className={styles.docWarningIcon} />
          <div>{serious.map((w, i) => <p key={i}>{message(w)}</p>)}</div>
        </div>
      )}
      {notes.length > 0 && (
        <div className={styles.docNotice} role="note">
          <Info size={16} className={styles.docNoticeIcon} />
          <div>{notes.map((w, i) => <p key={i}>{message(w)}</p>)}</div>
        </div>
      )}
    </>
  );
}
