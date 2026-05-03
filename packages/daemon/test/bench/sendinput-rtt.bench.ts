// packages/daemon/test/bench/sendinput-rtt.bench.ts
//
// T8.13 — SendInput end-to-end round-trip: client writes 1 byte via
// SendInput, daemon forwards to pty-host, pty echoes, daemon streams the
// echo frame back to the client. Measured wall-clock per byte.
//
// This is the *advisory* counterpart to the SendInput soak ship-gate
// (Task #92, gate-c). The soak harness owns the binding p99 SLO; this
// bench only records the same number outside of the soak so trend
// regressions show up between releases without waiting for a 1h soak.
//
// SKIPPED until Task #53 lands the SendInput RPC handler + pty-host
// echo wiring. Today packages/daemon/src/pty-host/host.ts has the
// child fork lifecycle but no input-forward path — see child.ts comment
// "xterm-headless import / Terminal init — lands with T4.6 (codec)".
//
// When Task #53 lands: flip `bench.skip` -> `bench`. Suggested shape:
//   1. spawn a session running `cat` (or `node -e "process.stdin.pipe(process.stdout)"`)
//   2. open a server-stream Snapshot/Frame subscription
//   3. for each iter: write 1 byte via SendInput, await first frame
//      whose payload contains that byte, record (now - sentAt) ms

import { bench, describe } from 'vitest';

describe('SendInput round-trip (echo)', () => {
  bench.skip('SendInput -> first echo frame', async () => {
    // TODO(Task #53): implement once SendInput handler + pty echo wiring lands.
    // Blocked on: SendInput RPC + pty-host input forwarding.
    // See also Task #92 for the binding p99 SLO (this bench is advisory).
    throw new Error('not implemented — blocked on Task #53');
  });
});
