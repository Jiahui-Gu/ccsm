// Pure-function tests for cwdResolver — extracted from
// electron/ptyHost/index.ts in Task #729 Phase A. Pins the
// requested-vs-fallback contract that prevents Windows error code:267
// (ERROR_DIRECTORY) from reaching the user as a CLI crash.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveSpawnCwd } from '../cwdResolver';
import { log } from '../../shared/log';

let tmp: string;
let eventSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmp = mkdtempSync(pathJoin(tmpdir(), 'ccsm-cwd-resolver-'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  eventSpy = vi.spyOn(log, 'event').mockImplementation(() => {});
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  vi.restoreAllMocks();
});

describe('resolveSpawnCwd', () => {
  it('returns the requested path when it is an existing directory', () => {
    expect(resolveSpawnCwd(tmp)).toBe(tmp);
    expect(eventSpy).not.toHaveBeenCalled();
  });

  it('falls back to homedir when requested path is empty', () => {
    expect(resolveSpawnCwd('')).toBe(homedir());
    expect(eventSpy).toHaveBeenCalledWith(
      'cwd.empty_fallback',
      expect.objectContaining({ reason: 'empty' }),
    );
  });

  it('falls back to homedir when requested path is null/undefined', () => {
    expect(resolveSpawnCwd(null)).toBe(homedir());
    expect(eventSpy).toHaveBeenCalledWith(
      'cwd.empty_fallback',
      expect.objectContaining({ reason: 'null' }),
    );
    eventSpy.mockClear();
    expect(resolveSpawnCwd(undefined)).toBe(homedir());
    expect(eventSpy).toHaveBeenCalledWith(
      'cwd.empty_fallback',
      expect.objectContaining({ reason: 'undefined' }),
    );
  });

  it('forwards sid into the empty-fallback event payload when provided', () => {
    expect(resolveSpawnCwd('', 'sid-abc')).toBe(homedir());
    expect(eventSpy).toHaveBeenCalledWith(
      'cwd.empty_fallback',
      expect.objectContaining({ sid: 'sid-abc', reason: 'empty' }),
    );
  });

  it('falls back to homedir when requested path does not exist (and warns)', () => {
    const ghost = pathJoin(tmp, 'does-not-exist-' + Date.now());
    expect(resolveSpawnCwd(ghost)).toBe(homedir());
    expect(console.warn).toHaveBeenCalled();
  });

  it('falls back to homedir when requested path is a file (and warns)', () => {
    const file = pathJoin(tmp, 'a-file');
    writeFileSync(file, 'x');
    expect(resolveSpawnCwd(file)).toBe(homedir());
    expect(console.warn).toHaveBeenCalled();
  });

  // #804 risk #1: UNC paths must be rejected BEFORE statSync — otherwise
  // statSync('\\\\evil\\share') triggers an SMB handshake that leaks the
  // user's NTLM hash to the named host.
  it('rejects UNC cwd (backslash) without statSync, falls back to homedir', () => {
    expect(resolveSpawnCwd('\\\\evil-host\\share\\probe')).toBe(homedir());
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('rejected by isSafePath'),
    );
  });

  it('rejects UNC cwd (forward slash) without statSync', () => {
    expect(resolveSpawnCwd('//evil-host/share/probe')).toBe(homedir());
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('rejected by isSafePath'),
    );
  });

  it('rejects relative cwd without statSync', () => {
    expect(resolveSpawnCwd('relative/path')).toBe(homedir());
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('rejected by isSafePath'),
    );
  });
});
