// packages/daemon/test/bench/rss.bench.ts
//
// T8.13 — daemon resident-set memory after warmup. Spawns the daemon,
// runs a representative warmup workload (N sessions opened, M Hello
// calls, K SendInput bytes), then samples `process.memoryUsage().rss`
// of the daemon child via the supervisor /diag endpoint (or via
// direct platform-specific RSS read of the child pid).
//
// SKIPPED today because the daemon doesn't yet have:
//   - A way to be queried for RSS post-warmup (T1.7 supervisor needs
//     a /diag or /metrics endpoint, or we read pid RSS externally).
//   - The warmup workload primitives: Hello (Task #33) + SendInput
//     (Task #53) + session open.
//
// This is technically a "value", not a "rate" bench — tinybench wants
// time-per-op samples. Pattern: bench fn does the warmup + RSS sample
// once per iter (iterations: 3-5), and we read RSS values from a
// side-channel (e.g. write to a temp file each iter, post-process
// offline). Alternative: report RSS in the bench stdout via
// console.log and have the nightly job grep for it.
//
// When unblocked: flip `bench.skip` -> `bench`, decide on the
// side-channel format (likely a `bench-rss.jsonl` next to the
// vitest output for the nightly scraper to pick up).

import { bench, describe } from 'vitest';

describe('daemon RSS after warmup', () => {
  bench.skip('rss bytes after N-session warmup', async () => {
    // TODO(T1.7 + Task #33 + Task #53): implement once daemon can be
    // spawned and exercised end-to-end. Blocked on:
    //   - T1.7        supervisor /healthz so we know warmup is done
    //   - Task #33    Hello RPC for warmup traffic
    //   - Task #53    SendInput RPC for warmup traffic
    throw new Error('not implemented — blocked on T1.7 + Task #33 + Task #53');
  });
});
