// R-14 (Task #34) — unit tests for waitForHttpStable.
//
// We mock the `fetch` impl + clock so we can drive a 200/reset/200 sequence
// deterministically and verify the helper only resolves after stableForMs of
// consecutive 2xx-4xx probes.
import { describe, it, expect } from 'vitest';
import { waitForHttpStable } from '../fixtures/wait-http-stable.js';

interface FakeClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  advance: (ms: number) => void;
}

function makeClock(): FakeClock {
  let t = 0;
  const waiters: Array<{ wakeAt: number; resolve: () => void }> = [];
  return {
    now: () => t,
    sleep: (ms: number) => new Promise<void>((resolve) => {
      waiters.push({ wakeAt: t + ms, resolve });
    }),
    advance: (ms: number) => {
      t += ms;
      for (const w of [...waiters]) {
        if (w.wakeAt <= t) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve();
        }
      }
    },
  };
}

type ProbeResult =
  | { kind: 'ok'; status: number }
  | { kind: 'reset' };

function makeFetch(seq: ProbeResult[]): { fetchImpl: typeof fetch; calls: number } {
  let i = 0;
  const state = { calls: 0 };
  const fetchImpl: typeof fetch = (async () => {
    state.calls += 1;
    const r = seq[Math.min(i, seq.length - 1)];
    i += 1;
    if (r.kind === 'reset') {
      const err: NodeJS.ErrnoException = Object.assign(new Error('connection reset'), {
        code: 'ECONNRESET',
      });
      throw err;
    }
    return {
      status: r.status,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls: state.calls };
}

// Drive the helper forward by repeatedly advancing the clock past each poll
// interval and yielding to the microtask queue so awaited probes resolve.
async function tickUntilSettled<T>(
  promise: Promise<T>,
  clock: FakeClock,
  stepMs = 200,
  maxSteps = 1000,
): Promise<T> {
  let settled = false;
  let result: T | undefined;
  let err: unknown;
  promise.then((v) => { settled = true; result = v; }, (e) => { settled = true; err = e; });
  for (let i = 0; i < maxSteps && !settled; i++) {
    // Yield twice: once for the in-flight probe await, once for the sleep.
    await Promise.resolve();
    await Promise.resolve();
    if (settled) break;
    clock.advance(stepMs);
  }
  if (!settled) throw new Error('tickUntilSettled: helper did not settle in time');
  if (err !== undefined) throw err;
  return result as T;
}

describe('waitForHttpStable', () => {
  it('resolves after stableForMs of consecutive 200s', async () => {
    const clock = makeClock();
    const { fetchImpl } = makeFetch([{ kind: 'ok', status: 200 }]);
    const promise = waitForHttpStable('http://127.0.0.1:1/', {
      timeout: 60_000,
      stableForMs: 1000,
      pollIntervalMs: 200,
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
    });
    await tickUntilSettled(promise, clock);
    // Should not throw; pass.
  });

  it('does not resolve before stableForMs window completes', async () => {
    // 4 successful probes (at t=0,200,400,600) — under 1000ms stable window.
    // Then a reset at t=800 resets the window. Expect not yet resolved.
    const clock = makeClock();
    const seq: ProbeResult[] = [
      { kind: 'ok', status: 200 }, // t=0  stableSince=0
      { kind: 'ok', status: 200 }, // t=200, 200<1000 not yet
      { kind: 'ok', status: 200 }, // t=400
      { kind: 'ok', status: 200 }, // t=600
      { kind: 'reset' },           // t=800 reset → stableSince=null
      { kind: 'ok', status: 200 }, // t=1000
    ];
    const { fetchImpl } = makeFetch(seq);

    let settled = false;
    const p = waitForHttpStable('http://127.0.0.1:1/', {
      timeout: 60_000,
      stableForMs: 1000,
      pollIntervalMs: 200,
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
    }).then(() => { settled = true; });

    // Advance through the 6 entries above (t=0..1000).
    for (let i = 0; i < 6; i++) {
      await Promise.resolve(); await Promise.resolve();
      clock.advance(200);
    }
    expect(settled).toBe(false);
    // unhandled rejection guard
    p.catch(() => undefined);
  });

  it('rejects on timeout with last status / errno', async () => {
    const clock = makeClock();
    const { fetchImpl } = makeFetch([{ kind: 'reset' }]);
    const promise = waitForHttpStable('http://127.0.0.1:1/', {
      timeout: 1000,
      stableForMs: 500,
      pollIntervalMs: 200,
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
    });

    let err: unknown;
    promise.catch((e) => { err = e; });
    for (let i = 0; i < 20 && err === undefined; i++) {
      await Promise.resolve(); await Promise.resolve();
      clock.advance(200);
    }
    expect(err).toBeDefined();
    expect((err as Error).message).toMatch(/timed out/);
    expect((err as Error).message).toMatch(/ECONNRESET/);
  });

  it('treats 404 as success (cf-worker root path)', async () => {
    const clock = makeClock();
    const { fetchImpl } = makeFetch([{ kind: 'ok', status: 404 }]);
    const promise = waitForHttpStable('http://127.0.0.1:1/', {
      timeout: 10_000,
      stableForMs: 500,
      pollIntervalMs: 200,
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
    });
    await tickUntilSettled(promise, clock);
  });

  it('treats 502 as failure and resets the stable window', async () => {
    // 200, 200, 502 (reset), 200, 200, 200 — should only resolve after the
    // last three at >= stableForMs=400ms.
    const clock = makeClock();
    const seq: ProbeResult[] = [
      { kind: 'ok', status: 200 },
      { kind: 'ok', status: 200 },
      { kind: 'ok', status: 502 },
      { kind: 'ok', status: 200 },
      { kind: 'ok', status: 200 },
      { kind: 'ok', status: 200 },
      { kind: 'ok', status: 200 },
    ];
    const { fetchImpl } = makeFetch(seq);
    const promise = waitForHttpStable('http://127.0.0.1:1/', {
      timeout: 60_000,
      stableForMs: 400,
      pollIntervalMs: 200,
      fetchImpl,
      now: clock.now,
      sleep: clock.sleep,
    });
    await tickUntilSettled(promise, clock);
    // Resolves after the run of 200s past the 502 reset.
  });
});
