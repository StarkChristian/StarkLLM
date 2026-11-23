// Scheduled web tasks (docs/roadmap-2026-12.md, R5): the rule in words.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ruleText, weekdayName } from '../src/utils/schedule.js';

const words = { daily: (time) => `daily at ${time}`, weekly: (weekday, time) => `every ${weekday} at ${time}` };

test('rules in words', () => {
  assert.equal(ruleText({ every: 'day', time: '08:00' }, words, 'en'), 'daily at 08:00');
  assert.equal(ruleText({ every: 'week', time: '18:30', weekday: 1 }, words, 'en'), 'every Monday at 18:30');
  assert.equal(weekdayName(0, 'de'), 'Sonntag');
  assert.equal(ruleText(null, words, 'en'), '');
});
