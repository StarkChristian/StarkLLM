import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spokenText, chatAnnouncement } from '../src/utils/announce.js';

const text = { writing: 'StarkLLM is writing the answer…', answer: 'Answer: {answer}' };

test('the spoken answer has no Markdown marks, links or code', () => {
  const md = '## Result\n\nAccording to **[letter.png](doc://1)**, pay `120 EUR`.\n\n- by 15 December\n\n```js\nx()\n```';
  assert.equal(spokenText(md), 'Result According to letter.png, pay 120 EUR. by 15 December');
});

test('tool calls are not read aloud', () => {
  assert.equal(spokenText('Looking.\n<tool_call>{"name":"x"}</tool_call>\nDone.'), 'Looking. Done.');
});

test('a long answer is cut at a word', () => {
  const s = spokenText('word '.repeat(100), 30);
  assert.ok(s.length <= 32 && s.endsWith('…'), s);
});

test('one line when the answer starts and one when it is finished, nothing per token', () => {
  assert.equal(chatAnnouncement(false, true, { role: 'user', content: 'Hi' }, text), text.writing);
  assert.equal(chatAnnouncement(true, true, { role: 'assistant', content: 'Hel' }, text), null);
  assert.equal(chatAnnouncement(true, false, { role: 'assistant', content: 'Hello **you**' }, text), 'Answer: Hello you');
  assert.equal(chatAnnouncement(true, false, { role: 'assistant', isError: true, content: 'The model is not running.' }, text), 'The model is not running.');
  assert.equal(chatAnnouncement(false, false, { role: 'assistant', content: 'old' }, text), null);
});
