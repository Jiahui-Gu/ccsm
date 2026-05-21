// UT for electron/import-scanner.ts — exercises the JSONL → ScannableSession
// pipeline using a real on-disk fixture tree under a per-test tmp dir.
//
// Coverage targets the import flow's data contract:
//   1. Missing `~/.claude/projects` → empty result, no throw
//   2. Malformed JSONL lines → skipped (not fatal)
//   3. Empty / metadata-less transcripts → dropped (resolve(null) path)
//   4. Sidechain/sub-agent transcripts → filtered out
//   5. Sort order — newest mtime first
//   6. ccsm/agentory temp-cwd noise filter
//   7. Title fallback: aiTitle > firstUserText > "(untitled session)"
//   8. <command-...> wrapped first user lines do NOT become titles
//   9. parseHead pure helper edge cases
//  10. deriveRecentCwds: frequency-then-recency ranking + `~` skip
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  scanImportableSessions,
  parseHead,
  deriveRecentCwds,
  isCCSMTempCwd,
  isSidechainFrame,
} from '../import-scanner';

let tmpRoot: string;
let projectsDir: string;
let savedEnv: string | undefined;

function mkProject(projectKey: string): string {
  const dir = path.join(projectsDir, projectKey);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJsonl(file: string, lines: Array<unknown | string>) {
  const body = lines
    .map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
    .join('\n');
  fs.writeFileSync(file, body);
}

function setMtime(file: string, ms: number) {
  const t = ms / 1000;
  fs.utimesSync(file, t, t);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-import-scanner-test-'));
  projectsDir = path.join(tmpRoot, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  savedEnv = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmpRoot;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('scanImportableSessions', () => {
  it('returns [] (does not throw) when the projects dir is missing', async () => {
    fs.rmSync(projectsDir, { recursive: true, force: true });
    const out = await scanImportableSessions();
    expect(out).toEqual([]);
  });

  it('returns [] when the projects dir is empty', async () => {
    const out = await scanImportableSessions();
    expect(out).toEqual([]);
  });

  it('returns [] when only non-jsonl files are present', async () => {
    const dir = mkProject('-Users-foo-proj');
    fs.writeFileSync(path.join(dir, 'README.md'), 'hi');
    const out = await scanImportableSessions();
    expect(out).toEqual([]);
  });

  it('extracts cwd, title, mtime, projectDir from a well-formed transcript', async () => {
    const dir = mkProject('-Users-foo-proj');
    const file = path.join(dir, 'sess-A.jsonl');
    writeJsonl(file, [
      { cwd: '/Users/foo/proj', type: 'meta' },
      { type: 'user', message: { content: 'hello world' } },
      { type: 'ai-title', aiTitle: 'Greeting' },
      { type: 'assistant', message: { model: 'claude-3-5-sonnet' } },
    ]);
    setMtime(file, 1_700_000_000_000);

    const out = await scanImportableSessions();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sessionId: 'sess-A',
      cwd: '/Users/foo/proj',
      title: 'Greeting', // aiTitle wins
      projectDir: '-Users-foo-proj',
      model: 'claude-3-5-sonnet',
    });
    expect(out[0].mtime).toBeGreaterThan(0);
  });

  it('falls back to first user text when no aiTitle frame is present', async () => {
    const dir = mkProject('-tmp-foo');
    const file = path.join(dir, 'sess-B.jsonl');
    writeJsonl(file, [
      { cwd: '/Users/foo/work', type: 'meta' },
      { type: 'user', message: { content: 'do the thing please' } },
    ]);
    const out = await scanImportableSessions();
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('do the thing please');
  });

  it('skips <command-...> wrapped user lines when picking a title fallback', async () => {
    const dir = mkProject('-tmp-foo2');
    const file = path.join(dir, 'sess-C.jsonl');
    writeJsonl(file, [
      { cwd: '/Users/foo/work', type: 'meta' },
      { type: 'user', message: { content: '<command-name>compact</command-name>' } },
      { type: 'user', message: { content: 'real prompt here' } },
    ]);
    const out = await scanImportableSessions();
    expect(out[0].title).toBe('real prompt here');
  });

  it('uses "(untitled session)" when only cwd is present', async () => {
    const dir = mkProject('-Users-foo-empty');
    const file = path.join(dir, 'sess-D.jsonl');
    writeJsonl(file, [{ cwd: '/Users/foo/empty', type: 'meta' }]);
    const out = await scanImportableSessions();
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('(untitled session)');
  });

  it('drops a transcript whose head has no cwd, title, user-text, or model', async () => {
    const dir = mkProject('-Users-foo-junk');
    const file = path.join(dir, 'sess-E.jsonl');
    writeJsonl(file, [{ type: 'meta', extra: 1 }]);
    const out = await scanImportableSessions();
    expect(out).toEqual([]);
  });

  it('drops sub-agent (sidechain) transcripts', async () => {
    const dir = mkProject('-Users-foo-side');
    const file = path.join(dir, 'sess-F.jsonl');
    writeJsonl(file, [
      { isSidechain: true, cwd: '/Users/foo/side' },
      { type: 'user', message: { content: 'inside subagent' } },
    ]);
    const out = await scanImportableSessions();
    expect(out).toEqual([]);
  });

  it('drops transcripts whose first frame has a non-empty parentUuid', async () => {
    const dir = mkProject('-Users-foo-side2');
    const file = path.join(dir, 'sess-G.jsonl');
    writeJsonl(file, [
      { parentUuid: 'parent-1', cwd: '/Users/foo/side2', type: 'meta' },
    ]);
    const out = await scanImportableSessions();
    expect(out).toEqual([]);
  });

  it('skips malformed JSON lines but still returns subsequent valid frames', async () => {
    const dir = mkProject('-Users-foo-mal');
    const file = path.join(dir, 'sess-H.jsonl');
    // Mix of garbage + valid lines. The garbage line must NOT abort parsing.
    writeJsonl(file, [
      'this-is-not-json{{{',
      { cwd: '/Users/foo/mal', type: 'meta' },
      'another}garbage',
      { type: 'user', message: { content: 'survived parsing' } },
    ]);
    const out = await scanImportableSessions();
    expect(out).toHaveLength(1);
    expect(out[0].cwd).toBe('/Users/foo/mal');
    expect(out[0].title).toBe('survived parsing');
  });

  it('drops empty (0-byte) jsonl files without throwing', async () => {
    const dir = mkProject('-Users-foo-empty2');
    fs.writeFileSync(path.join(dir, 'sess-I.jsonl'), '');
    // Plus one valid sibling to confirm the empty file is silently skipped
    // and the valid one still surfaces.
    const ok = path.join(dir, 'sess-J.jsonl');
    writeJsonl(ok, [
      { cwd: '/Users/foo/empty2', type: 'meta' },
      { type: 'ai-title', aiTitle: 'Valid' },
    ]);
    const out = await scanImportableSessions();
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe('sess-J');
  });

  it('filters out our own ccsm-* / agentory-* temp-dir cwds', async () => {
    const dir = mkProject('-tmp-noise');
    const noisy = path.join(dir, 'sess-K.jsonl');
    writeJsonl(noisy, [
      { cwd: `${os.tmpdir()}/ccsm-spawn-abc`, type: 'meta' },
      { type: 'ai-title', aiTitle: 'Noise' },
    ]);
    const real = path.join(dir, 'sess-L.jsonl');
    writeJsonl(real, [
      { cwd: '/Users/foo/realwork', type: 'meta' },
      { type: 'ai-title', aiTitle: 'Real' },
    ]);
    const out = await scanImportableSessions();
    const titles = out.map((s) => s.title).sort();
    expect(titles).toEqual(['Real']);
  });

  it('sorts results by mtime desc (newest first)', async () => {
    const dir = mkProject('-Users-foo-sort');
    const a = path.join(dir, 'old.jsonl');
    const b = path.join(dir, 'new.jsonl');
    writeJsonl(a, [
      { cwd: '/Users/foo/sort', type: 'meta' },
      { type: 'ai-title', aiTitle: 'old' },
    ]);
    writeJsonl(b, [
      { cwd: '/Users/foo/sort', type: 'meta' },
      { type: 'ai-title', aiTitle: 'new' },
    ]);
    setMtime(a, 1_600_000_000_000);
    setMtime(b, 1_700_000_000_000);

    const out = await scanImportableSessions();
    expect(out.map((s) => s.sessionId)).toEqual(['new', 'old']);
  });

  it('walks across multiple project directories', async () => {
    const d1 = mkProject('-Users-foo-p1');
    const d2 = mkProject('-Users-foo-p2');
    writeJsonl(path.join(d1, 'a.jsonl'), [
      { cwd: '/Users/foo/p1', type: 'meta' },
      { type: 'ai-title', aiTitle: 'p1' },
    ]);
    writeJsonl(path.join(d2, 'b.jsonl'), [
      { cwd: '/Users/foo/p2', type: 'meta' },
      { type: 'ai-title', aiTitle: 'p2' },
    ]);
    const out = await scanImportableSessions();
    expect(out.map((s) => s.projectDir).sort()).toEqual([
      '-Users-foo-p1',
      '-Users-foo-p2',
    ]);
  });

  it('honors a runtime CLAUDE_CONFIG_DIR mutation between calls', async () => {
    // First call: original tmpRoot, populated.
    const d = mkProject('-Users-foo-run1');
    writeJsonl(path.join(d, 'a.jsonl'), [
      { cwd: '/Users/foo/run1', type: 'meta' },
      { type: 'ai-title', aiTitle: 'r1' },
    ]);
    const first = await scanImportableSessions();
    expect(first).toHaveLength(1);

    // Second call: redirect to an empty tmp.
    const altRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-import-scanner-alt-'));
    try {
      process.env.CLAUDE_CONFIG_DIR = altRoot;
      const second = await scanImportableSessions();
      expect(second).toEqual([]);
    } finally {
      process.env.CLAUDE_CONFIG_DIR = tmpRoot; // restore for afterEach
      fs.rmSync(altRoot, { recursive: true, force: true });
    }
  });
});

describe('parseHead', () => {
  it('returns null on a head with no useful fields', () => {
    expect(parseHead([JSON.stringify({ type: 'noise' })])).toBeNull();
  });

  it('returns null on a sidechain first frame', () => {
    expect(
      parseHead([
        JSON.stringify({ isSidechain: true, cwd: '/x' }),
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      ])
    ).toBeNull();
  });

  it('skips malformed lines and continues', () => {
    const head = parseHead([
      'garbage',
      JSON.stringify({ cwd: '/x' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'T' }),
    ]);
    expect(head).toEqual({ cwd: '/x', title: 'T', model: null });
  });

  it('uses "~" as cwd fallback when none was found but other fields exist', () => {
    const head = parseHead([JSON.stringify({ type: 'ai-title', aiTitle: 'T' })]);
    expect(head).toEqual({ cwd: '~', title: 'T', model: null });
  });

  it('extracts model from message.model on assistant frames', () => {
    const head = parseHead([
      JSON.stringify({ cwd: '/x' }),
      JSON.stringify({ type: 'assistant', message: { model: 'opus' } }),
    ]);
    expect(head?.model).toBe('opus');
  });

  it('accepts top-level `model` as a fallback', () => {
    const head = parseHead([
      JSON.stringify({ cwd: '/x', model: 'sonnet' }),
    ]);
    expect(head?.model).toBe('sonnet');
  });

  it('extracts user text from array-content messages', () => {
    const head = parseHead([
      JSON.stringify({ cwd: '/x' }),
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: 'array form' }] },
      }),
    ]);
    expect(head?.title).toBe('array form');
  });

  it('truncates long titles', () => {
    const long = 'x'.repeat(200);
    const head = parseHead([
      JSON.stringify({ cwd: '/x' }),
      JSON.stringify({ type: 'user', message: { content: long } }),
    ]);
    expect(head?.title.length).toBeLessThanOrEqual(80);
    expect(head?.title.endsWith('…')).toBe(true);
  });
});

