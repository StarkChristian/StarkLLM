// Scheduled web tasks (docs/roadmap-2026-12.md, R5): the rule as words for the list and the card.
// The words are passed in, so the function can be tested without the app.

export function weekdayName(weekday, locale) {
  // 2023-01-01 was a Sunday: day 0 + weekday
  return new Date(2023, 0, 1 + Number(weekday)).toLocaleDateString(locale, { weekday: 'long' });
}

// words: { daily(time), weekly(weekdayName, time) } in the user language (utils/scheduleWords.js)
export function ruleText(rule, words, locale) {
  if (!rule) return '';
  if (rule.every === 'week') return words.weekly(weekdayName(rule.weekday, locale), rule.time);
  return words.daily(rule.time);
}
