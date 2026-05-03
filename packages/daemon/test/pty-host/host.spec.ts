// Integration tests for `spawnPtyHostChild` — the host (parent) side of
// the per-session pty-host child boundary. Spec ch06 §1.
//
// These tests `child_process.fork` a JS fixture (see `./fixtures/`)
// rather than the real `child.ts`, because:
//   1. T4.1 ships the lifecycle skeleton; the real child does not yet
//      import node-pty (so a real fork would just exercise the fixture's
//      own equivalent of the spawn → ready → close path anyway), and
//   2. forking a `.ts` file under vitest requires a tsx loader that the
//      daemon package does not depend on — the fixture is plain ESM JS.
//
// The fixture is end-to-end protocol-equivalent to `child.ts` for the
// T4.1 surface: it sends `ready`, accepts `close`, sends `exiting`, and
// exits 0. T4.2+ tests will exercise the real child binary.

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { spawnPtyHostChild } from '../../src/pty-host/host.js';
import type { SpawnPayload } from '../../src/pty-host/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, 'fixtures', 'child-fixture.mjs');

function makePayload(overrides: Partial<SpawnPayload> = {}): SpawnPayload {
  return {
    sessionId: overrides.sessionId ?? 'sess-001',
    cwd: overrides.cwd ?? process.cwd(),
    claudeArgs: overrides.claudeArgs ?? ['--print', 'hi'],
    cols: overrides.cols ?? 120,
    rows: overrides.rows ?? 40,
    envExtra: overrides.envExtra,
  };
}

describe('spawnPtyHostChild — happy path lifecycle', () => {
  it('forks a child, observes ready, sends close, observes graceful exit', async () => {
    const handle = spawnPtyHostChild({
      payload: makePayload(),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'normal' },
    });

    expect(handle.sessionId).toBe('sess-001');
    expect(handle.pid).toBeGreaterThan(0);

    await handle.ready();

    handle.send({ kind: 'spawn', payload: makePayload() });

    const exit = await handle.closeAndWait();
    expect(exit.reason).toBe('graceful');
    expect(exit.code).toBe(0);
    expect(exit.signal).toBeNull();
  });

  it('exposes the resolved UTF-8 spawn env on the handle', async () => {
    const handle = spawnPtyHostChild({
      payload: makePayload(),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'normal' },
      platformOverride: 'linux',
    });
    try {
      await handle.ready();
      // Linux: LANG and LC_ALL are pinned to C.UTF-8.
      expect(handle.claudeSpawnEnv.LANG).toBe('C.UTF-8');
      expect(handle.claudeSpawnEnv.LC_ALL).toBe('C.UTF-8');
    } finally {
      await handle.closeAndWait();
    }
  });

  it('uses child_process.fork (NOT worker_threads) — ChildProcess pid is a real OS pid', async () => {
    // The host implementation is what we are pinning; this assertion is
    // structural — a worker_threads.Worker has no `.pid` distinct from
    // the daemon's own pid, whereas child_process.fork yields a fresh
    // OS pid. (Spec ch06 §1: F3-locked process boundary, not a thread.)
    const handle = spawnPtyHostChild({
      payload: makePayload(),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'normal' },
    });
    try {
      expect(handle.pid).toBeGreaterThan(0);
      expect(handle.pid).not.toBe(process.pid);
    } finally {
      await handle.closeAndWait();
    }
  });
});

describe('spawnPtyHostChild — message stream', () => {
  it('yields child→host messages via the async iterator', async () => {
    const handle = spawnPtyHostChild({
      payload: makePayload(),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'echo' },
    });

    await handle.ready();
    handle.send({ kind: 'spawn', payload: makePayload() });

    // Collect messages until close. The fixture in echo mode emits one
    // 'snapshot' on spawn, then 'exiting' on close. Plus the initial
    // 'ready' is queued for the iterator before we even start consuming.
    const got: string[] = [];
    const collector = (async () => {
      for await (const m of handle.messages()) {
        got.push(m.kind);
        if (m.kind === 'exiting') break;
      }
    })();

    // give the snapshot a chance to land before we close
    await new Promise((r) => setTimeout(r, 20));
    await handle.closeAndWait();
    await collector;

    expect(got).toContain('ready');
    expect(got).toContain('snapshot');
    expect(got).toContain('exiting');
  });
});

describe('spawnPtyHostChild — crash semantics', () => {
  it('reports reason="crashed" when the child exits non-zero without graceful notice', async () => {
    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId: 'sess-crash' }),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'crash' },
    });

    // ready() may resolve before the crash (the fixture sends ready
    // first). Either way, exited() always resolves with the outcome.
    await handle.ready().catch(() => undefined);
    const exit = await handle.exited();
    expect(exit.reason).toBe('crashed');
    expect(exit.code).toBe(137);
  });

  it('rejects ready() if the child exits before sending the ready message', async () => {
    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId: 'sess-no-ready' }),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'no-ready' },
    });

    await expect(handle.ready()).rejects.toThrow(/exited before ready/);
    const exit = await handle.exited();
    expect(exit.reason).toBe('crashed');
    expect(exit.code).toBe(3);
  });
});

describe('spawnPtyHostChild — send() guards', () => {
  it('throws when send() is called after the child has exited', async () => {
    const handle = spawnPtyHostChild({
      payload: makePayload({ sessionId: 'sess-after-exit' }),
      childEntrypoint: FIXTURE,
      forkEnv: { ...process.env, CCSM_FIXTURE_MODE: 'normal' },
    });
    await handle.ready();
    await handle.closeAndWait();

    expect(() =>
      handle.send({ kind: 'spawn', payload: makePayload() }),
    ).toThrow(/has exited/);
  });
});
