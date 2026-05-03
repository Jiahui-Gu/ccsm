// packages/daemon/test/bench/hello-rtt.bench.ts
//
// T8.13 — Hello RPC round-trip latency. Single client, sequential calls,
// p50/p99 reported by tinybench's built-in samples histogram.
//
// SKIPPED until Task #33 lands the SessionService.Hello server impl. The
// proto definition exists at packages/proto/src/ccsm/v1/session.proto
// (rpc Hello(HelloRequest) returns (HelloResponse)) but no daemon-side
// handler is registered yet — see packages/daemon/src/index.ts phase log
// for the missing listener bind.
//
// When Task #33 lands: flip `bench.skip` -> `bench`, spin up the daemon
// in-process (or via the same Connect-RPC test harness as
// test/integration/rpc/clients-transport-matrix.spec.ts), construct a
// PromiseClient<typeof SessionService>, and call `client.hello({})` in a
// tight loop inside the bench fn. tinybench measures wall time per call;
// p50/p99 fall out of the resulting histogram.
//
// Numbers are advisory; this is for trend tracking, not a ship gate.

import { bench, describe } from 'vitest';

describe('Hello RPC round-trip', () => {
  bench.skip('client.hello() RTT', async () => {
    // TODO(Task #33): implement once SessionService.Hello handler is wired.
    // Blocked on: SessionService.Hello server registration in daemon RPC stack.
    throw new Error('not implemented — blocked on Task #33');
  });
});
