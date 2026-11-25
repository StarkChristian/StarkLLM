// 2.5.0 acceptance test: a waiting web task survives a chat switch; a repeated follow-up keeps what it is about;
// a web-task chat is named after its task at once
import test from 'node:test';
import assert from 'node:assert/strict';
import { previousWebTask, selfContainedTask, withLiveTask, isUntitledChat, chatTitleOf } from '../src/utils/webTask.js';

test('the chat of a waiting web task gets its question and card back, whatever type the id has', () => {
  const live = { id: 'webtask-1', chatId: 7, user: { role: 'user', content: 'Termin' }, card: { role: 'assistant', content: '', liveId: 'webtask-1', webTask: { status: 'running', ask: { qid: 'q1', kind: 'question', text: 'Welcher Tag?' } } } };
  const greeting = [{ role: 'assistant', content: 'Chat loaded.', greeting: true }];
  const back = withLiveTask(greeting, live, 7);
  assert.equal(back.length, 2);
  assert.equal(back[1].webTask.ask.text, 'Welcher Tag?');
  assert.equal(withLiveTask(greeting, live, '7').length, 2);
  assert.equal(withLiveTask(greeting, live, 8), greeting, 'another chat stays as it is');
  assert.equal(withLiveTask(greeting, null, 7), greeting);
  // never twice
  assert.equal(withLiveTask([live.user, live.card], live, 7).filter((m) => m.liveId).length, 1);
});

test('a follow-up saved or repeated carries the task it follows', () => {
  assert.equal(selfContainedTask('und nächste Woche?', null, 'Anschlussfrage:'), 'und nächste Woche?');
  assert.equal(selfContainedTask('und nächste Woche?', { task: 'Öffnungszeiten des Bürgerservice Aachen', answer: 'Mo–Fr 8–12' }, 'Anschlussfrage:'),
    'Öffnungszeiten des Bürgerservice Aachen\n\nAnschlussfrage: und nächste Woche?');
  // a follow-up of a follow-up keeps the whole chain
  const msgs = [
    { role: 'user', content: 'und nächste Woche?' },
    { role: 'assistant', content: 'Di 9–12', webTask: { status: 'done', answer: 'Di 9–12', fullTask: 'Öffnungszeiten Aachen\n\nAnschlussfrage: und nächste Woche?' } },
  ];
  assert.equal(previousWebTask([{ role: 'assistant', content: 'hi' }, ...msgs]).task, 'Öffnungszeiten Aachen\n\nAnschlussfrage: und nächste Woche?');
});

test('a web-task chat is named after its task', () => {
  assert.ok(isUntitledChat('New Chat') && isUntitledChat('') && isUntitledChat('Untitled Chat'));
  assert.ok(!isUntitledChat('Öffnungszeiten'));
  assert.equal(chatTitleOf('  Suche   die Öffnungszeiten\n des Bürgerservice in Aachen und sag mir, wann am Samstag offen ist  '),
    'Suche die Öffnungszeiten des Bürgerservice in Aach');
});
