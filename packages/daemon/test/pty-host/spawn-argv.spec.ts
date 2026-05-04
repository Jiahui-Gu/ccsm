// Unit tests for the per-OS spawn ARGV contract — spec ch06 §1.
//
// FOREVER-STABLE per spec; every assertion here corresponds to a single
// shall-statement so a future spec edit shows up as a single failing
// test name. Tests pair with `spawn-env.spec.ts` (env side, T4.1).

import { describe, expect, it } from 'vitest';

import {
  computeSpawnArgv,
  DEFAULT_CLAUDE_BINARY_POSIX,
  DEFAULT_CLAUDE_BINARY_WIN32,
  WIN32_CODEPAGE_STEP,
} from '../../src/pty-host/spawn-argv.js';

describe('computeSpawnArgv — linux', () => {
  it('spawns claude directly with no shell wrapper', () => {
    const r = computeSpawnArgv({
      platform: 'linux',
      claudeArgs: ['--print', 'hi'],
    });
    expect(r.file).toBe('claude');
    expect(r.args).toEqual(['--print', 'hi']);
  });

  it('uses the default POSIX binary name', () => {
    const r = computeSpawnArgv({ platform: 'linux', claudeArgs: [] });
    expect(r.file).toBe(DEFAULT_CLAUDE_BINARY_POSIX);
  });

  it('honors a caller-provided absolute claude binary path', () => {
    const r = computeSpawnArgv({
      platform: 'linux',
      claudeArgs: ['--version'],
      claudeBinary: '/opt/anthropic/bin/claude',
    });
    expect(r.file).toBe('/opt/anthropic/bin/claude');
    expect(r.args).toEqual(['--version']);
  });

  it('returns an empty args array when claudeArgs is empty', () => {
    const r = computeSpawnArgv({ platform: 'linux', claudeArgs: [] });
    expect(r.args).toEqual([]);
  });
});

describe('computeSpawnArgv — darwin', () => {
  it('spawns claude directly with no shell wrapper', () => {
    const r = computeSpawnArgv({
      platform: 'darwin',
      claudeArgs: ['--print', 'hi'],
    });
    expect(r.file).toBe('claude');
    expect(r.args).toEqual(['--print', 'hi']);
  });
});

describe('computeSpawnArgv — win32', () => {
  it('wraps the spawn in cmd /d /s /c with chcp 65001 then claude.exe', () => {
    const r = computeSpawnArgv({
      platform: 'win32',
      claudeArgs: ['--print', 'hi'],
    });
    expect(r.file).toBe('cmd.exe');
    expect(r.args[0]).toBe('/d');
    expect(r.args[1]).toBe('/s');
    expect(r.args[2]).toBe('/c');
    // The chain is one single argument after /c.
    expect(r.args.length).toBe(4);
    expect(r.args[3]).toContain(WIN32_CODEPAGE_STEP);
    expect(r.args[3]).toContain('claude.exe');
    expect(r.args[3]).toContain('--print');
  });

  it('uses the default Windows binary name claude.exe', () => {
    const r = computeSpawnArgv({ platform: 'win32', claudeArgs: [] });
    expect(DEFAULT_CLAUDE_BINARY_WIN32).toBe('claude.exe');
    expect(r.args[3]).toContain('claude.exe');
  });

  it('chains chcp 65001 and claude with && (so claude only runs on chcp success)', () => {
    const r = computeSpawnArgv({ platform: 'win32', claudeArgs: [] });
    expect(r.args[3]).toMatch(/chcp 65001 >nul && /);
  });

  it('redirects chcp output to nul so the codepage banner does not pollute PTY', () => {
    const r = computeSpawnArgv({ platform: 'win32', claudeArgs: [] });
    expect(r.args[3]).toContain('>nul');
  });

  it('quotes claude args containing spaces', () => {
    const r = computeSpawnArgv({
      platform: 'win32',
      claudeArgs: ['--prompt', 'hello world with spaces'],
    });
    expect(r.args[3]).toContain('"hello world with spaces"');
  });

  it('escapes embedded double-quotes inside args as \\"', () => {
    const r = computeSpawnArgv({
      platform: 'win32',
      claudeArgs: ['--prompt', 'say "hi"'],
    });
    expect(r.args[3]).toContain('"say \\"hi\\""');
  });

  it('quotes empty args as ""', () => {
    const r = computeSpawnArgv({
      platform: 'win32',
      claudeArgs: [''],
    });
    // The empty arg must round-trip as "" so claude.exe sees an empty
    // positional rather than the arg disappearing.
    expect(r.args[3]).toMatch(/claude\.exe.*""/);
  });

  it('honors a caller-provided absolute claude binary path', () => {
    const r = computeSpawnArgv({
      platform: 'win32',
      claudeArgs: ['--version'],
      claudeBinary: 'C:\\Program Files\\Anthropic\\claude.exe',
    });
    // The custom binary lands inside the cmd /c chain, quoted (because
    // the path contains a space).
    expect(r.args[3]).toContain('"C:\\Program Files\\Anthropic\\claude.exe"');
  });

  it('returns exactly 4 args (the cmd /c chain is a single token)', () => {
    // Critical invariant: cmd.exe's `/c` consumes the rest of the
    // command line as ONE string (with `/s` stripping outer quotes).
    // Splitting the chain into multiple args would change cmd's parsing.
    const r = computeSpawnArgv({
      platform: 'win32',
      claudeArgs: ['--a', 'b', '--c', 'd'],
    });
    expect(r.args.length).toBe(4);
  });
});

describe('computeSpawnArgv — exported constants', () => {
  it('POSIX default binary is claude', () => {
    expect(DEFAULT_CLAUDE_BINARY_POSIX).toBe('claude');
  });

  it('Windows default binary is claude.exe', () => {
    expect(DEFAULT_CLAUDE_BINARY_WIN32).toBe('claude.exe');
  });

  it('Windows codepage step is exactly `chcp 65001 >nul` (UTF-8 + silent)', () => {
    expect(WIN32_CODEPAGE_STEP).toBe('chcp 65001 >nul');
  });
});

describe('computeSpawnArgv — platform symmetry', () => {
  it('linux and darwin produce identical shape (no shell wrapper)', () => {
    const lin = computeSpawnArgv({ platform: 'linux', claudeArgs: ['x'] });
    const mac = computeSpawnArgv({ platform: 'darwin', claudeArgs: ['x'] });
    expect(lin).toEqual(mac);
  });

  it('win32 differs from POSIX in both file and args (shell wrapper required)', () => {
    const lin = computeSpawnArgv({ platform: 'linux', claudeArgs: ['x'] });
    const win = computeSpawnArgv({ platform: 'win32', claudeArgs: ['x'] });
    expect(win.file).not.toBe(lin.file);
    expect(win.args).not.toEqual(lin.args);
  });
});
