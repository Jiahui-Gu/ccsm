// packages/daemon/src/importScanner/__tests__/scan-importable-sessions.spec.ts
//
// Unit tests for `scanImportableSessions` (Task #436 coverage sweep).
// The pure helpers (`parseHead`, `deriveRecentCwds`, `isSidechainFrame`,
// `isCCSMTempCwd`) are covered in `import-scanner.spec.ts`. This file
// drives the actual filesystem scanner against a tmpdir tree pointed to
// via `CLAUDE_CONFIG_DIR`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanImportableSessions } from '../import-scanner.js';

const j = (o: unknown) => JSON.stringify(o);

let tmpDir: string;
let projectsDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ccsm-import-scanner-'));
  projectsDir = join(tmpDir, 'projects');
  originalEnv = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalEnv;
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(projectName: string, sessionId: string, lines: unknown[]): void {
  const projDir = join(projectsDir, projectName);
  mkdirSync(projDir, { recursive: true });
  writeFileSync(
    join(projDir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n'),
    'utf8',
  );
}

describe('scanImportableSessions', () => {
  it('returns [] when projects root does not exist', async () => {
    // CLAUDE_CONFIG_DIR points at tmpDir but we never created `projects/`.
    const out = await scanImportableSessions();
    expect(out).toEqual([]);
  });

  it('returns [] for an empty projects root', async () => {
    mkdirSync(projectsDir);
    expect(await scanImportableSessions()).toEqual([]);
  });

  it('lists a single jsonl session with an ai-title', async () => {
    writeJsonl('proj-a', 'sid-1', [
      { type: 'user', cwd: '/work/proj-a', message: { content: 'hi' } },
      { type: 'ai-title', aiTitle: 'A nice run' },
    ]);
    const out = await scanImportableSessions();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sessionId: 'sid-1',
      cwd: '/work/proj-a',
      title: 'A nice run',
      projectDir: 'proj-a',
    });
    expect(typeof out[0].mtime).toBe('number');
  });

  it('skips non-.jsonl files in a project directory', async () => {
    const projDir = join(projectsDir, 'proj-b');
    mkdirSync(projDir, { recursive: true });
    writeFileSync(join(projDir, 'README.md'), 'noise', 'utf8');
    writeFileSync(
      join(projDir, 'sid-2.jsonl'),
      j({ type: 'ai-title', aiTitle: 'real session', cwd: '/x' }),
      'utf8',
    );
    const out = await scanImportableSessions();
    expect(out.map((s) => s.sessionId)).toEqual(['sid-2']);
  });

  it('drops sub-agent transcripts (parentUuid set on first frame)', async () => {
    writeJsonl('proj-c', 'sub-agent', [
      {
        type: 'user',
        cwd: '/x',
        parentUuid: 'parent-1',
        message: { content: 'sub-agent prompt' },
      },
    ]);
    writeJsonl('proj-c', 'normal', [
      { type: 'user', cwd: '/x', message: { content: 'normal' } },
      { type: 'ai-title', aiTitle: 'normal title' },
    ]);
    const out = await scanImportableSessions();
    expect(out.map((s) => s.sessionId).sort()).toEqual(['normal']);
  });

  it('drops CCSM temp cwds via the heuristic', async () => {
    const realCwd = '/home/user/work/realproj';
    // Pick a temp prefix that the cross-platform `isCCSMTempCwd` rules
    // (POSIX `/tmp/...`) match unconditionally.
    const tempCwd = '/tmp/ccsm-bugl-bash-fixture';
    writeJsonl('proj-d', 'real', [
      { type: 'ai-title', aiTitle: 'real', cwd: realCwd },
    ]);
    writeJsonl('proj-d', 'tempspawn', [
      { type: 'ai-title', aiTitle: 'temp', cwd: tempCwd },
    ]);
    const out = await scanImportableSessions();
    expect(out.map((s) => s.cwd)).toEqual([realCwd]);
  });

  it('sorts results by mtime descending (most-recent first)', async () => {
    writeJsonl('proj-e', 'older', [
      { type: 'ai-title', aiTitle: 'older', cwd: '/o' },
    ]);
    // Wait so mtimes are distinct.
    await new Promise((r) => setTimeout(r, 20));
    writeJsonl('proj-e', 'newer', [
      { type: 'ai-title', aiTitle: 'newer', cwd: '/n' },
    ]);
    const out = await scanImportableSessions();
    expect(out.map((s) => s.sessionId)).toEqual(['newer', 'older']);
  });

  it('extracts model from an assistant frame', async () => {
    writeJsonl('proj-f', 'sid-model', [
      { type: 'user', cwd: '/x', message: { content: 'hi' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello' }],
          model: 'claude-haiku-4.5',
        },
      },
    ]);
    const out = await scanImportableSessions();
    expect(out[0].model).toBe('claude-haiku-4.5');
  });

  it('continues past unreadable / malformed jsonl files', async () => {
    const projDir = join(projectsDir, 'proj-g');
    mkdirSync(projDir, { recursive: true });
    // Empty file → readHead resolves null → entry skipped.
    writeFileSync(join(projDir, 'empty.jsonl'), '', 'utf8');
    // Valid file in same dir.
    writeFileSync(
      join(projDir, 'valid.jsonl'),
      j({ type: 'ai-title', aiTitle: 'survives', cwd: '/x' }),
      'utf8',
    );
    const out = await scanImportableSessions();
    expect(out.map((s) => s.sessionId)).toEqual(['valid']);
  });

  it('continues past project entries that are not directories', async () => {
    mkdirSync(projectsDir);
    // Stray file alongside project dirs (ENOTDIR on readdir → continue).
    writeFileSync(join(projectsDir, 'stray.txt'), 'x', 'utf8');
    writeJsonl('proj-h', 'sid-h', [
      { type: 'ai-title', aiTitle: 'ok', cwd: '/x' },
    ]);
    const out = await scanImportableSessions();
    expect(out.map((s) => s.sessionId)).toEqual(['sid-h']);
  });

  it('falls back to "(untitled session)" when no title fields present', async () => {
    writeJsonl('proj-i', 'sid-i', [{ type: 'queue-operation', cwd: '/x' }]);
    const out = await scanImportableSessions();
    expect(out[0].title).toBe('(untitled session)');
  });

  it('handles a session whose head has no recognizable fields (filtered)', async () => {
    writeJsonl('proj-j', 'sid-j', [{ type: 'file-history-snapshot' }]);
    const out = await scanImportableSessions();
    expect(out.find((s) => s.sessionId === 'sid-j')).toBeUndefined();
  });
});
