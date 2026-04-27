import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Sandbox HOME so PROJECTS_ROOT in jsonl-loader resolves into a temp dir.
// MUST mutate env BEFORE the module imports — vitest hoists static `import`
// statements above all top-level code, so we use a dynamic import inside
// `beforeAll` and reset modules to ensure module-level constants snapshot
// the override.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-jsonl-test-'));
const origHome = process.env.HOME;
const origUserProfile = process.env.USERPROFILE;

let loadHistoryFromJsonl: typeof import('../jsonl-loader').loadHistoryFromJsonl;
let projectKeyFromCwd: typeof import('../jsonl-loader').projectKeyFromCwd;

beforeAll(async () => {
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  vi.resetModules();
  const mod = await import('../jsonl-loader');
  loadHistoryFromJsonl = mod.loadHistoryFromJsonl;
  projectKeyFromCwd = mod.projectKeyFromCwd;
});

beforeEach(() => {
  // Make sure fixtures from a prior test don't leak between cases.
  const root = path.join(tmpHome, '.claude', 'projects');
  if (fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

afterEach(() => {
  // No-op; cleanup is in beforeEach so the fixtures of the LAST test in the
  // file are still visible if a developer wants to inspect them post-run.
});

// Cleanup at process exit; restores HOME so a subsequent test file in the
// same vitest run sees its own environment.
process.on('exit', () => {
  if (origHome !== undefined) process.env.HOME = origHome;
  else delete process.env.HOME;
  if (origUserProfile !== undefined) process.env.USERPROFILE = origUserProfile;
  else delete process.env.USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function seedJsonl(cwd: string, sessionId: string, lines: string[]) {
  const key = projectKeyFromCwd(cwd);
  const dir = path.join(tmpHome, '.claude', 'projects', key);
  fs.mkdirSync(dir, { recursive: true });
  const body = lines.length === 0 ? '' : lines.join('\n') + '\n';
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), body);
}

describe('projectKeyFromCwd', () => {
  it('replaces / \\ : with -', () => {
    expect(projectKeyFromCwd('C:\\Users\\x\\proj')).toBe('C--Users-x-proj');
    expect(projectKeyFromCwd('/Users/x/proj')).toBe('-Users-x-proj');
    expect(projectKeyFromCwd('/tmp/y')).toBe('-tmp-y');
  });
  it('returns "" for empty / non-string input', () => {
    expect(projectKeyFromCwd('')).toBe('');
    expect(projectKeyFromCwd(undefined as unknown as string)).toBe('');
  });
});

describe('loadHistoryFromJsonl', () => {
  it('returns ok:true with parsed frames for a valid file', async () => {
    seedJsonl('/tmp/proj', 'sid-1', [
      JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'hello' } }),
      JSON.stringify({ type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: 'hi' }] } })
    ]);
    const r = await loadHistoryFromJsonl('/tmp/proj', 'sid-1');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.frames).toHaveLength(2);
      expect((r.frames[0] as { type: string }).type).toBe('user');
      expect((r.frames[1] as { type: string }).type).toBe('assistant');
    }
  });

  it('returns ok:true frames=[] when the file is empty', async () => {
    seedJsonl('/tmp/proj', 'sid-empty', []);
    const r = await loadHistoryFromJsonl('/tmp/proj', 'sid-empty');
    expect(r).toEqual({ ok: true, frames: [] });
  });

  it('returns not_found when the JSONL does not exist', async () => {
    const r = await loadHistoryFromJsonl('/tmp/missing', 'no-such-sid');
    expect(r).toEqual({ ok: false, error: 'not_found' });
  });

  it('skips malformed lines but keeps the valid ones', async () => {
    seedJsonl('/tmp/proj', 'sid-mix', [
      JSON.stringify({ type: 'user', uuid: 'u-good-1' }),
      'not json at all',
      JSON.stringify({ type: 'assistant', message: { id: 'a-good' } }),
      '{ broken: ',
      JSON.stringify({ type: 'user', uuid: 'u-good-2' })
    ]);
    const r = await loadHistoryFromJsonl('/tmp/proj', 'sid-mix');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.frames).toHaveLength(3);
      expect((r.frames[0] as { uuid: string }).uuid).toBe('u-good-1');
      expect((r.frames[1] as { type: string }).type).toBe('assistant');
      expect((r.frames[2] as { uuid: string }).uuid).toBe('u-good-2');
    }
  });

  it('rejects path traversal in sessionId', async () => {
    seedJsonl('/tmp/proj', 'sid-x', [JSON.stringify({ type: 'user' })]);
    // basename strips traversal — `..` collapses to `..`, which we explicitly
    // reject. Empty / dot-only sids also rejected.
    const r1 = await loadHistoryFromJsonl('/tmp/proj', '../../../etc/passwd');
    expect(r1.ok).toBe(false);
    const r2 = await loadHistoryFromJsonl('', 'sid-x');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe('invalid_args');
  });

  it('returns invalid_args for non-string args', async () => {
    const r = await loadHistoryFromJsonl(undefined as unknown as string, 'sid');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_args');
  });
});
