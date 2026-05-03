// packages/daemon/test/bench/cold-start.bench.ts
//
// T8.13 — daemon cold-start latency: spawn(daemon) -> GET /healthz returns
// 200 with {ready: true}. Wall-clock ms, single-shot per iteration.
//
// SKIPPED until T1.7 lands (Supervisor /healthz flip to 200). Today the
// daemon's `runStartup` walks the lifecycle but never binds the supervisor
// HTTP server, so there is no endpoint to poll. The READY phase is logged
// but the readiness contract is half-built.
//
// When T1.7 lands: flip `bench.skip` -> `bench`, remove the TODO line, and
// fill in the spawn/poll harness. Suggested shape:
//   1. spawn `node dist/index.js` with a temp state-dir env
//   2. tight-poll GET http://127.0.0.1:<port>/healthz every 5ms with 5s budget
//   3. record (firstReadyAt - spawnAt) ms
//   4. SIGTERM the child, await exit, then teardown temp state-dir
//
// Cold-start is measured per-iteration (no warmup re-use): the whole point
// is process spawn + module load + DB open + listener bind. tinybench
// `iterations` should be small (e.g. 5) since each shot is ~hundreds of ms.

import { bench, describe } from 'vitest';

describe('daemon cold-start', () => {
  bench.skip('spawn -> /healthz green (ms)', async () => {
    // TODO(T1.7): implement once Supervisor /healthz returns 200 on READY.
    // Blocked on: packages/daemon/src/index.ts "TODO(T1.7): flip Supervisor /healthz to 200".
    throw new Error('not implemented — blocked on T1.7');
  });
});
