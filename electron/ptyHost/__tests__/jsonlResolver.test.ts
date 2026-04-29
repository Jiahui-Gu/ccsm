// Pure-function tests for jsonlResolver — extracted from
// electron/ptyHost/index.ts in Task #729 Phase A. These pin the
// CLAUDE_CONFIG_DIR-vs-HOME root precedence, the projectKey round-trip,
// and the import-resume copy-into-place semantics that fix #603.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real projectKey encoding — these helpers depend on the round-trip between
// the spawn cwd and the projectDir name, so a stub would defeat the test.
vi.mock('../../sessionWatcher/projectKey', () => {
  return {
    cwdToProjectKey: (cwd: string) =>
      typeof cwd === 'string' && cwd.length > 0 ? cwd.replace(/[\\/:]/g, '-') : '',
  };
});

import {
  ensureResumeJsonlAtSpawnCwd,
  findJsonlForSid,
  jsonlExistsForSid,
  resolveJsonlPath,
  resolveProjectsRoot,
  toClaudeSid,
} from '../jsonlResolver';

let tmp: string;
let originalCfg: string | undefined;
let originalHome: string | undefined;
let originalUserprofile: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(pathJoin(tmpdir(), 'ccsm-jsonl-resolver-'));
  originalCfg = process.env.CLAUDE_CONFIG_DIR;
  originalHome = process.env.HOME;
  originalUserprofile = process.env.USERPROFILE;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  delete process.env.HOME;
  delete process.env.USERPROFILE;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  if (originalCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalCfg;
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  if (originalUserprofile !== undefined) process.env.USERPROFILE = originalUserprofile;
  else delete process.env.USERPROFILE;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  vi.restoreAllMocks();
});

function seedJsonl(projectDirName: string, sid: string, body = '{"x":1}\n'): string {
  const dir = pathJoin(tmp, 'projects', projectDirName);
  mkdirSync(dir, { recursive: true });
  const file = pathJoin(dir, `${sid}.jsonl`);
  writeFileSync(file, body, 'utf8');
  return file;
}

describe('toClaudeSid', () => {
  it('returns existing UUID v4 lowercased', () => {
    const id = '003080A4-09C8-4FB4-A79A-4EC6CBF4BA28';
    expect(toClaudeSid(id)).toBe('003080a4-09c8-4fb4-a79a-4ec6cbf4ba28');
  });

  it('produces a valid UUID v4 for arbitrary string', () => {
    const out = toClaudeSid('ccsm-session-abc');
    expect(out).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is deterministic across calls', () => {
    expect(toClaudeSid('ccsm-session-foo')).toBe(toClaudeSid('ccsm-session-foo'));
  });

  it('produces different outputs for different inputs', () => {
    expect(toClaudeSid('ccsm-session-foo')).not.toBe(toClaudeSid('ccsm-session-bar'));
  });

  // #804 risk #6: sid is argv to `pty.spawn`. Reject anything outside
  // [a-zA-Z0-9_-]{8,64} so a hostile renderer cannot smuggle `--dangerous-flag`
  // or empty-string into the CLI as a positional arg.
  it('rejects empty string', () => {
    expect(() => toClaudeSid('')).toThrow(/invalid sid/);
  });

  it('rejects too-short sid', () => {
    expect(() => toClaudeSid('abc')).toThrow(/invalid sid/);
  });

  it('rejects too-long sid (>64 chars)', () => {
    expect(() => toClaudeSid('a'.repeat(65))).toThrow(/invalid sid/);
  });

  it('rejects sid containing argv-injection characters', () => {
    expect(() => toClaudeSid('--dangerous-flag')).toThrow(/invalid sid/);
    expect(() => toClaudeSid('sid with space')).toThrow(/invalid sid/);
    expect(() => toClaudeSid('sid;rm-rf/')).toThrow(/invalid sid/);
  });

  it('rejects non-string inputs', () => {
    expect(() => toClaudeSid(undefined as unknown as string)).toThrow(/invalid sid/);
    expect(() => toClaudeSid(null as unknown as string)).toThrow(/invalid sid/);
    expect(() => toClaudeSid(42 as unknown as string)).toThrow(/invalid sid/);
  });
});

