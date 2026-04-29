// Pins the import-resume copy contract that fixes #603. When the user
// imports a JSONL whose recorded cwd no longer exists, `resolveSpawnCwd`
// falls back to homedir, the spawn cwd's projectKey then mismatches the
// JSONL's actual location, and `claude --resume <sid>` exits with
// "No conversation found" — leaving the right pane blank. The fix copies
// the JSONL into `<projectsRoot>/<cwdToProjectKey(spawnCwd)>/<sid>.jsonl`
// so claude finds it without ever reaching the missing-cwd case.
//
// We mock the heavy imports (node-pty, headless terminal, electron, etc.)
// the same way `cwd-fallback.test.ts` does so the helper loads in jsdom.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('@xterm/headless', () => ({ Terminal: class {} }));
vi.mock('@xterm/addon-serialize', () => ({ SerializeAddon: class {} }));
vi.mock('electron', () => ({}));
vi.mock('../claudeResolver', () => ({ resolveClaude: () => null }));
vi.mock('../../sessionWatcher', () => ({
  sessionWatcher: { on: vi.fn(), startWatching: vi.fn(), stopWatching: vi.fn() },
}));
// Real projectKey encoding — the helper depends on the round-trip between
// the spawn cwd and the projectDir name, so a stub would defeat the test.
vi.mock('../../sessionWatcher/projectKey', async () => {
  return {
    cwdToProjectKey: (cwd: string) =>
      typeof cwd === 'string' && cwd.length > 0 ? cwd.replace(/[\\/:]/g, '-') : '',
  };
});

import { ensureResumeJsonlAtSpawnCwd } from '../index';

describe('ensureResumeJsonlAtSpawnCwd (#603)', () => {
  let tmp: string;
  let originalCfg: string | undefined;
  let originalHome: string | undefined;
  let originalUserprofile: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(pathJoin(tmpdir(), 'ccsm-import-resume-'));
    originalCfg = process.env.CLAUDE_CONFIG_DIR;
    originalHome = process.env.HOME;
    originalUserprofile = process.env.USERPROFILE;
    // Pin the projects root to a tmp dir so the test never touches the
    // real `~/.claude/projects/`.
    process.env.CLAUDE_CONFIG_DIR = tmp;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalCfg;
    if (originalHome !== undefined) process.env.HOME = originalHome;
    if (originalUserprofile !== undefined) process.env.USERPROFILE = originalUserprofile;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
    vi.restoreAllMocks();
  });

  function seedSourceJsonl(projectDirName: string, sid: string, body: string): string {
    const dir = pathJoin(tmp, 'projects', projectDirName);
    mkdirSync(dir, { recursive: true });
    const file = pathJoin(dir, `${sid}.jsonl`);
    writeFileSync(file, body, 'utf8');
    return file;
  }

  it('copies the source JSONL into the projectDir matching spawn cwd', () => {
    const sid = '003080a4-09c8-4fb4-a79a-4ec6cbf4ba28';
    // Source lives under the originally-recorded cwd's projectDir.
    const source = seedSourceJsonl('C--old-deleted-project', sid, '{"type":"user"}\n');
    // User's spawn cwd: homedir fallback, encodes to a different projectKey.
    const spawnCwd = 'C:\\Users\\jiahuigu';
    const expectedProjectDir = 'C--Users-jiahuigu';
    const expectedTarget = pathJoin(tmp, 'projects', expectedProjectDir, `${sid}.jsonl`);

    ensureResumeJsonlAtSpawnCwd(sid, spawnCwd, source);

    const st = statSync(expectedTarget);
    expect(st.isFile()).toBe(true);
    expect(st.size).toBeGreaterThan(0);
    expect(readFileSync(expectedTarget, 'utf8')).toBe('{"type":"user"}\n');
  });

  it('is a no-op when source is already at the target path', () => {
    const sid = 'aaaa1111-2222-4333-8444-555566667777';
    // Source lives at exactly the path the spawn cwd resolves to → no copy.
    const spawnCwd = 'C:\\Users\\jiahuigu';
    const projectDir = 'C--Users-jiahuigu';
    const source = seedSourceJsonl(projectDir, sid, '{"type":"user"}\n');

    ensureResumeJsonlAtSpawnCwd(sid, spawnCwd, source);

    // File untouched, only the one we seeded.
    const st = statSync(source);
    expect(st.isFile()).toBe(true);
  });

  it('does not overwrite an existing destination JSONL', () => {
    const sid = 'bbbb2222-3333-4444-8555-666677778888';
    const source = seedSourceJsonl('C--old-deleted-project', sid, '{"src":"original"}\n');
    const spawnCwd = 'C:\\Users\\jiahuigu';
    const targetDir = pathJoin(tmp, 'projects', 'C--Users-jiahuigu');
    mkdirSync(targetDir, { recursive: true });
    const target = pathJoin(targetDir, `${sid}.jsonl`);
    // Pretend the CLI already wrote a continuation here — we must not clobber it.
    writeFileSync(target, '{"existing":"do-not-touch"}\n', 'utf8');

    ensureResumeJsonlAtSpawnCwd(sid, spawnCwd, source);

    expect(readFileSync(target, 'utf8')).toBe('{"existing":"do-not-touch"}\n');
  });

  it('bails silently when projectsRoot is unresolvable', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.HOME;
    delete process.env.USERPROFILE;
    const sid = 'cccc3333-4444-4555-8666-777788889999';
    const source = pathJoin(tmp, 'src.jsonl');
    writeFileSync(source, 'x', 'utf8');

    // No throw — just a quiet no-op (caller logs at warn-level instead).
    expect(() =>
      ensureResumeJsonlAtSpawnCwd(sid, 'C:\\Users\\jiahuigu', source),
    ).not.toThrow();
  });
});
