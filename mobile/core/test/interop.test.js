// The committed fixture must equal what the current code generates (so nobody edits it by hand or
// changes the wire format silently). The fixture itself is verified against an independent Noise
// implementation by test/interop/verify_fixture.py (run in CI, see .github/workflows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFixture } from '../scripts/generate-interop-fixture.mjs';

test('interop fixture is up to date with the code', () => {
  const committed = JSON.parse(readFileSync(new URL('./interop/fixture.json', import.meta.url), 'utf8'));
  assert.deepEqual(buildFixture(), committed, 'run `npm run interop:generate` and review the diff');
});
