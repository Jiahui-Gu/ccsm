import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveClaudeBinary,
  parseCmdShim,
  classifyInvocation,
  quoteCmdArg,
  ClaudeNotFoundError,
  detectClaudeVersion,
} from '../binary-resolver';

// We test against the real `where` (Windows) / `which` (POSIX) command on
// PATH. Tests that need a guaranteed hit use AGENTORY_CLAUDE_BIN with a
// throwaway file in tmpdir.

const ORIGINAL_OVERRIDE = process.env.AGENTORY_CLAUDE_BIN;

describe('resolveClaudeBinary', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentory-resolver-'));
    delete process.env.AGENTORY_CLAUDE_BIN;
  });

  afterEach(() => {
    if (ORIGINAL_OVERRIDE === undefined) {
      delete process.env.AGENTORY_CLAUDE_BIN;
    } else {
      process.env.AGENTORY_CLAUDE_BIN = ORIGINAL_OVERRIDE;
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('returns the AGENTORY_CLAUDE_BIN override when it points at an existing file', async () => {
    const fake = join(tmpDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
    writeFileSync(fake, '#!/bin/sh\necho fake');
    process.env.AGENTORY_CLAUDE_BIN = fake;

    const got = await resolveClaudeBinary();
    expect(got).toBe(fake);
    expect(existsSync(got)).toBe(true);
  });

  it('throws when AGENTORY_CLAUDE_BIN points at a non-existent path', async () => {
    process.env.AGENTORY_CLAUDE_BIN = join(tmpDir, 'does-not-exist');
    await expect(resolveClaudeBinary()).rejects.toThrow(
      /AGENTORY_CLAUDE_BIN/
    );
  });

  it('throws an install hint when claude is not found on PATH', async () => {
    // Simulate "claude not on PATH" by emptying PATH for the duration of
    // the lookup. We restore it in `finally`.
    const savedPath = process.env.PATH;
    const savedPathExt = process.env.PATHEXT;
    const savedPathLower = process.env.path;
    process.env.PATH = '';
    process.env.path = '';
    if (process.platform === 'win32') {
      // Without PATHEXT `where` won't match .cmd/.exe even if it found one.
      process.env.PATHEXT = '';
    }
    try {
      await expect(resolveClaudeBinary()).rejects.toThrow(
        /Claude CLI not found.*npm i -g @anthropic-ai\/claude-code/
      );
    } finally {
      process.env.PATH = savedPath;
      if (savedPathLower !== undefined) process.env.path = savedPathLower;
      else delete process.env.path;
      if (savedPathExt !== undefined) process.env.PATHEXT = savedPathExt;
      else delete process.env.PATHEXT;
    }
  });

  it('throws ClaudeNotFoundError (not generic Error) with searchedPaths when PATH is scrubbed', async () => {
    const savedPath = process.env.PATH;
    const savedPathExt = process.env.PATHEXT;
    const savedPathLower = process.env.path;
    process.env.PATH = '';
    process.env.path = '';
    if (process.platform === 'win32') process.env.PATHEXT = '';
    try {
      let caught: unknown;
      try {
        await resolveClaudeBinary();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ClaudeNotFoundError);
      const err = caught as ClaudeNotFoundError;
      expect(err.code).toBe('CLAUDE_NOT_FOUND');
      expect(Array.isArray(err.searchedPaths)).toBe(true);
      expect(err.searchedPaths.length).toBeGreaterThan(0);
      // Should mention the lookup tool we attempted.
      const joined = err.searchedPaths.join(' ').toLowerCase();
      expect(joined).toMatch(/(where|which)/);
    } finally {
      process.env.PATH = savedPath;
      if (savedPathLower !== undefined) process.env.path = savedPathLower;
      else delete process.env.path;
      if (savedPathExt !== undefined) process.env.PATHEXT = savedPathExt;
      else delete process.env.PATHEXT;
    }
  });

  it('returns a full existing path when claude is on PATH (smoke test)', async () => {
    // This test is conditional: only runs if the test machine has claude
    // installed. CI containers without it will skip — that's fine.
    let probe: string | null;
    try {
      probe = await resolveClaudeBinary();
    } catch {
      return; // not installed, nothing to verify
    }
    expect(probe).toBeTruthy();
    expect(existsSync(probe!)).toBe(true);
    if (process.platform === 'win32') {
      // Must be a full path, not the bare name — otherwise spawn(no-shell)
      // would fail to find the .cmd shim.
      expect(probe!.toLowerCase()).toMatch(/[a-z]:[\\/]/);
    }
  });
});

describe('parseCmdShim', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentory-shim-'));
  });
  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('unwraps a native-binary forwarder shim (current claude-code 2.x layout)', () => {
    // Reproduce the real shim layout: `<dir>/claude.cmd` -> `<dir>/node_modules/.../claude.exe`
    const exePath = join(tmpDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    // mkdirSync via writeFileSync requires the dir exist; build it.
    mkdirSync(join(tmpDir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin'), { recursive: true });
    writeFileSync(exePath, 'fake-exe');
    const cmdPath = join(tmpDir, 'claude.cmd');
    writeFileSync(
      cmdPath,
      [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
        '',
      ].join('\r\n')
    );

    const got = parseCmdShim(cmdPath);
    expect(got).not.toBeNull();
    expect(got!.kind).toBe('direct');
    if (got!.kind === 'direct') {
      // Path should resolve to our fake .exe (case-insensitive on Windows).
      expect(got.path.toLowerCase()).toBe(exePath.toLowerCase());
    }
  });

  it('unwraps a node-script shim (older npm layout)', () => {
    mkdirSync(join(tmpDir, 'node_modules', 'foo', 'bin'), { recursive: true });
    const nodeExe = join(tmpDir, 'node.exe');
    writeFileSync(nodeExe, 'fake-node');
    const scriptPath = join(tmpDir, 'node_modules', 'foo', 'bin', 'cli.js');
    writeFileSync(scriptPath, '#!/usr/bin/env node\nconsole.log("hi")');
    const cmdPath = join(tmpDir, 'foo.cmd');
    writeFileSync(
      cmdPath,
      [
        '@ECHO off',
        'SETLOCAL',
        'SET dp0=%~dp0',
        '"%dp0%\\node.exe"  "%dp0%\\node_modules\\foo\\bin\\cli.js" %*',
      ].join('\r\n')
    );

    const got = parseCmdShim(cmdPath);
    expect(got).not.toBeNull();
    expect(got!.kind).toBe('node-script');
    if (got!.kind === 'node-script') {
      expect(got.node.toLowerCase()).toBe(nodeExe.toLowerCase());
      expect(got.script.toLowerCase()).toBe(scriptPath.toLowerCase());
    }
  });

  it('returns null for an unrecognized shim shape', () => {
    const cmdPath = join(tmpDir, 'weird.cmd');
    writeFileSync(cmdPath, '@echo hello world\r\n');
    expect(parseCmdShim(cmdPath)).toBeNull();
  });

  it('returns null when the .cmd file does not exist', () => {
    expect(parseCmdShim(join(tmpDir, 'missing.cmd'))).toBeNull();
  });
});

describe('classifyInvocation', () => {
  it('non-Windows: always returns direct', () => {
    if (process.platform === 'win32') return; // n/a on Windows
    expect(classifyInvocation('/usr/local/bin/claude')).toEqual({
      kind: 'direct',
      path: '/usr/local/bin/claude',
    });
  });

  it('Windows .exe: returns direct without parsing', () => {
    if (process.platform !== 'win32') return; // n/a off Windows
    const got = classifyInvocation('C:\\Program Files\\foo\\claude.exe');
    expect(got).toEqual({ kind: 'direct', path: 'C:\\Program Files\\foo\\claude.exe' });
  });

  it('Windows unrecognized .cmd: falls back to cmd-shell', () => {
    if (process.platform !== 'win32') return;
    const tmpDir = mkdtempSync(join(tmpdir(), 'agentory-classify-'));
    try {
      const cmd = join(tmpDir, 'weird.cmd');
      writeFileSync(cmd, '@echo nothing useful\r\n');
      const got = classifyInvocation(cmd);
      expect(got).toEqual({ kind: 'cmd-shell', path: cmd });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('quoteCmdArg', () => {
  it('wraps simple args in double quotes', () => {
    expect(quoteCmdArg('hello')).toBe('"hello"');
  });

  it('escapes embedded double quotes via backslash', () => {
    // Inner `"` becomes `\"`; surrounding caret-escape leaves the `\"` as-is.
    expect(quoteCmdArg('a"b')).toBe('"a\\"b"');
  });

  it('caret-escapes cmd.exe metacharacters', () => {
    const out = quoteCmdArg('a&b|c<d>e');
    expect(out).toContain('^&');
    expect(out).toContain('^|');
    expect(out).toContain('^<');
    expect(out).toContain('^>');
  });

  it('does not lose backslashes in normal paths', () => {
    expect(quoteCmdArg('C:\\foo\\bar')).toBe('"C:\\foo\\bar"');
  });

  it('handles trailing backslashes correctly (CRT rule)', () => {
    // `foo\` inside `"..."` would normally end the quoted region badly; we
    // double the trailing backslashes before the closing quote.
    expect(quoteCmdArg('foo\\')).toBe('"foo\\\\"');
  });
});

describe('detectClaudeVersion', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agentory-version-'));
  });
  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // We build fake "binaries" that emit a fixed stdout. On Windows we use a
  // .cmd script (detectClaudeVersion uses shell: true on Windows); on POSIX
  // we use a chmod +x shell script.
  function writeFakeBinary(stdout: string, exitCode: number = 0): string {
    if (process.platform === 'win32') {
      const p = join(tmpDir, 'fake.cmd');
      // `echo` in cmd prints the literal string; use multiple lines if needed.
      const lines = stdout.split('\n');
      const body = [
        '@echo off',
        ...lines.map((l) => `echo ${l}`),
        `exit /b ${exitCode}`,
      ].join('\r\n');
      writeFileSync(p, body);
      return p;
    }
    const p = join(tmpDir, 'fake.sh');
    writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' "${stdout.replace(/"/g, '\\"')}"\nexit ${exitCode}\n`);
    chmodSync(p, 0o755);
    return p;
  }

  it('parses a well-formed "2.1.3" output', async () => {
    const p = writeFakeBinary('2.1.3 (Claude Code)');
    const got = await detectClaudeVersion(p);
    expect(got).toBe('2.1.3');
  });

  it('parses a version embedded in a longer banner', async () => {
    const p = writeFakeBinary('claude-code v1.0.12 — build abc123');
    const got = await detectClaudeVersion(p);
    expect(got).toBe('1.0.12');
  });

  it('returns null when --version output has no semver token', async () => {
    const p = writeFakeBinary('hello world, no version here');
    const got = await detectClaudeVersion(p);
    expect(got).toBeNull();
  });

  it('returns null when the binary exits non-zero', async () => {
    const p = writeFakeBinary('2.0.0', 1);
    const got = await detectClaudeVersion(p);
    expect(got).toBeNull();
  });

  it('returns null for a non-existent path', async () => {
    const got = await detectClaudeVersion(join(tmpDir, 'does-not-exist'));
    expect(got).toBeNull();
  });
});
