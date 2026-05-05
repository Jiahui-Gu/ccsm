// packages/daemon/src/pty-host/__tests__/spawn-argv.spec.ts
//
// Unit tests for `computeSpawnArgv` (Task #436 coverage sweep).
// Pure decider — spec ch06 §1 (Windows `cmd /c chcp 65001 && claude.exe ...`
// chain; POSIX direct spawn).

import { describe, expect, it } from 'vitest';

import {
  computeSpawnArgv,
  DEFAULT_CLAUDE_BINARY_POSIX,
  DEFAULT_CLAUDE_BINARY_WIN32,
  WIN32_CODEPAGE_STEP,
} from '../spawn-argv.js';

describe('computeSpawnArgv — POSIX (linux/darwin)', () => {
  it('linux: returns claude + args directly with no shell wrapper', () => {
    const r = computeSpawnArgv({
      platform: 'linux',
      claudeArgs: ['--model', 'sonnet'],
    });
    expect(r.file).toBe(DEFAULT_CLAUDE_BINARY_POSIX);
    expect(r.file).toBe('claude');
    expect(r.args).toEqual(['--model', 'sonnet']);
  });

  it('darwin: returns claude + args directly', () => {
    const r = computeSpawnArgv({ platform: 'darwin', claudeArgs: [] });
    expect(r.file).toBe('claude');
    expect(r.args).toEqual([]);
  });

  it('honors a caller-provided binary override on POSIX', () => {
    const r = computeSpawnArgv({
      platform: 'linux',
      claudeArgs: ['-v'],
      claudeBinary: '/usr/local/bin/my-claude',
    });
    expect(r.file).toBe('/usr/local/bin/my-claude');
    expect(r.args).toEqual(['-v']);
  });

  it('returns a fresh args array (does not alias caller input)', () => {
    const input = ['--foo'];
    const r = computeSpawnArgv({ platform: 'linux', claudeArgs: input });
    expect(r.args).not.toBe(input);
    expect(r.args).toEqual(['--foo']);
  });

  it('treats unknown POSIX-like platforms (freebsd) as POSIX', () => {
    const r = computeSpawnArgv({
      platform: 'freebsd' as NodeJS.Platform,
      claudeArgs: ['x'],
    });
    expect(r.file).toBe('claude');
    expect(r.args).toEqual(['x']);
  });
});

describe('computeSpawnArgv — Windows', () => {
  it('wraps in cmd.exe /d /s /c with chcp 65001 chain', () => {
    const r = computeSpawnArgv({ platform: 'win32', claudeArgs: [] });
    expect(r.file).toBe('cmd.exe');
    expect(r.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(r.args[3]).toContain(WIN32_CODEPAGE_STEP);
    expect(r.args[3]).toContain('chcp 65001 >nul');
    expect(r.args[3]).toContain('claude.exe');
  });

  it('uses the default claude.exe binary name on Windows', () => {
    expect(DEFAULT_CLAUDE_BINARY_WIN32).toBe('claude.exe');
    const r = computeSpawnArgv({ platform: 'win32', claudeArgs: [] });
    // Quoted token form: "claude.exe"
    expect(r.args[3]).toMatch(/"claude\.exe"/);
  });

  it('quotes every argument in double quotes', () => {
    const r = computeSpawnArgv({
      platform: 'win32',
      claudeArgs: ['--model', 'sonnet'],
    });
    expect(r.args[3]).toMatch(/"claude\.exe" "--model" "sonnet"/);
  });

  it('escapes embedded double quotes as backslash-quote', () => {
    const r = computeSpawnArgv({
      platform: 'win32',
      claudeArgs: ['say "hi"'],
    });
    // Embedded `"` must become `\"`. The full token wraps in `"..."`.
    expect(r.args[3]).toContain('"say \\"hi\\""');
  });

  it('emits empty-string args as `""` (round-trip)', () => {
    const r = computeSpawnArgv({
      platform: 'win32',
      claudeArgs: [''],
    });
    // claude.exe followed by an empty quoted token
    expect(r.args[3]).toMatch(/"claude\.exe" ""/);
  });

  it('joins chcp + claude with `&&` so claude only runs on chcp success', () => {
    const r = computeSpawnArgv({ platform: 'win32', claudeArgs: [] });
    expect(r.args[3]).toMatch(/chcp 65001 >nul && "claude\.exe"/);
  });

  it('honors a caller-provided binary override on Windows', () => {
    const r = computeSpawnArgv({
      platform: 'win32',
      claudeArgs: [],
      claudeBinary: 'C:\\custom\\claude.exe',
    });
    // The custom binary appears quoted inside the chain.
    expect(r.args[3]).toContain('"C:\\custom\\claude.exe"');
  });
});