describe('findJsonlForSid', () => {
  it('returns the jsonl path under CLAUDE_CONFIG_DIR/projects', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const file = seedJsonl('C--Users-foo', sid);
    expect(findJsonlForSid(sid)).toBe(file);
  });

  it('returns null when no transcript exists anywhere', () => {
    expect(findJsonlForSid('nonexistent-sid-zzz')).toBeNull();
  });

  it('skips zero-byte files (empty-file race)', () => {
    const sid = 'cccccccc-bbbb-4aaa-8ddd-eeeeeeeeeeee';
    const dir = pathJoin(tmp, 'projects', 'C--proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(pathJoin(dir, `${sid}.jsonl`), '');
    expect(findJsonlForSid(sid)).toBeNull();
  });

  it('finds the first match when multiple project dirs contain the sid', () => {
    const sid = 'ddddeeee-1111-4222-8333-444455556666';
    seedJsonl('C--first', sid);
    seedJsonl('C--second', sid);
    const found = findJsonlForSid(sid);
    expect(found).not.toBeNull();
    expect(found!.endsWith(`${sid}.jsonl`)).toBe(true);
  });

  it('returns null when projects root does not exist', () => {
    // tmp has no `projects/` subdir yet.
    expect(findJsonlForSid('whatever-sid')).toBeNull();
  });

  it('falls back to HOME/.claude/projects when CLAUDE_CONFIG_DIR not set', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = tmp;
    const sid = 'eeeeffff-1111-4222-8333-444455556666';
    const dir = pathJoin(tmp, '.claude', 'projects', 'C--proj');
    mkdirSync(dir, { recursive: true });
    const file = pathJoin(dir, `${sid}.jsonl`);
    writeFileSync(file, 'x', 'utf8');
    expect(findJsonlForSid(sid)).toBe(file);
  });
});

describe('jsonlExistsForSid', () => {
  it('returns true when the file exists', () => {
    const sid = 'ffff0000-1111-4222-8333-444455556666';
    seedJsonl('C--proj', sid);
    expect(jsonlExistsForSid(sid)).toBe(true);
  });

  it('returns false when no file exists', () => {
    expect(jsonlExistsForSid('missing-sid-yyy')).toBe(false);
  });

  it('returns false for zero-byte file', () => {
    const sid = '00001111-2222-4333-8444-555566667777';
    const dir = pathJoin(tmp, 'projects', 'C--proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(pathJoin(dir, `${sid}.jsonl`), '');
    expect(jsonlExistsForSid(sid)).toBe(false);
  });

  it('mirrors findJsonlForSid (true exactly when path is non-null)', () => {
    const sid = '11112222-3333-4444-8555-666677778888';
    expect(jsonlExistsForSid(sid)).toBe(false);
    seedJsonl('C--proj', sid);
    expect(jsonlExistsForSid(sid)).toBe(true);
  });

  it('handles missing root gracefully', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    expect(jsonlExistsForSid('any-sid')).toBe(false);
  });
});

describe('resolveJsonlPath', () => {
  it('returns the canonical path under projects/<projectKey>/', () => {
    const sid = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    const out = resolveJsonlPath(sid, 'C:\\Users\\foo');
    expect(out).toBe(pathJoin(tmp, 'projects', 'C--Users-foo', `${sid}.jsonl`));
  });

  it('returns null when projectKey is empty', () => {
    expect(resolveJsonlPath('any-sid', '')).toBeNull();
  });

  it('falls back to HOME/.claude when CLAUDE_CONFIG_DIR not set', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = tmp;
    const out = resolveJsonlPath('s', 'C:\\Users\\foo');
    expect(out).toBe(pathJoin(tmp, '.claude', 'projects', 'C--Users-foo', 's.jsonl'));
  });

  it('returns null when neither CLAUDE_CONFIG_DIR nor HOME nor USERPROFILE set', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    expect(resolveJsonlPath('s', 'C:\\Users\\foo')).toBeNull();
  });

  it('does not require the file to exist (parent watcher waits for create)', () => {
    const out = resolveJsonlPath('not-yet-written', 'C:\\Users\\foo');
    expect(out).not.toBeNull();
    expect(() => statSync(out!)).toThrow();
  });
});

