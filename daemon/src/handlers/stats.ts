// /stats handler (T18) — control-socket diagnostic-grade RPC.
//
// Spec citations:
//   - frag-6-7 §6.5 (line 150) — canonical owner of the response payload:
//       "A separate `/stats` (obs-S6) returns
//        { statsVersion: 1, rss, heapUsed, ptyBufferBytes, openSockets } —
//        diagnostic-grade RPC, not part of the supervisor liveness contract.
//        statsVersion enables additive evolution without renderer breakage
//        (r2-obs P1-4)."
//   - frag-3.4.1 §3.4.1.h — `/stats` is a wire-literal control-plane RPC
//     (NOT `ccsm.v1/daemon.stats`); registered on the control-socket
//     dispatcher (T16) as the literal string. See r9 + r11 manager locks
//     ("/stats keeps HTTP-style literal method name; explicit exemption
//     from §3.4.1.g ccsm.<wireMajor>/... namespace rule").
//   - frag-3.4.1 §3.4.1.f — supervisor transport ignores MIGRATION_PENDING
//     short-circuit (same posture as `/healthz`); `/stats` is a diagnostic
//     surface and MUST stay reachable across migration windows.
//   - v0.3-design.md §6.5 r3 P1-3 lock — `statsVersion` lives ONLY on
//     `/stats`; `healthzVersion` lives ONLY on `/healthz`. Two cursors for
//     one schema is a footgun; we keep them separated.
//
// Single Responsibility: pure decider. Reads injected counter providers
// (memory, PTY buffer, socket count) and returns a snapshot. Performs ZERO
// socket I/O and ZERO database queries. Counters are in-memory; the providers
// themselves are owned by their respective subsystems (PTY fan-out registry
// for `ptyBufferBytes`; control/data socket transports for `openSockets`).
//
// The provider injection mirrors T17 `/healthz`:
//   1. The daemon shell (T1 / index.ts) owns the live counter sources; this
//      module stays a pure function and is trivially testable with stubs.
//   2. T16 dispatcher swaps the NOT_IMPLEMENTED stub via `register('/stats',
//      makeStatsHandler(ctx))` once this module lands.
//   3. v0.4 protobuf swap can reuse the handler verbatim — only the wire
//      serialiser changes.
//
// Why `/stats` is "diagnostic-grade", not "liveness-grade":
//   - The supervisor liveness contract is `/healthz` (§6.5 — three misses
//     inside a 15s window restart the daemon). `/stats` is a separate poll
//     surface used by the future v0.4 inspector tooling and ad-hoc IPC
//     debugging; missing a `/stats` reply does NOT trigger a restart.
//   - Consequence: the handler is pure + cheap, but does not have the same
//     "must never throw" obligation as `/healthz`. We still keep it
//     branch-free of any blocking path because it shares the control-socket
//     accept loop with `/healthz` (frag-6-7 §6.5 dedicated transport).

/** Memory snapshot fields read by the handler — subset of
 *  `NodeJS.MemoryUsage`. Declared explicitly so test stubs do not need to
 *  fake the entire `process.memoryUsage()` shape. */
export interface MemorySnapshot {
  /** Resident set size in bytes (frag-6-7 §6.5 `rss`). */
  readonly rss: number;
  /** V8 heap-used in bytes (frag-6-7 §6.5 `heapUsed`). */
  readonly heapUsed: number;
}

/** Stats schema-version cursor (frag-6-7 §6.5 line 150 + r2 obs P1-4).
 *  Bumps only on breaking shape changes; additive fields do NOT bump it
 *  (consumers MUST treat unknown fields as forward-compatible per
 *  frag-3.4.1 §3.4.1.g rule). v0.3 = 1. */
export const STATS_VERSION = 1 as const;

/** Injected runtime context. The daemon shell (T1) owns the live values
 *  and constructs this once; the handler reads only — no mutation here. */
export interface StatsContext {
  /** Memory snapshot producer. Production = `() => {
   *    const m = process.memoryUsage();
   *    return { rss: m.rss, heapUsed: m.heapUsed };
   *  }`. Injected so tests can pin the values without spawning a process. */
  readonly getMemoryUsage: () => MemorySnapshot;
  /** Total bytes currently held in PTY fan-out replay buffers (frag-3.5.1
   *  §3.5.1.4). 0 until the fan-out registry (T41) is wired into the daemon
   *  shell; T18 ships a default-0 producer so the field is always present
   *  on the wire. */
  readonly getPtyBufferBytes?: () => number;
  /** Count of currently-open accept-side sockets across the data-path
   *  adapter + control-socket transport. 0 until the socket layer is wired;
   *  see `getPtyBufferBytes` for the same default-0 rationale. */
  readonly getOpenSockets?: () => number;
}

/** Full `/stats` response shape (frag-6-7 §6.5 line 150). */
export interface StatsReply {
  readonly statsVersion: typeof STATS_VERSION;
  readonly rss: number;
  readonly heapUsed: number;
  readonly ptyBufferBytes: number;
  readonly openSockets: number;
}

/**
 * Build the canonical `/stats` reply.
 *
 * Pure: same `(req, ctx)` always yields the same output for the same
 * provider readings. Performs no I/O.
 *
 * The `req` argument is intentionally unused — `/stats` takes no parameters
 * per frag-6-7 §6.5 (the diagnostic poller hits it with an empty payload).
 * Accepting it as a Handler-compatible signature keeps wiring trivial for
 * the T16 dispatcher.
 *
 * Counter zero-state: missing optional providers fall back to 0 so the
 * field is always present on the wire (forward-compatible with the
 * subsystems that will wire them in later — fan-out registry T41,
 * socket layer T14/etc.).
 */
export function handleStats(_req: unknown, ctx: StatsContext): StatsReply {
  const mem = ctx.getMemoryUsage();
  return {
    statsVersion: STATS_VERSION,
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    ptyBufferBytes: ctx.getPtyBufferBytes?.() ?? 0,
    openSockets: ctx.getOpenSockets?.() ?? 0,
  };
}

/** Adapter to the T16 `Dispatcher.Handler` signature. T16's handler returns
 *  `Promise<unknown>`; stats is synchronous but we wrap so `register()`
 *  accepts it without coupling the pure function to Promise plumbing.
 *
 *  Usage (post-T16-merge follow-up commit):
 *    dispatcher.register('/stats', makeStatsHandler(ctx));
 */
export function makeStatsHandler(
  ctx: StatsContext,
): (req: unknown) => Promise<StatsReply> {
  return async (req: unknown) => handleStats(req, ctx);
}

/** Convenience builder for the production memory-usage provider — kept here
 *  (vs. inline at the daemon-shell call site) so the `process.memoryUsage()`
 *  surface area is in one place. Tests do NOT use this; they inject a
 *  pinned stub. */
export function defaultMemoryUsageProvider(): () => MemorySnapshot {
  return () => {
    const m = process.memoryUsage();
    return { rss: m.rss, heapUsed: m.heapUsed };
  };
}
