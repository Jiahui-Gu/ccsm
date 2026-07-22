// RED-first coverage: `buildLaunchOpts` (scripts/probe-helpers/harness-runner.mjs)
// is the shared env-builder for every themed harness driven through
// `runHarness` (`harness-dnd.mjs`, `harness-ui.mjs`), including cases
// gated by `requiresClaudeBin` that exercise the real `claude` binary
// inside the Electron app under test. Pins that the auto-updater guard
// reaches this second, independent launch seam too — `launchCcsmIsolated`
// alone would miss these harnesses entirely.
import { describe, test, expect, afterEach } from 'vitest';
import { buildLaunchOpts } from '../harness-runner.mjs';

describe('buildLaunchOpts (runHarness env seam)', () => {
  const ORIGINAL = process.env.DISABLE_AUTOUPDATER;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DISABLE_AUTOUPDATER;
    else process.env.DISABLE_AUTOUPDATER = ORIGINAL;
  });

  test('defaults DISABLE_AUTOUPDATER to "1" when unset', () => {
    delete process.env.DISABLE_AUTOUPDATER;
    const { env } = buildLaunchOpts({ name: 'fixture', cases: [] }, null);
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
  });

  test('honors a DISABLE_AUTOUPDATER already set in the parent shell', () => {
    process.env.DISABLE_AUTOUPDATER = '0';
    const { env } = buildLaunchOpts({ name: 'fixture', cases: [] }, null);
    expect(env.DISABLE_AUTOUPDATER).toBe('0');
  });

  test('an explicit spec.launch.env override still wins (intentional opt-in)', () => {
    delete process.env.DISABLE_AUTOUPDATER;
    const { env } = buildLaunchOpts(
      { name: 'fixture', cases: [], launch: { env: { DISABLE_AUTOUPDATER: 'caller-override' } } },
      null,
    );
    expect(env.DISABLE_AUTOUPDATER).toBe('caller-override');
  });
});
