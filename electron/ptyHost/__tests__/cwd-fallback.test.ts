// Validates the cwd resolution that gates `pty.spawn`. Bug #597 (dogfood):
// the 2nd new-session spawn failed with `error code:267` (Windows
// ERROR_DIRECTORY) because node-pty was handed a stale / non-existent path
// and surfaced it as a hard spawn failure. The fix in `electron/ptyHost`
// validates the requested cwd up front and falls back to the user's home
// directory; this test pins that contract so future refactors don't
// regress the bug class.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// node-pty + @xterm/headless + electron pull native deps that aren't
// available in the vitest jsdom env. The function under test has none of
// those dependencies — stub the heavy imports so just the helper loads.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('@xterm/headless', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-serialize', () => ({ SerializeAddon: class {} }));
vi.mock('electron', () => ({}));
vi.mock('../claudeResolver', () => ({ resolveClaude: () => null }));
vi.mock('../../sessionWatcher', () => ({
  sessionWatcher: { on: vi.fn(), startWatching: vi.fn(), stopWatching: vi.fn() },
}));
vi.mock('../../sessionWatcher/projectKey', () => ({ cwdToProjectKey: () => null }));

import { resolveSpawnCwd } from '../index';

describe('resolveSpawnCwd', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(pathJoin(tmpdir(), 'ccsm-cwd-fallback-'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
    vi.restoreAllMocks();
  });

  it('returns the requested path when it is an existing directory', () => {
    expect(resolveSpawnCwd(tmp)).toBe(tmp);
  });

  it('falls back to homedir when requested path is empty', () => {
    expect(resolveSpawnCwd('')).toBe(homedir());
  });

  it('falls back to homedir when requested path is null', () => {
    expect(resolveSpawnCwd(null)).toBe(homedir());
  });

  it('falls back to homedir when requested path is undefined', () => {
    expect(resolveSpawnCwd(undefined)).toBe(homedir());
  });

  it('falls back to homedir when requested path does not exist', () => {
    const ghost = pathJoin(tmp, 'does-not-exist-' + Date.now());
    expect(resolveSpawnCwd(ghost)).toBe(homedir());
    expect(console.warn).toHaveBeenCalled();
  });

  it('falls back to homedir when requested path is a file (not a directory)', () => {
    const file = pathJoin(tmp, 'a-file');
    writeFileSync(file, 'x');
    expect(resolveSpawnCwd(file)).toBe(homedir());
    expect(console.warn).toHaveBeenCalled();
  });

  it('falls back to homedir for the dogfood placeholder /tmp/no-group-cwd on Windows', () => {
    // Linux-style placeholder used in harness fixtures; Windows obviously
    // can't spawn into it. Repro of the user-visible bug (error code:267)
    // becomes a clean homedir fallback.
    expect(resolveSpawnCwd('/tmp/no-group-cwd')).toBe(homedir());
  });
});
