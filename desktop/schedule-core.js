// Scheduled web tasks (docs/roadmap-2026-12.md, R5): a saved web task runs by itself, daily or weekly at a time, to
// look something up (a price, a deadline, a timetable). No Electron here: the times and the rules are plain functions,
// tested in desktop/test/schedule-core.test.js; webtask-schedule.js runs them.
//
// Rules the user can rely on (enforced in code, not only asked of the model):
//  * looking only: every question of the task is answered "no" by itself, so a scheduled task never clicks "buy",
//    "book", "send" or the like, never opens a bank, health or government site it was not allowed on before, and
//    stops where a sign-in, a payment or a CAPTCHA would be needed. No terminal, no project folder;
//  * it runs only while StarkLLM runs and is online, one task at a time, never while the user's own task runs;
//  * a run that was missed (the PC was off) runs once at the next start, not once per missed day.

const DAY = 24 * 60 * 60 * 1000;
const MAX_SCHEDULES = 20;

// "08:30" -> [8, 30]; anything else -> null
function parseTime(s) {
  const m = String(s || '').match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// a rule: { every: 'day' | 'week', time: 'HH:MM', weekday?: 0..6 (0 = Sunday) } -> the rule, cleaned, or null
function cleanRule(rule) {
  if (!rule || (rule.every !== 'day' && rule.every !== 'week')) return null;
  const t = parseTime(rule.time);
  if (!t) return null;
  const out = { every: rule.every, time: `${String(t[0]).padStart(2, '0')}:${String(t[1]).padStart(2, '0')}` };
  if (rule.every === 'week') {
    const w = Number(rule.weekday);
    if (!Number.isInteger(w) || w < 0 || w > 6) return null;
    out.weekday = w;
  }
  return out;
}

// The first time of the rule after `after` (a Date), in the PC's local time: daylight saving changes keep the clock
// time (08:00 stays 08:00).
function nextRun(rule, after) {
  const r = cleanRule(rule);
  if (!r) return null;
  const [h, m] = parseTime(r.time);
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
  for (let k = 0; k < 9; k++) {
    const c = new Date(candidate.getFullYear(), candidate.getMonth(), candidate.getDate() + k, h, m, 0, 0);
    if (c.getTime() <= after.getTime()) continue;
    if (r.every === 'week' && c.getDay() !== r.weekday) continue;
    return c;
  }
  return null;
}

// Which schedules are due now: the next run after their last run (or after they were made) is not in the future.
// A run missed while the PC was off is due once.
function dueSchedules(schedules, now) {
  return (schedules || []).filter((s) => {
    if (!s || s.enabled === false) return false;
    const since = new Date(s.lastRun || s.created || now.getTime());
    const next = nextRun(s.rule, since);
    return next && next.getTime() <= now.getTime();
  });
}

// Did the answer change since the last run? Numbers, words and order count; spaces, case and punctuation do not.
function normalize(answer) {
  return String(answer || '').toLowerCase().replace(/[\s.,;:!?"'„“”«»()[\]{}*_`-]+/g, ' ').trim();
}

function changed(previous, current) {
  if (previous == null || previous === '') return false; // the first run is not a change
  return normalize(previous) !== normalize(current);
}

// Every question of a scheduled task: "no". The task goes on without it or ends and says what was missing.
async function lookingOnlyAsk() {
  return { ok: false };
}

// A new schedule from the chat page: the task text and the rule, checked
function makeSchedule({ task, rule, model, language, workspaceId }, now = Date.now(), id = `s${now}`) {
  const text = String(task || '').trim().slice(0, 2000);
  const r = cleanRule(rule);
  if (!text || !r) return null;
  return {
    id,
    task: text,
    rule: r,
    model: String(model || '').slice(0, 200),
    language: String(language || '').slice(0, 10),
    workspaceId: Number(workspaceId) || null,
    created: now,
    enabled: true,
    lastRun: null,
    lastAnswer: '',
    lastStatus: '',
    changedAt: null,
    runs: [],
  };
}

// The result of a run kept with the schedule: the last answer, whether it changed, and the last ten runs
function recordRun(schedule, { status, answer, url }, now = Date.now()) {
  const isChange = status === 'done' && changed(schedule.lastAnswer, answer);
  const runs = [{ at: now, status, answer: String(answer || '').slice(0, 4000), url: String(url || ''), changed: isChange }, ...(schedule.runs || [])].slice(0, 10);
  return {
    ...schedule,
    lastRun: now,
    lastStatus: status,
    lastAnswer: status === 'done' ? String(answer || '').slice(0, 4000) : schedule.lastAnswer,
    changedAt: isChange ? now : schedule.changedAt,
    runs,
    isChange,
  };
}

module.exports = { parseTime, cleanRule, nextRun, dueSchedules, changed, normalize, lookingOnlyAsk, makeSchedule, recordRun, MAX_SCHEDULES, DAY };
