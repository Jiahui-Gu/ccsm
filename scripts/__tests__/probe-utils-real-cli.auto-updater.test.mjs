// RED-first coverage: `launchCcsmIsolated` (scripts/probe-utils-real-cli.mjs)
// is the shared launcher every `harness-e2e-*.mjs` real-Claude harness and
// most `dogfood-*.mjs` / `screenshot-*.mjs` scripts use to boot the prod
// Electron bundle. Its env becomes `process.env` inside the Electron main
// process, which `electron/ptyHost/entryFactory.ts` passes verbatim to the
// spawned `claude` binary. This test pins that the auto-updater guard
// (`DISABLE_AUTOUPDATER`) always lands in that launch env, defaults to '1',
// and can still be overridden by an explicit caller `env` override (the
// existing `CCSM_E2E_HIDDEN` precedent).
//
// `buildIsolatedLaunchEnv` is the pure, extracted env-builder used inside
// `launchCcsmIsolated` — testing it directly avoids needing a real
// Electron/Playwright launch.
import { describe, test, expect, afterEach } from 'vitest';
import { buildIsolatedLaunchEnv } from '../probe-utils-real-cli.mjs';

describe('buildIsolatedLaunchEnv (launchCcsmIsolated env seam)', () => {
  const ORIGINAL = process.env.DISABLE_AUTOUPDATER;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DISABLE_AUTOUPDATER;
    else process.env.DISABLE_AUTOUPDATER = ORIGINAL;
  });

  test('defaults DISABLE_AUTOUPDATER to "1" when unset in the parent shell', () => {
    delete process.env.DISABLE_AUTOUPDATER;
    const env = buildIsolatedLaunchEnv({ tempDir: 'C:/tmp/fake' });
    expect(env.DISABLE_AUTOUPDATER).toBe('1');
  });

  test('honors a DISABLE_AUTOUPDATER already set in the parent shell', () => {
    process.env.DISABLE_AUTOUPDATER = '0';
    const env = buildIsolatedLaunchEnv({ tempDir: 'C:/tmp/fake' });
    expect(env.DISABLE_AUTOUPDATER).toBe('0');
  });

  test('an explicit caller env override still wins (intentional opt-in)', () => {
    delete process.env.DISABLE_AUTOUPDATER;
    const env = buildIsolatedLaunchEnv({
      tempDir: 'C:/tmp/fake',
      env: { DISABLE_AUTOUPDATER: 'caller-override' },
    });
    expect(env.DISABLE_AUTOUPDATER).toBe('caller-override');
  });

  test('does not disturb the existing isolated-config-dir env quartet', () => {
    const env = buildIsolatedLaunchEnv({ tempDir: 'C:/tmp/fake' });
    expect(env.CCSM_CLAUDE_CONFIG_DIR).toBe('C:/tmp/fake');
    expect(env.CLAUDE_CONFIG_DIR).toBe('C:/tmp/fake');
    expect(env.HOME).toBe('C:/tmp/fake');
    expect(env.USERPROFILE).toBe('C:/tmp/fake');
  });
});