describe('resolveProjectsRoot', () => {
  it('returns CLAUDE_CONFIG_DIR/projects when set', () => {
    expect(resolveProjectsRoot()).toBe(pathJoin(tmp, 'projects'));
  });

  it('falls back to HOME/.claude/projects', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = tmp;
    expect(resolveProjectsRoot()).toBe(pathJoin(tmp, '.claude', 'projects'));
  });

  it('falls back to USERPROFILE/.claude/projects when HOME unset', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.USERPROFILE = tmp;
    expect(resolveProjectsRoot()).toBe(pathJoin(tmp, '.claude', 'projects'));
  });

  it('returns null when nothing is set', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    expect(resolveProjectsRoot()).toBeNull();
  });

  it('prefers CLAUDE_CONFIG_DIR over HOME', () => {
    process.env.HOME = pathJoin(tmp, 'home');
    expect(resolveProjectsRoot()).toBe(pathJoin(tmp, 'projects'));
  });
});

describe('ensureResumeJsonlAtSpawnCwd', () => {
  it('copies the source JSONL into projectDir matching spawn cwd', () => {
    const sid = 'a0a0a0a0-1111-4222-8333-444455556666';
    const source = seedJsonl('C--old-deleted-project', sid, '{"type":"user"}\n');
    const spawnCwd = 'C:\\Users\\jiahuigu';
    const result = ensureResumeJsonlAtSpawnCwd(sid, spawnCwd, source);
    expect(result.copied).toBe(true);
    const expected = pathJoin(tmp, 'projects', 'C--Users-jiahuigu', `${sid}.jsonl`);
    expect(result.targetPath).toBe(expected);
    expect(readFileSync(expected, 'utf8')).toBe('{"type":"user"}\n');
  });

  it('is a no-op when source already lives at the target', () => {
    const sid = 'b1b1b1b1-2222-4333-8444-555566667777';
    const spawnCwd = 'C:\\Users\\jiahuigu';
    const source = seedJsonl('C--Users-jiahuigu', sid);
    const result = ensureResumeJsonlAtSpawnCwd(sid, spawnCwd, source);
    expect(result.copied).toBe(false);
    expect(result.targetPath).toBe(source);
  });

  it('does not overwrite an existing destination JSONL', () => {
    const sid = 'c2c2c2c2-3333-4444-8555-666677778888';
    const source = seedJsonl('C--old', sid, '{"src":"original"}\n');
    const targetDir = pathJoin(tmp, 'projects', 'C--Users-jiahuigu');
    mkdirSync(targetDir, { recursive: true });
    const target = pathJoin(targetDir, `${sid}.jsonl`);
    writeFileSync(target, '{"existing":"do-not-touch"}\n', 'utf8');
    const result = ensureResumeJsonlAtSpawnCwd(sid, 'C:\\Users\\jiahuigu', source);
    expect(result.copied).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('{"existing":"do-not-touch"}\n');
  });

  it('returns null targetPath when projectsRoot unresolvable', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    const result = ensureResumeJsonlAtSpawnCwd('any', 'C:\\Users\\x', '/nope');
    expect(result).toEqual({ copied: false, targetPath: null });
  });

  it('returns null targetPath when projectKey is empty', () => {
    const result = ensureResumeJsonlAtSpawnCwd('any', '', '/nope');
    expect(result).toEqual({ copied: false, targetPath: null });
  });
});
