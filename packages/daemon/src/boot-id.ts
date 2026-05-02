// Per-boot UUIDv4 freshness witness — see spec ch02 §3 step 5 / ch03 §3.2.
//
// The value is generated exactly once per daemon process at module load and
// pinned in memory for the daemon's lifetime. Electron's startup handshake
// (ch03 §3.3) compares the descriptor's `boot_id` against the `Hello` RPC
// echo to detect stale descriptors after a daemon restart.
//
// IMPORTANT: never re-use a prior boot's value, never re-export a setter,
// and never read the value from disk — the daemon owns this constant.

import { randomUUID } from 'node:crypto';

export const bootId: string = randomUUID();
