// First start: the user is asked once whether StarkLLM is fully offline. node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createGuard } = require('../netguard');
const { askOfflineChoice, TEXTS } = require('../offline-choice');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'starkllm-ask-'));
const dialogAnswering = (response, seen = []) => ({ showMessageBox: async (parent, options) => { seen.push(options); return { response }; } });

test('the first start asks, and staying online is the default', async () => {
  const dir = tmp();
  const seen = [];
  const g = createGuard({ dir });
  assert.strictEqual(await askOfflineChoice({ dialog: dialogAnswering(0, seen), guard: g }), true);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].defaultId, 0, 'the preselected button is "stay online"');
  assert.strictEqual(seen[0].cancelId, 0, 'closing the window means "stay online"');
  assert.match(seen[0].buttons[0], /online/i);
  assert.match(seen[0].buttons[1], /offline/i);
  assert.strictEqual(g.isOffline(), false);
  assert.strictEqual(g.hasAsked(), true);
});

test('going fully offline is saved and survives a restart', async () => {
  const dir = tmp();
  await askOfflineChoice({ dialog: dialogAnswering(1), guard: createGuard({ dir }) });
  const again = createGuard({ dir });
  assert.strictEqual(again.isOffline(), true);
  assert.strictEqual(again.hasAsked(), true);
});

test('it asks only once: not at the next start, not after the user changed the switch', async () => {
  const dir = tmp();
  await askOfflineChoice({ dialog: dialogAnswering(0), guard: createGuard({ dir }) });
  const seen = [];
  const next = createGuard({ dir });
  assert.strictEqual(await askOfflineChoice({ dialog: dialogAnswering(1, seen), guard: next }), false);
  assert.deepStrictEqual(seen, []);
  assert.strictEqual(next.isOffline(), false, 'a second answer is never applied');
  next.setOffline(true); // later, in Settings
  assert.strictEqual(createGuard({ dir }).hasAsked(), true, 'changing the switch keeps the "asked" mark');
  assert.strictEqual(createGuard({ dir }).isOffline(), true);
});

test('a user who turned the switch on before is not asked again after an update', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'privacy.json'), JSON.stringify({ offline: true, asked: true }));
  const seen = [];
  assert.strictEqual(await askOfflineChoice({ dialog: dialogAnswering(0, seen), guard: createGuard({ dir }) }), false);
  assert.deepStrictEqual(seen, []);
});

test('the question is in English or German, by the language of the system', async () => {
  for (const [locale, key] of [['en-US', 'en'], ['de', 'de'], ['de-AT', 'de'], ['fr', 'en']]) {
    const seen = [];
    await askOfflineChoice({ dialog: dialogAnswering(0, seen), guard: createGuard({ dir: null }), locale });
    assert.strictEqual(seen[0].message, TEXTS[key].message, locale);
  }
  assert.match(TEXTS.de.message, /offline/);
  assert.match(TEXTS.de.detail, /Datenschutz & Netzwerk/);
  assert.match(TEXTS.en.detail, /Privacy & network/);
});

test('STARKLLM_ASK_OFFLINE=0 skips the question (installer smoke test, administrators) and asks nothing later by itself', async () => {
  const dir = tmp();
  const seen = [];
  assert.strictEqual(await askOfflineChoice({ dialog: dialogAnswering(1, seen), guard: createGuard({ dir }), env: { STARKLLM_ASK_OFFLINE: '0' } }), false);
  assert.deepStrictEqual(seen, []);
  assert.strictEqual(createGuard({ dir }).isOffline(), false);
  assert.strictEqual(createGuard({ dir }).hasAsked(), false, 'the user is still asked once when the variable is not set');
});

test('the engine of the first start is started with the answer', () => {
  // main.js asks before it starts the engine; the engine gets STARKLLM_OFFLINE from the same switch
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(main.indexOf('askOfflineChoice({') < main.indexOf('startAndLoad();', main.indexOf('askOfflineChoice({')));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'engine.js'), 'utf8'), /STARKLLM_OFFLINE: guard\.isOffline\(\) \? '1' : ''/);
});
