// Integration test for the test-only crash branch (T4.5 / Task #40).
//
// Forks the REAL `dist/pty-host/child.js` via `child_process.fork` and
// asserts the two ends of the contract:
//
//   1. WITHOUT `CCSM_PTY_TEST_CRASH_ON`: the child boots normally
//      (sends `ready`), accepts `close`, sends `exiting` reason
//      `graceful`, and exits 0. Production behavior is unchanged.
//   2. WITH `CCSM_PTY_TEST_CRASH_ON=boot`: the child sends `ready`
//      then immediately exits with code 137 (TEST_CRASH_EXIT_CODE),
//      AFTER first sending `exiting` reason `test-crash`. The
//      lifecycle watcher (T4.4) classifies this as a CRASHED session.
//   3. WITH `CCSM_PTY_TEST_CRASH_ON=spawn`: the child boots normally,
//      then crashes (137) on receipt of the first `spawn` IPC.
//   4. WITH `CCSM_PTY_TEST_CRASH_ON=after-bytes:N`: the child crashes
//      (137) after cumulative outgoing IPC payload reaches N bytes.
//      Verified by sending small payloads (resize) that drive the
//      counter via the child's reply traffic.
//   5. With `NODE_ENV=production` AND env set: the child does NOT
//      crash — production gate.
//
// Why `dist/pty-host/child.js` and not the .ts source: vitest's node
// runner does not register a tsx loader for `child_process.fork`'d
// scripts (matches the pre-existing reason `host.spec.ts` uses a JS
// fixture). The daemon's PR step 2 (`npm run build`) emits dist
// before step 3 (`npm test`), so this spec finds the file in CI and
// in the local PR workflow. If the file is missing the test prints
// a clear hint rather than the cryptic ENOENT from `fork`.

import { describe, expect, it, beforeAll } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { TEST_CRASH_EXIT_CODE } from '../../src/pty-host/test-crash-config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHILD_DIST = resolve(__dirname, '../../dist/pty-host/child.js');