describe('isSidechainFrame', () => {
  it('flags frames with isSidechain:true', () => {
    expect(isSidechainFrame({ isSidechain: true })).toBe(true);
  });
  it('flags frames with non-empty parentUuid', () => {
    expect(isSidechainFrame({ parentUuid: 'p' })).toBe(true);
  });
  it('does NOT flag normal frames with parentUuid:null', () => {
    expect(isSidechainFrame({ parentUuid: null })).toBe(false);
  });
  it('does NOT flag non-objects', () => {
    expect(isSidechainFrame(null)).toBe(false);
    expect(isSidechainFrame('x')).toBe(false);
  });
});

describe('isCCSMTempCwd', () => {
  it('matches a ccsm-prefixed segment under os.tmpdir()', () => {
    expect(isCCSMTempCwd(path.join(os.tmpdir(), 'ccsm-A1', 'sub'))).toBe(true);
  });
  it('matches the legacy agentory-* prefix', () => {
    expect(isCCSMTempCwd(path.join(os.tmpdir(), 'agentory-X', 'q'))).toBe(true);
  });
  it('matches /tmp/ccsm-* even when os.tmpdir() differs (macOS aliasing)', () => {
    expect(isCCSMTempCwd('/tmp/ccsm-foo/bar')).toBe(true);
  });
  it('matches /var/folders/.../ccsm-* prefix', () => {
    expect(isCCSMTempCwd('/var/folders/aa/bb/T/ccsm-foo')).toBe(true);
  });
  it('matches Windows AppData\\Local\\Temp\\ccsm-* (case-insensitive)', () => {
    expect(
      isCCSMTempCwd('C:/Users/me/AppData/Local/Temp/ccsm-foo')
    ).toBe(true);
    expect(
      isCCSMTempCwd('C:\\Users\\me\\AppData\\Local\\Temp\\ccsm-foo')
    ).toBe(true);
  });
  it('does not match a user-named path that contains "agentory"', () => {
    expect(isCCSMTempCwd('/Users/me/projects/my-agentory-fork')).toBe(false);
  });
  it('does not match a normal cwd outside any temp root', () => {
    expect(isCCSMTempCwd('/Users/me/proj')).toBe(false);
  });
  it('returns false for empty / non-string inputs', () => {
    expect(isCCSMTempCwd('')).toBe(false);
    // @ts-expect-error — exercising the runtime guard
    expect(isCCSMTempCwd(undefined)).toBe(false);
  });
});

