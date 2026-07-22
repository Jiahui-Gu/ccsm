// RED-first coverage for the Claude Code auto-updater isolation guard.
//
// Bug context: on Windows, a real-Claude E2E run left
// `@anthropic-ai/claude-code/bin/claude.exe` replaced by
// `claude.exe.old.<timestamp>` while six already-running `claude`
// processes retained the deleted executable image — the CLI's own
// auto-updater fired mid-suite and clobbered the user's global install.
// Anthropic documents `DISABLE_AUTOUPDATER=1` as the supported opt-out.
//
// This test pins the single shared seam (`resolveAutoUpdaterEnv`) that
// every E2E entry point must funnel through so the guard can't be
// silently dropped by one caller forgetting to set the var.
import { describe, test, expect, afterEach } from 'vitest';
import { resolveAutoUpdaterEnv } from '../autoUpdaterGuard.mjs';

describe('resolveAutoUpdaterEnv', () => {
  const ORIGINAL = process.env.DISABLE_AUTOUPDATER;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DISABLE_AUTOUPDATER;
    else process.env.DISABLE_AUTOUPDATER = ORIGINAL;
  });

  test('defaults DISABLE_AUTOUPDATER to "1" when unset', () => {
    delete process.env.DISABLE_AUTOUPDATER;
    expect(resolveAutoUpdaterEnv()).toEqual({ DISABLE_AUTOUPDATER: '1' });
  });

  test('honors an explicit override already present in the environment', () => {
    process.env.DISABLE_AUTOUPDATER = '0';
    expect(resolveAutoUpdaterEnv()).toEqual({ DISABLE_AUTOUPDATER: '0' });
  });

  test('accepts an injected env object instead of reading process.env (pure/testable)', () => {
    expect(resolveAutoUpdaterEnv({})).toEqual({ DISABLE_AUTOUPDATER: '1' });
    expect(resolveAutoUpdaterEnv({ DISABLE_AUTOUPDATER: 'user-set' })).toEqual({
      DISABLE_AUTOUPDATER: 'user-set',
    });
  });
});