interface ForkResult {
  readonly messages: ReadonlyArray<{ kind?: string; reason?: string }>;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Fork the real child and drive it through a scripted parent. Returns
 * after the child exits. Resolves cleanly even on crash so callers can
 * assert on the captured exit code.
 */
async function runChild(opts: {
  env?: Record<string, string | undefined>;
  /** Messages to send to the child after it sends `ready`. */
  scriptedSends?: ReadonlyArray<unknown>;
  /** Send `close` after running `scriptedSends`. */
  closeAfter?: boolean;
  /** Hard kill ms — safety net so a hung child cannot wedge vitest. */
  timeoutMs?: number;
}): Promise<ForkResult> {
  const child: ChildProcess = fork(CHILD_DIST, [], {
    silent: true,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  const messages: Array<{ kind?: string; reason?: string }> = [];
  let readyResolve!: () => void;
  const readyP = new Promise<void>((r) => { readyResolve = r; });

  child.on('message', (m: unknown) => {
    if (m && typeof m === 'object') {
      const msg = m as { kind?: string; reason?: string };
      messages.push(msg);
      if (msg.kind === 'ready') readyResolve();
    }
  });

  const exitP = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>(
    (r) => {
      child.on('exit', (code, sig) => r({ code, sig }));
    },
  );

  const timeoutMs = opts.timeoutMs ?? 5000;
  const timer = setTimeout(() => {
    if (!child.killed) child.kill('SIGKILL');
  }, timeoutMs);

  // Some variants crash before `ready`; treat ready timeout as soft.
  await Promise.race([
    readyP,
    new Promise((r) => setTimeout(r, 1000)),
  ]);

  if (opts.scriptedSends) {
    for (const m of opts.scriptedSends) {
      try { child.send(m as never); } catch { /* child may have died */ }
    }
  }
  if (opts.closeAfter) {
    try { child.send({ kind: 'close' } as never); } catch { /* same */ }
  }

  const { code, sig } = await exitP;
  clearTimeout(timer);
  return { messages, exitCode: code, signal: sig };
}

describe('T4.5 — pty-host child test-crash branch (integration via fork)', () => {
  beforeAll(() => {
    if (!existsSync(CHILD_DIST)) {
      throw new Error(
        `[T4.5 spec] dist/pty-host/child.js missing at ${CHILD_DIST}. ` +
        `Run \`pnpm --filter @ccsm/daemon build\` (or the repo \`npm run ` +
        `build\` PR step 2) before \`npm test\`. The daemon vitest config ` +
        `forks the compiled child binary because vitest's node runner does ` +
        `not register a tsx loader for child_process.fork (matches host.spec.ts).`,
      );
    }
    // Defensive: verify it is a regular file (not a stale symlink).
    if (!statSync(CHILD_DIST).isFile()) {
      throw new Error(`[T4.5 spec] ${CHILD_DIST} exists but is not a file.`);
    }
  });

  it('without env: production-equivalent boot (ready → close → graceful exit 0)', async () => {
    const r = await runChild({
      env: { CCSM_PTY_TEST_CRASH_ON: undefined },
      closeAfter: true,
    });
    expect(r.exitCode).toBe(0);
    expect(r.signal).toBeNull();
    // Sequence: ready first, then exiting{graceful}.
    const kinds = r.messages.map((m) => m.kind);
    expect(kinds[0]).toBe('ready');
    const exiting = r.messages.find((m) => m.kind === 'exiting');
    expect(exiting?.reason).toBe('graceful');
    // No test-crash trace in the message log.
    expect(r.messages.some((m) => m.reason === 'test-crash')).toBe(false);
  });

  it('with empty CCSM_PTY_TEST_CRASH_ON="": treated as unset (no crash)', async () => {
    const r = await runChild({
      env: { CCSM_PTY_TEST_CRASH_ON: '' },
      closeAfter: true,
    });
    expect(r.exitCode).toBe(0);
  });

  it('with NODE_ENV=production AND env set: production gate blocks crash', async () => {
    const r = await runChild({
      env: { CCSM_PTY_TEST_CRASH_ON: 'boot', NODE_ENV: 'production' },
      closeAfter: true,
    });
    expect(r.exitCode).toBe(0);
  });

  it('boot variant: child crashes 137 after ready, emits exiting{test-crash}', async () => {
    const r = await runChild({
      env: { CCSM_PTY_TEST_CRASH_ON: 'boot', NODE_ENV: 'test' },
    });
    expect(r.exitCode).toBe(TEST_CRASH_EXIT_CODE);
    // Ready handshake observed before the crash so the daemon's host
    // surface treats this as a post-init crash, not a "never-readied".
    expect(r.messages.some((m) => m.kind === 'ready')).toBe(true);
    // Test-crash signal precedes the exit (best-effort; spec-locked
    // 'exiting' kind reserved with `'test-crash'` reason in types.ts).
    expect(r.messages.some(
      (m) => m.kind === 'exiting' && m.reason === 'test-crash',
    )).toBe(true);
  });

  it('spawn variant: child boots ok, then crashes 137 on first spawn IPC', async () => {
    const spawnPayload = {
      kind: 'spawn',
      payload: {
        sessionId: 'sess-T4.5',
        cwd: process.cwd(),
        claudeArgs: ['--print', 'hi'],
        cols: 80,
        rows: 24,
      },
    };
    const r = await runChild({
      env: { CCSM_PTY_TEST_CRASH_ON: 'spawn', NODE_ENV: 'test' },
      scriptedSends: [spawnPayload],
    });
    expect(r.exitCode).toBe(TEST_CRASH_EXIT_CODE);
    expect(r.messages.some((m) => m.kind === 'ready')).toBe(true);
    expect(r.messages.some(
      (m) => m.kind === 'exiting' && m.reason === 'test-crash',
    )).toBe(true);
  });

  it('after-bytes variant: child crashes 137 once cumulative IPC bytes >= threshold', async () => {
    // Threshold = 1 byte → triggers on the first IPC after `ready`
    // because `ready` itself already pushes the counter past 1.
    // (In a richer scenario T4.6+ delta payloads push past 1024 etc.;
    //  the decider already supports the spec example.)
    const r = await runChild({
      env: { CCSM_PTY_TEST_CRASH_ON: 'after-bytes:1', NODE_ENV: 'test' },
    });
    expect(r.exitCode).toBe(TEST_CRASH_EXIT_CODE);
    expect(r.messages.some(
      (m) => m.kind === 'exiting' && m.reason === 'test-crash',
    )).toBe(true);
  });

  it('after-bytes variant with high threshold: no crash for normal lifecycle', async () => {
    // Threshold so high (1 GiB) the normal ready+exiting traffic cannot
    // reach it — child closes gracefully.
    const r = await runChild({
      env: {
        CCSM_PTY_TEST_CRASH_ON: 'after-bytes:1073741824',
        NODE_ENV: 'test',
      },
      closeAfter: true,
    });
    expect(r.exitCode).toBe(0);
  });

  it('crashed exit + ChildExit classification: a real fork into the daemon\'s lifecycle watcher would mark the session CRASHED (T4.4 contract)', async () => {
    // We do not stand up SessionManager here (that is host.spec.ts +
    // lifecycle-watcher.spec.ts territory); instead we assert the two
    // observables the watcher's `decideSessionEnd` keys off:
    //   - exit code != 0 AND no graceful `exiting{graceful}` notice
    //     ⇒ decider returns reason='crashed'.
    // The integration here is "the env actually causes a real
    // non-graceful exit"; the decider unit tests pin the mapping.
    const r = await runChild({
      env: { CCSM_PTY_TEST_CRASH_ON: 'boot', NODE_ENV: 'test' },
    });
    expect(r.exitCode).not.toBe(0);
    // No graceful notice was sent (only test-crash).
    const graceful = r.messages.find(
      (m) => m.kind === 'exiting' && m.reason === 'graceful',
    );
    expect(graceful).toBeUndefined();
  });
});
