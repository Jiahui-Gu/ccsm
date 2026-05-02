// electron/daemon/healthzPing.ts
//
// Task #100 (frag-6-7 §6.1) — supervisor-side `/healthz` heartbeat ping.
//
// The Electron-main supervisor pings the daemon's `/healthz` RPC every 5 s
// on the dedicated control transport. Three consecutive misses (15 s
// cumulative) mark the daemon dead and trigger the §6.1 restart cycle. The
// renderer surfaces a yellow banner on the first miss and a red banner on
// the third (copy table §6.1.1).
//
// Spec citations:
//   - frag-6-7 §6.1 "Heartbeat (prod)" — 5 s interval, three-miss restart.
//   - frag-6-7 §6.5 "Health probe + dedicated supervisor transport" — pings
//     run on the control socket, NOT the data socket.
//   - frag-3.4.1 §3.4.1.h SUPERVISOR_RPCS allowlist — `/healthz` is one of
//     the literal control-plane methods.
//
// Constraint (Task #100): the ping does NOT couple to the HMAC handshake.
// `/healthz` is on the control-plane carve-out (frag-3.4.1 §3.4.1.h) and
// MUST be reachable without a prior `daemon.hello`. The ping issues a bare
// envelope frame; whatever HMAC interceptor exists is configured separately
// to exempt the supervisor plane (or this RPC) from verification.
//
// Single Responsibility (per dev contract §2):
//   - PRODUCER: a setInterval timer fires every `intervalMs` (default 5 s).
//   - DECIDER: pure `classifyTick` consumes (lastResultOk, prevConsecutiveMisses)
//     and emits the next state + side-effect intent (banner-update / restart).
//   - SINK: injected callbacks `onMiss(count)`, `onRecover()`, `onRestart()`,
//     `onResult(reply)`. The module performs ZERO socket I/O itself — the
//     `pingFn` is injected so production wires it to `controlClient.call('/healthz')`
//     and tests can pin replies to assert classification.

export interface HealthzPingResult {
  /** Wall-clock ms when the ping was issued. */
  readonly issuedAt: number;
  /** Wall-clock ms when the reply (or failure) settled. */
  readonly settledAt: number;
  /** Reply outcome — `'ok'` for any successful `/healthz` reply (the body is
   *  forwarded but the supervisor does not block on its contents in v0.3),
   *  `'miss'` for any failure mode (transport error, daemon error reply,
   *  timeout). */
  readonly outcome: 'ok' | 'miss';
  /** Forwarded reply value on `'ok'`, or the failure reason on `'miss'`. */
  readonly detail: unknown;
}

/** Pure classifier — given the current miss counter and the latest tick
 *  result, return the next miss counter + the side-effect class. Exported
 *  so tests can drive the FSM without mocking timers. */
export function classifyTick(
  prevConsecutiveMisses: number,
  result: HealthzPingResult,
  thresholdMisses: number,
): {
  readonly nextConsecutiveMisses: number;
  readonly intent: 'ok' | 'miss-warn' | 'miss-restart' | 'recover';
} {
  if (result.outcome === 'ok') {
    return {
      nextConsecutiveMisses: 0,
      intent: prevConsecutiveMisses > 0 ? 'recover' : 'ok',
    };
  }
  const next = prevConsecutiveMisses + 1;
  if (next >= thresholdMisses) {
    return { nextConsecutiveMisses: next, intent: 'miss-restart' };
  }
  return { nextConsecutiveMisses: next, intent: 'miss-warn' };
}

/** Per-tick hook surface. All callbacks are optional so callers wire only
 *  the side effects they care about. None of them throw — production
 *  wraps each in try/catch at the call site. */
export interface HealthzPingHooks {
  /** Fires after every settled tick — both `'ok'` and `'miss'`. Useful for
   *  forensics ring buffers; not load-bearing for the FSM. */
  readonly onResult?: (result: HealthzPingResult) => void;
  /** Fires on the FIRST miss (counter went 0 → 1) and on every subsequent
   *  miss BEFORE the threshold is reached. The supervisor wires this to the
   *  yellow-banner IPC. `count` is the current consecutive-miss counter
   *  (always ≥ 1, always < thresholdMisses). */
  readonly onMiss?: (count: number) => void;
  /** Fires when the daemon misses the `thresholdMisses`-th consecutive
   *  ping. Wires to the red-banner IPC + the §6.1 restart cycle. The hook
   *  fires ONCE per restart event — subsequent ticks are suppressed until
   *  `onRecover()` resets the FSM (or the caller stops the pinger). */
  readonly onRestart?: (count: number) => void;
  /** Fires when a successful ping arrives AFTER one or more misses. Resets
   *  the banner to clear. Does NOT fire on the steady-state `ok → ok`
   *  transition (use `onResult` for that). */
  readonly onRecover?: () => void;
}

export interface HealthzPingOptions {
  /** Issues one `/healthz` request and resolves with the settled result.
   *  Production wires this to `controlClient.call('/healthz')` mapped
   *  through `mapRpcReplyToResult`. Tests inject a pinned async function. */
  readonly pingFn: (deadlineMs: number) => Promise<HealthzPingResult>;
  /** Ping interval in ms (frag-6-7 §6.1 default = 5_000). */
  readonly intervalMs?: number;
  /** Per-ping deadline in ms. Production = the interval (5 s) so a stuck
   *  ping is treated as a miss before the next tick fires. */
  readonly deadlineMs?: number;
  /** Consecutive-miss threshold for the restart hook (frag-6-7 §6.1
   *  default = 3 → 15 s). */
  readonly thresholdMisses?: number;
  /** Hook surface — see `HealthzPingHooks`. */
  readonly hooks?: HealthzPingHooks;
  /** Test seam — defaults to `setInterval` / `clearInterval`. */
  readonly setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
  /** Wall-clock provider (test seam). Defaults to `() => Date.now()`. */
  readonly nowFn?: () => number;
}

