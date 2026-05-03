# Daemon nightly bench suite (T8.13)

Per design spec ch12 §7. These files measure advisory perf numbers for the
daemon. They are wired to vitest's `bench` API and run via:

```
npx vitest bench --config packages/daemon/vitest.bench.config.ts --run
```

from the daemon package root, or with the explicit dir filter:

```
npx vitest bench --config packages/daemon/vitest.bench.config.ts --run \
  packages/daemon/test/bench/
```

## Files

| File | Measures | Status | Blocker |
| --- | --- | --- | --- |
| `cold-start.bench.ts` | spawn -> /healthz green (ms) | skipped | T1.7 (healthz flip) |
| `hello-rtt.bench.ts` | Hello RPC round-trip p50/p99 | skipped | Task #33 (Hello impl) |
| `sendinput-rtt.bench.ts` | SendInput -> first echo back | skipped | Task #53 (SendInput impl) |
| `snapshot-encode.bench.ts` | SnapshotV1 encode bytes/sec | skipped | Task #46 (snapshot encoder) |
| `rss.bench.ts` | resident-set memory after warmup | skipped | T1.7 + #33 (need running daemon) |

Each `bench.skip` entry has a `TODO(Task #N)` referencing the blocker. As infra
lands, the implementing task flips `bench.skip` -> `bench` in the same PR
(no stranded skeletons).

## Why everything is skipped today

Per Layer 1 / dev protocol §1: harness shape is the deliverable for T8.13.
Real numbers come once the upstream RPCs ship. `vitest bench --run` against
this directory must START without throwing — that's the only quality gate
this PR is on the hook for.

## Gating

All numbers here are **advisory**. The one blocking perf gate is SendInput
p99, and that is enforced by the dedicated soak harness (Task #92), not by
this bench suite.
