import { t } from '../i18n';

// What kind of bank detail a fact is (backend/app/services/document_checks.py, bank_accounts). An IBAN needs no label.
export function accountLabel(kind) {
  switch (kind) {
    case 'us_routing': return t('Routing number');
    case 'us_account':
    case 'uk_account': return t('Account number');
    case 'uk_sort_code': return t('Sort code');
    case 'au_bsb': return t('BSB');
    case 'bic': return t('BIC / SWIFT');
    default: return '';
  }
}
