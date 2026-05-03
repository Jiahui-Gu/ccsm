// packages/daemon/test/bench/snapshot-encode.bench.ts
//
// T8.13 — SnapshotV1 encode throughput in bytes/sec. Pure-CPU bench:
// build a representative terminal snapshot (e.g. 80x24 with mixed
// SGR runs and unicode), serialize it via the SnapshotV1 encoder,
// divide bytes-out / wall-time.
//
// SKIPPED until Task #46 lands the SnapshotV1 encoder. The proto wire
// shape exists in packages/proto/src/ccsm/v1/, but the daemon-side
// encoder (xterm-headless terminal -> SnapshotV1 message) is part of
// the codec task (T4.6 / Task #46 in the manager queue).
//
// When Task #46 lands: flip `bench.skip` -> `bench`. Suggested shape:
//   1. once per bench run (setup, not per-iter): build a fixed
//      xterm-headless Terminal pre-populated with a representative
//      buffer (mixed SGR, scrollback ~1000 lines, some unicode).
//   2. per iter: call `encodeSnapshotV1(term)` and record bytesOut.
//   3. report `bytesOut / sample.mean` outside vitest as a derived
//      metric (or use bench.opts.iterations to size the report).
//
// This is pure CPU — no daemon process needed. Easiest of the five
// to wire up once the encoder exists.

import { bench, describe } from 'vitest';

describe('SnapshotV1 encode throughput', () => {
  bench.skip('encode 80x24 terminal snapshot', () => {
    // TODO(Task #46): implement once SnapshotV1 encoder lands.
    // Blocked on: snapshot encoder (xterm-headless Terminal -> SnapshotV1 message).
    throw new Error('not implemented — blocked on Task #46');
  });
});