export interface HealthzPinger {
  /** Start the heartbeat. Idempotent — calling twice is a no-op. */
  start(): void;
  /** Stop the heartbeat. Idempotent. Pending in-flight pings are NOT
   *  awaited; their late-arriving results are dropped. */
  stop(): void;
  /** Snapshot for tests / debug overlays. */
  readonly state: 'idle' | 'running' | 'restart-pending';
  readonly consecutiveMisses: number;
  /** Manually trigger one tick — used by tests to drive the FSM
   *  deterministically without waiting for the interval. */
  tickNow(): Promise<void>;
}

/** Default per-ping deadline + interval (frag-6-7 §6.1). */
export const DEFAULT_HEALTHZ_INTERVAL_MS = 5_000;
export const DEFAULT_HEALTHZ_THRESHOLD_MISSES = 3;

export function createHealthzPinger(opts: HealthzPingOptions): HealthzPinger {
  const intervalMs = opts.intervalMs ?? DEFAULT_HEALTHZ_INTERVAL_MS;
  const deadlineMs = opts.deadlineMs ?? intervalMs;
  const thresholdMisses = opts.thresholdMisses ?? DEFAULT_HEALTHZ_THRESHOLD_MISSES;
  const hooks = opts.hooks ?? {};
  const setIntervalFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearIntervalFn ?? ((h) => clearInterval(h));
  const nowFn = opts.nowFn ?? (() => Date.now());

  let state: 'idle' | 'running' | 'restart-pending' = 'idle';
  let consecutiveMisses = 0;
  let handle: ReturnType<typeof setInterval> | null = null;
  let inflightToken = 0;

  async function tick(): Promise<void> {
    if (state === 'restart-pending') return;
    const myToken = ++inflightToken;
    const issuedAt = nowFn();
    let result: HealthzPingResult;
    try {
      result = await opts.pingFn(deadlineMs);
    } catch (err) {
      result = {
        issuedAt,
        settledAt: nowFn(),
        outcome: 'miss',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    // Drop late results: if stop() ran (or another tick already advanced the
    // FSM past restart), the late reply is forensic-only. Re-read state into
    // a widely-typed local because TS narrows `state` to `'running'` from the
    // early-return at the top of the function and never widens it back across
    // the `await` (the value can mutate during the await but TS can't track
    // that through the closure).
    const stateAfterAwait = state as 'idle' | 'running' | 'restart-pending';
    if (stateAfterAwait === 'idle' || stateAfterAwait === 'restart-pending') return;
    if (myToken !== inflightToken) {
      // A subsequent tick already started; we still record the result for
      // the result hook but skip FSM updates so we don't double-count.
      try { hooks.onResult?.(result); } catch { /* swallow */ }
      return;
    }
    try { hooks.onResult?.(result); } catch { /* swallow */ }

    const decision = classifyTick(consecutiveMisses, result, thresholdMisses);
    consecutiveMisses = decision.nextConsecutiveMisses;
    switch (decision.intent) {
      case 'ok':
        // Steady state — no hook beyond onResult.
        break;
      case 'recover':
        try { hooks.onRecover?.(); } catch { /* swallow */ }
        break;
      case 'miss-warn':
        try { hooks.onMiss?.(consecutiveMisses); } catch { /* swallow */ }
        break;
      case 'miss-restart':
        state = 'restart-pending';
        try { hooks.onRestart?.(consecutiveMisses); } catch { /* swallow */ }
        break;
    }
  }

  function start(): void {
    if (state !== 'idle') return;
    state = 'running';
    handle = setIntervalFn(() => {
      void tick();
    }, intervalMs);
    // Allow the Node event loop to exit while the heartbeat is the only
    // remaining timer (Electron-main has its own keep-alive — we don't want
    // a stray pinger to block process exit during tests).
    (handle as unknown as { unref?: () => void }).unref?.();
  }

  function stop(): void {
    if (state === 'idle') return;
    state = 'idle';
    if (handle) {
      clearIntervalFn(handle);
      handle = null;
    }
    inflightToken++; // invalidate any in-flight tick
  }

  return {
    start,
    stop,
    get state() { return state; },
    get consecutiveMisses() { return consecutiveMisses; },
    tickNow: tick,
  };
}

/** Adapt a raw `RpcReply<unknown>` (from `rpcClient.call('/healthz')`) into
 *  the `HealthzPingResult` shape. Production callers use this to build the
 *  `pingFn` for `createHealthzPinger`:
 *
 *    const pingFn = async (deadlineMs) => {
 *      const issuedAt = Date.now();
 *      try {
 *        const reply = await client.call('/healthz', undefined, { timeoutMs: deadlineMs });
 *        return mapRpcReplyToResult(issuedAt, Date.now(), reply);
 *      } catch (err) {
 *        return { issuedAt, settledAt: Date.now(), outcome: 'miss', detail: String(err) };
 *      }
 *    };
 */
export function mapRpcReplyToResult(
  issuedAt: number,
  settledAt: number,
  reply: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } },
): HealthzPingResult {
  if (reply.ok) {
    return { issuedAt, settledAt, outcome: 'ok', detail: reply.value };
  }
  return {
    issuedAt,
    settledAt,
    outcome: 'miss',
    detail: `${reply.error.code}: ${reply.error.message}`,
  };
}
