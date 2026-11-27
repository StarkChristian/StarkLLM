import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sortWarnings } from '../src/utils/documentWarnings.js';

const kinds = (list) => list.map((w) => `${w.kind}:${w.file || w.sender}`);

test('a note to AI assistants alone is a caution, not a scam warning', () => {
  const { serious, cautions, notes } = sortWarnings([{ kind: 'ai_instructions', file: 'letter-en.png' }]);
  assert.deepEqual(kinds(serious), []);
  assert.deepEqual(kinds(cautions), ['ai_instructions:letter-en.png']);
  assert.deepEqual(notes, []);
});

test('hidden text alone is a caution too', () => {
  const { serious, cautions } = sortWarnings([{ kind: 'hidden_text', file: 'a.pdf' }]);
  assert.deepEqual(kinds(serious), []);
  assert.deepEqual(kinds(cautions), ['hidden_text:a.pdf']);
});

test('real signs of a scam keep the red warning, with the note of the same file', () => {
  const { serious, cautions } = sortWarnings([
    { kind: 'ai_instructions', file: 'Mahnung.pdf' },
    { kind: 'scam_signs', file: 'Mahnung.pdf', signs: ['foreign_account_authority'] },
    { kind: 'ai_instructions', file: 'letter-en.png' },
  ]);
  assert.deepEqual(kinds(serious), ['ai_instructions:Mahnung.pdf', 'scam_signs:Mahnung.pdf']);
  assert.deepEqual(kinds(cautions), ['ai_instructions:letter-en.png']);
});

test('bank account findings stay where they were', () => {
  const { serious, notes } = sortWarnings([{ kind: 'accounts', sender: 'X' }, { kind: 'account_change', sender: 'Y' }]);
  assert.deepEqual(kinds(serious), ['accounts:X']);
  assert.deepEqual(kinds(notes), ['account_change:Y']);
});

test('the caution texts are translated in every language and never say scam', () => {
  const keys = [
    '{file} contains a note addressed to AI assistants. StarkLLM ignored it. Such notes are unusual in real letters: before you pay, check the letter with the sender through contact details you already know (not the ones printed in it).',
    '{file} contains text that cannot be seen on the page (white, tiny or invisible characters). StarkLLM left it out. Such text is unusual in real letters: before you pay, check the letter with the sender through contact details you already know (not the ones printed in it).',
    'Check before paying: the letter contains a note to AI assistants or hidden text',
    'Check before paying',
  ];
  const scamWord = { de: /betrug/i, es: /estafa/i, fr: /arnaque|escroquerie/i, it: /truffa/i, tr: /dolandırıcılık/i };
  for (const key of keys) assert.doesNotMatch(key, /scam/i);
  for (const lang of Object.keys(scamWord)) {
    const dict = JSON.parse(fs.readFileSync(new URL(`../src/i18n/${lang}.json`, import.meta.url), 'utf8'));
    for (const key of keys) {
      assert.ok(dict[key], `${lang}: ${key}`);
      assert.doesNotMatch(dict[key], scamWord[lang], `${lang}: ${dict[key]}`);
    }
  }
});
