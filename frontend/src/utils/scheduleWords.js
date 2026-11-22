import { t } from '../i18n';
import { UI_LOCALE } from './locale';
import { ruleText } from './schedule';

// A schedule rule in the user language: "daily at 08:00", "every Monday at 18:30"
export const ruleInWords = (rule) => ruleText(rule, {
  daily: (time) => t('daily at {time}', { time }),
  weekly: (weekday, time) => t('every {weekday} at {time}', { weekday, time }),
}, UI_LOCALE);
