// N48: the line(s) of a page an answer took its fact from. A source passage is a whole chunk, and a letter's first
// chunk starts with the letterhead and the address, so marking the start of the chunk showed the sender's address
// instead of "Bitte überweisen Sie ... 128,40 € bis zum 15.12.2026". The best line is the one that shares the most
// numbers (amounts, dates, reference numbers) and words with the answer; a sentence that runs on over the next lines
// is marked whole. Deterministic and cheap: no model, one pass over the lines of the page.

const NUMBER = /\d+(?:[.,:/]\d+)*/g;
const WORD = /\p{L}{5,}/gu;
const COMMON = new Set([
  'bitte', 'sowie', 'diese', 'dieser', 'diesem', 'einen', 'einer', 'eines', 'haben', 'werden', 'wurde', 'unter',
  'ihnen', 'ihrer', 'ihren', 'about', 'there', 'their', 'which', 'would', 'should', 'these', 'those', 'where',
]);

// "128,40" and "128.40" are the same amount, "15.12.2026" the same date; one or two digits ("19 %", "5") say too
// little to point at a line
function numbers(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(NUMBER)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 3 || (digits.length >= 2 && m[0] !== digits)) out.add(digits);
  }
  return out;
}

function words(text) {
  const out = new Set();
  for (const m of String(text || '').toLowerCase().matchAll(WORD)) if (!COMMON.has(m[0])) out.add(m[0]);
  return out;
}

function lines(text) {
  const out = [];
  let start = 0;
  for (const part of text.split('\n')) {
    out.push({ start, end: start + part.length, text: part });
    start += part.length + 1;
  }
  return out;
}

// a number shared with the answer counts four words: it is what the answer takes from a letter
function score(line, nums, wrds) {
  let n = 0;
  let w = 0;
  for (const x of numbers(line)) if (nums.has(x)) n += 1;
  for (const x of words(line)) if (wrds.has(x)) w += 1;
  return { n, value: n * 4 + w, ok: n > 0 || w >= 2 };
}

const ends = (s) => /[.!?:;]\s*$/.test(s);
const startsLower = (s) => /^\s*\p{Ll}/u.test(s);

function best(all, nums, wrds, from, to) {
  let pick = -1;
  let top = null;
  all.forEach((l, i) => {
    if (l.end < from || l.start > to || !l.text.trim()) return;
    const s = score(l.text, nums, wrds);
    if (s.ok && (!top || s.value > top.value)) {
      top = s;
      pick = i;
    }
  });
  return pick;
}

/** [start, end] of the line(s) of `text` the `answer` most likely took its fact from, or null when no line shares a
 * number or two words with it. `within` ([start, end], the cited chunk) is searched first, then the whole page. */
export function answerLineRange(text, answer, within = null) {
  if (!text || !answer) return null;
  const nums = numbers(answer);
  const wrds = words(answer);
  if (!nums.size && wrds.size < 2) return null;
  const all = lines(text);
  let i = within ? best(all, nums, wrds, within[0], within[1]) : -1;
  if (i < 0) i = best(all, nums, wrds, 0, text.length);
  if (i < 0) return null;
  // the whole sentence: lines before it it continues, and lines after it that continue it (at most two each way)
  let first = i;
  while (first > 0 && i - first < 2 && startsLower(all[first].text) && all[first - 1].text.trim() && !ends(all[first - 1].text)) first -= 1;
  let last = i;
  while (last < all.length - 1 && last - i < 2 && !ends(all[last].text) && startsLower(all[last + 1].text)) last += 1;
  let start = all[first].start;
  let end = all[last].end;
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  return [start, end];
}
