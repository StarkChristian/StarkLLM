// What happens when the user is asked for the start-up passphrase (docs/encryption-design.md, "Optional passphrase").
// The passphrase exists only in the call that carries it: it is turned into a key (scrypt), the key goes to the engine, nothing
// is stored or logged. Wrong guesses are slowed down (250 ms, then twice as long each time, at most 8 s) on top of scrypt's cost.
// The recovery key opens the data key without the passphrase and then switches the passphrase off (the user can set a new one).
function createUnlockFlow({ keys, unlockEngine, onUnlocked = async () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxDelayMs = 8000 }) {
  let wrong = 0;
  const slow = () => sleep(Math.min(250 * 2 ** (wrong - 1), maxDelayMs));

  return {
    attempts: () => wrong,

    async submit(passphrase) {
      if (!passphrase) return { error: 'passphrase-needed', message: 'Enter your passphrase.' };
      const r = await unlockEngine(String(passphrase));
      if (r && r.ok) {
        wrong = 0;
        await onUnlocked();
        return { ok: true };
      }
      if (r && r.error === 'wrong-passphrase') {
        wrong += 1;
        await slow();
        return { ...r, attempts: wrong };
      }
      return r || { error: 'failed', message: 'The engine did not answer.' };
    },

    async recover(recoveryKey) {
      try {
        keys.recover(recoveryKey);
      } catch (e) {
        if (e.code === 'bad-recovery-key' || e.code === 'wrong-recovery-key') {
          wrong += 1;
          await slow();
        }
        return { error: e.code || 'failed', message: e.message, attempts: wrong };
      }
      const r = await unlockEngine();
      if (r && r.ok) {
        wrong = 0;
        await onUnlocked();
        return { ok: true, passphraseOff: true };
      }
      return r || { error: 'failed', message: 'The engine did not answer.' };
    }
  };
}

module.exports = { createUnlockFlow };
