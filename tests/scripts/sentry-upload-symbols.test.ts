// tests/scripts/sentry-upload-symbols.test.ts
//
// Phase 3 crash observability (spec §5.4, plan Task 10).
//
// Verifies the symbol upload script:
//   * is a no-op when SENTRY_AUTH_TOKEN is unset (local dev / OSS forks)
//   * invokes sentry-cli with the per-surface project name when token + org
//     are present and the corresponding SENTRY_PROJECT_* env var is set
//   * scopes each surface's upload to its own project (no cross-bleed)
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// CommonJS module — load via require so the hook export shape is real.
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const symbolUploader = require('../../scripts/sentry-upload-symbols.cjs');
const { runUpload } = symbolUploader as {
  runUpload: (args?: {
    buildResult?: { artifactPaths?: string[] };
    env?: NodeJS.ProcessEnv;
    execImpl?: (file: string, args: string[], opts: unknown) => void;
  }) => Promise<{ skipped: boolean; reason?: string; release?: string; artifactDirs?: string[] }>;
};

describe('sentry-upload-symbols', () => {
  it('skips silently when SENTRY_AUTH_TOKEN is unset', async () => {
    const calls: { file: string; args: string[] }[] = [];
    const exec = (file: string, args: string[]) => { calls.push({ file, args }); };
    const result = await runUpload({
      env: { /* deliberately empty — no SENTRY_AUTH_TOKEN */ } as NodeJS.ProcessEnv,
      execImpl: exec,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no-token');
    expect(calls.length).toBe(0);
  });

  it('skips silently when SENTRY_AUTH_TOKEN is set but SENTRY_ORG is not', async () => {
    const calls: { file: string; args: string[] }[] = [];
    const exec = (file: string, args: string[]) => { calls.push({ file, args }); };
    const result = await runUpload({
      env: { SENTRY_AUTH_TOKEN: 'tok' } as NodeJS.ProcessEnv,
      execImpl: exec,
    });
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('no-org');
    expect(calls.length).toBe(0);
  });

  it('invokes sentry-cli per surface, scoping each call to the matching SENTRY_PROJECT_*', async () => {
    // Stage real dist dirs so `fs.existsSync` lets the uploader through.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-sym-'));
    const repoRoot = path.resolve(__dirname, '..', '..');
    const created: string[] = [];
    function ensureDir(p: string): void {
      if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true });
        created.push(p);
      }
    }
    // The script uses repo-relative paths; existing `dist/renderer`,
    // `dist/electron`, `daemon/dist` may or may not be present in the
    // worker checkout — create them if absent and clean up after.
    ensureDir(path.join(repoRoot, 'dist', 'renderer'));
    ensureDir(path.join(repoRoot, 'dist', 'electron'));
    ensureDir(path.join(repoRoot, 'daemon', 'dist'));

    try {
      const calls: { file: string; args: string[]; project?: string }[] = [];
      const exec = (file: string, args: string[], opts: { env: Record<string, string> }) => {
        calls.push({ file, args, project: opts.env.SENTRY_PROJECT });
      };
      const result = await runUpload({
        buildResult: { artifactPaths: [path.join(tmp, 'fake.exe')] },
        env: {
          SENTRY_AUTH_TOKEN: 'tok',
          SENTRY_ORG: 'ccsm-org',
          SENTRY_PROJECT_RENDERER: 'p-rend',
          SENTRY_PROJECT_MAIN: 'p-main',
          SENTRY_PROJECT_DAEMON: 'p-dae',
        } as NodeJS.ProcessEnv,
        execImpl: exec,
      });
      expect(result.skipped).toBe(false);

      const projectsCalled = new Set(calls.map((c) => c.project));
      expect(projectsCalled.has('p-rend')).toBe(true);
      expect(projectsCalled.has('p-main')).toBe(true);
      expect(projectsCalled.has('p-dae')).toBe(true);

      // Source-map calls reference upload-sourcemaps.
      const sourceMapCalls = calls.filter((c) => c.args.includes('upload-sourcemaps'));
      expect(sourceMapCalls.length).toBeGreaterThanOrEqual(3);
      // Native dif call uses debug-files upload, scoped to project_main.
      const nativeCalls = calls.filter((c) => c.args.includes('debug-files'));
      expect(nativeCalls.length).toBeGreaterThanOrEqual(1);
      expect(nativeCalls.every((c) => c.project === 'p-main')).toBe(true);
    } finally {
      for (const p of created) {
        try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
