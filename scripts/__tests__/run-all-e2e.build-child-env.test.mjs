// RED-first coverage: `buildChildEnv` (scripts/run-all-e2e.mjs) is the env
// the full-suite runner gives to EVERY spawned `node <harness-or-probe>.mjs`
// child. Whatever that child's own launch seam (launchCcsmIsolated /
// buildLaunchOpts) does, this is defense-in-depth so a full `npm run
// probe:e2e` run can never lose the auto-updater guard even if a future
// harness bypasses both shared launchers and shells out to `claude`
// directly from the child process's own env.
//
// Importing `run-all-e2e.mjs` must NOT execute the suite (no readdirSync
// side effects that block/loop) — the module guards its real entry point
// behind an `isMainModule` check so it's safely importable for unit tests.
import { describe, test, expect, afterEach } from 'vitest';
import { buildChildEnv } from '../run-all-e2e.mjs';

describe('buildChildEnv (run-all-e2e full-suite child env seam)', () => {
  const ORIGINAL = process.env.DISABLE_AUTOUPDATER;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DISABLE_AUTOUPDATER;
    else process.env.DISABLE_AUTOUPDATER = ORIGINAL;
  });

  test('defaults DISABLE_AUTOUPDATER to "1" when unset', () => {
    delete process.env.DISABLE_AUTOUPDATER;
    const env = buildChildEnv(process.env);
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
  });

  test('honors a DISABLE_AUTOUPDATER already set in the parent shell', () => {
    process.env.DISABLE_AUTOUPDATER = '0';
    const env = buildChildEnv(process.env);
    expect(env.DISABLE_AUTOUPDATER).toBe('0');
  });
});