describe('deriveRecentCwds', () => {
  it('returns [] for empty input', () => {
    expect(deriveRecentCwds([])).toEqual([]);
  });

  it('drops "~" placeholder cwds', () => {
    expect(
      deriveRecentCwds([
        { cwd: '~', mtime: 5 },
        { cwd: '~', mtime: 4 },
      ])
    ).toEqual([]);
  });

  it('ranks by frequency in the recent window, ties broken by recency', () => {
    const out = deriveRecentCwds([
      { cwd: '/a', mtime: 10 },
      { cwd: '/a', mtime: 9 },
      { cwd: '/a', mtime: 8 },
      { cwd: '/b', mtime: 7 },
      { cwd: '/b', mtime: 6 },
      { cwd: '/c', mtime: 5 },
    ]);
    expect(out).toEqual(['/a', '/b', '/c']);
  });

  it('respects the windowSize bound — older entries do not contribute', () => {
    // window=2: only the two newest contribute. /a wins 2-0 over /b even
    // though /b dominates the long tail.
    const out = deriveRecentCwds(
      [
        { cwd: '/a', mtime: 10 },
        { cwd: '/a', mtime: 9 },
        { cwd: '/b', mtime: 8 },
        { cwd: '/b', mtime: 7 },
        { cwd: '/b', mtime: 6 },
      ],
      10,
      2
    );
    expect(out).toEqual(['/a']);
  });

  it('respects the max bound', () => {
    const sessions = Array.from({ length: 5 }, (_, i) => ({
      cwd: `/p${i}`,
      mtime: 100 - i,
    }));
    expect(deriveRecentCwds(sessions, 2)).toEqual(['/p0', '/p1']);
  });
});
