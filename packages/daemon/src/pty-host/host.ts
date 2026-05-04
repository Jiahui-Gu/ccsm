// pty-host parent surface — spawns one OS process per session via
// `child_process.fork`. Spec ch06 §1 (FOREVER-STABLE):
//
//   - `child_process.fork`, NOT `worker_threads`. F3-locked. The
//     architectural reason is failure containment + v0.4 per-principal
//     uid drop additivity (see the spec for the full argument).
//   - One child per session. The child is the parent of the `claude`
//     CLI process; killing the child reaps `claude` automatically.
//   - The IPC channel is the built-in `child.send` / `child.on('message')`
//     pair. JSON envelope is what `child_process.fork` provides; binary
//     payloads (snapshot bytes) cross as `Buffer` instances within the
//     envelope (Node serializes them transparently).
//
// T4.1 scope: the lifecycle skeleton — spawn → ready handshake → close
// or crash. Snapshot / delta / SendInput plumbing wires up in T4.6+.
//
// SRP: this module is a *producer* of child handles (lifecycle events).
// It does NOT decide UTF-8 env (that is `spawn-env.ts`), it does NOT
// touch SQLite (T5.x), and it does NOT own per-subscriber Connect-stream
// fan-out (the per-session in-memory broadcast lives in
// `pty-emitter.ts`'s `PtySessionEmitter`; per-subscriber backpressure +
// AckPty watermark live in `rpc/pty-attach.ts` per Task #49 / T4.13).
// host.ts only routes child→host IPC `delta` / `snapshot` IPCs into the
// per-session emitter (and into the SQLite coalescer when one is
// injected for T4.11a); the emitter itself fans them out to every
// subscribed Attach stream.

import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { computeUtf8SpawnEnv } from './spawn-env.js';
import {
  PtySessionEmitter,
  registerEmitter as registerEmitterDefault,
  unregisterEmitter as unregisterEmitterDefault,
} from './pty-emitter.js';
import {
  DEGRADED_COOLDOWN_MS,
  decideDegraded,
} from './degraded-state.js';
import type {
  ChildExit,
  ChildToHostMessage,
  HostToChildMessage,
  SnapshotMessage,
  SpawnPayload,
} from './types.js';
import type { SnapshotWrite } from '../sqlite/coalescer.js';
import type { SnapshotStore } from '../storage/snapshot-store.js';
import { decideRestoreReplay } from './replay.js';

/**
 * Configuration for `spawnPtyHostChild`. All fields beyond `payload`
 * are optional and have spec-driven defaults; tests may override
 * `childEntrypoint` to inject a fixture script (e.g. one that exits
 * immediately) without rebuilding the daemon dist.
 */
export interface SpawnPtyHostChildOptions {
  /** Per-session spawn parameters forwarded as the first IPC message. */
  readonly payload: SpawnPayload;
  /**
   * Override the child entrypoint script. Defaults to the sibling
   * `child.js` resolved relative to *this* module's URL — i.e. the
   * compiled `dist/pty-host/child.js` in production builds and the
   * `src/pty-host/child.ts` (via tsx) when imported under the daemon's
   * vitest config (which transparently resolves `.js` to `.ts`).
   *
   * Tests pass an absolute path to a `.cjs` / `.mjs` fixture; production
   * code does not need to set this.
   */
  readonly childEntrypoint?: string;
  /**
   * Override the env passed to the forked child (NOT the env handed to
   * `claude`). Tests use this to set `CCSM_PTY_TEST_*` flags; production
   * leaves it `undefined` to inherit `process.env` verbatim.
   */
  readonly forkEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Override `process.platform` for the UTF-8 spawn-env computation.
   * Useful in cross-platform tests; production omits it.
   */
  readonly platformOverride?: NodeJS.Platform;
  /**
   * macOS UTF-8 locale to use if the daemon's startup probe found that
   * `C.UTF-8` is not registered. Forwarded into `computeUtf8SpawnEnv`.
   */
  readonly darwinFallbackLocale?: string;
  /**
   * Per-session in-memory emitter wiring (T-PA-5 / spec
   * `2026-05-04-pty-attach-handler.md` §2.3, §9.2).
   *
   * When unset (the production default), `spawnPtyHostChild` constructs
   * a {@link PtySessionEmitter} on the child's `'ready'` IPC, registers
   * it in the module-level registry (so `getEmitter(sessionId)` from
   * `pty-emitter.ts` returns it), routes every `'delta'` / `'snapshot'`
   * IPC into the emitter, and tears it down (`emitter.close()` +
   * `unregisterEmitter`) when the child exits. The Attach handler
   * (T-PA-6, future PR) consumes the emitter via `getEmitter(sessionId)`.
   *
   * Tests that exercise the lifecycle skeleton without the emitter
   * surface (e.g. host.spec.ts fixtures that reuse the same sessionId
   * across `it` cases and would otherwise trip the registry's
   * duplicate-id guard) pass `emitterRegistry: 'disabled'`. The IPC
   * 'message' / 'exit' wiring then skips emitter publish/teardown
   * entirely; the rest of the lifecycle (ready / exited / messages
   * iterator) is unaffected.
   *
   * Tests that want to exercise the wire-up without polluting the
   * module-level registry pass a throwaway `{ register, unregister }`
   * pair — the emitter is still constructed, but the lookup path uses
   * the injected registry instead of the module singleton.
   */
  readonly emitterRegistry?:
    | 'disabled'
    | {
        readonly register: (emitter: PtySessionEmitter) => void;
        readonly unregister: (sessionId: string) => boolean;
      };
  /**
   * Optional sink that receives every well-formed `'snapshot'` IPC the
   * child sends, mapped from the IPC {@link SnapshotMessage} shape into a
   * {@link SnapshotWrite} (the coalescer's narrow payload).
   *
   * T4.11a (Task #386) wire-up: spec ch07 §5 assumes a SQLite write path
   * exists for snapshots so the 3-strike DEGRADED counter has something to
   * count against. Before this wire-up, the snapshot IPC was only fanned
   * out to the in-memory {@link PtySessionEmitter}; there was no caller of
   * {@link import('../sqlite/coalescer.js').WriteCoalescer.enqueueSnapshot}
   * anywhere in the daemon. Routing snapshots into both the emitter (live
   * fan-out) and the coalescer (durable persistence) is non-mutually-
   * exclusive: the emitter feeds Attach subscribers from RAM, the
   * coalescer persists to `pty_snapshot` for cold-attach replay.
   *
   * Production: daemon main constructs the {@link import('../sqlite/coalescer.js').WriteCoalescer}
   * once at boot (with the shared SQLite handle) and passes the same
   * instance into every `spawnPtyHostChild` call. Tests may pass a stub
   * implementing only `enqueueSnapshot` (duck-typed) to assert call
   * shape without standing up a real DB.
   *
   * Unset (or explicitly `undefined`) opts the snapshot→SQLite path out
   * entirely — useful for tests covering only the emitter / lifecycle
   * surfaces and for the daemon-boot path before T5.x stitches the
   * coalescer in. The emitter fan-out is unaffected by this option.
   *
   * The 60s DEGRADED cooldown + `session_state_changed` PtyFrame proto
   * change land in Task #385 (this PR): when the coalescer emits
   * `'session-degraded'` (3-strike disk-class failures, see
   * `sqlite/coalescer.ts` `recordFailure`), host.ts flips the per-session
   * gate CLOSED for {@link DEGRADED_COOLDOWN_MS} ms — subsequent snapshot
   * IPCs land in the in-memory emitter ring (live attach unaffected) but
   * are NOT forwarded to `enqueueSnapshot` until the cooldown elapses.
   * On `'session-recovered'` (a successful write resets the counter) the
   * gate reopens and a `RUNNING` transition is broadcast.
   *
   * The `on` field is OPTIONAL because most unit tests stub the
   * coalescer with a duck-typed `enqueueSnapshot` only — without an
   * event source those tests never fire a degraded transition and the
   * gate stays open. Production wiring passes the real `WriteCoalescer`
   * (which extends EventEmitter) so the wire-up is automatic.
   */
  readonly coalescer?: {
    readonly enqueueSnapshot: (write: SnapshotWrite) => void;
    readonly on?: (
      event: 'session-degraded' | 'session-recovered',
      listener: (sessionId: string, lastError?: Error) => void,
    ) => unknown;
    readonly off?: (
      event: 'session-degraded' | 'session-recovered',
      listener: (sessionId: string, lastError?: Error) => void,
    ) => unknown;
  };
  /**
   * Test seam for the DEGRADED cooldown clock. Defaults to `Date.now`
   * in production. Tests pass a controllable clock so they can step
   * across the 60s boundary without `vi.useFakeTimers()` (which would
   * also stall the IPC pump's `setTimeout(20)` exit-defer in the
   * fixture). See `host.spec.ts` "DEGRADED cooldown" describe block.
   */
  readonly nowMs?: () => number;
  /**
   * Optional read-only SQLite resolver used to hydrate a freshly-spawned
   * pty-host child from the most-recent persisted snapshot + post-snap
   * deltas — Task #51 / T4.14, spec ch06 §7 ("Daemon restart replay").
   *
   * When set, after the child sends `'ready'` AND the per-session
   * {@link PtySessionEmitter} is constructed, host.ts:
   *   1. calls `priorState.getLatestSnapshot(sessionId)` + `getDeltasSince(...)`
   *      to materialize any prior in-memory state from the previous
   *      daemon process;
   *   2. feeds the rows into the pure {@link decideRestoreReplay} decider
   *      (`./replay.ts`) which validates monotonicity + builds the
   *      hydration plan;
   *   3. for the `hydrate` verdict, re-publishes the prior snapshot then
   *      each post-snap delta through the emitter, in order. Subscribers
   *      attaching after the restart see exactly the same in-memory
   *      state the previous daemon had at the moment it died.
   *
   * The child's own synthetic baseSeq=0 snapshot (spec §3.3, fired on
   * `'ready'`) is published FIRST (it lands during the same IPC
   * `'message'` handler that triggers our hydration). Our hydrated
   * snapshot then OVERWRITES `currentSnapshot` in the emitter — which
   * is the desired effect: the restored state supersedes the cold-start
   * empty buffer. New `Attach` calls with `since_seq=0` see the
   * restored snapshot per the T-PA-2 attach decider.
   *
   * Unset (the production cold-boot path or first-ever-spawn path)
   * skips the entire hydration block — the emitter starts empty and
   * the child's synthetic snapshot is the only state subscribers see.
   * Cold start is the {@link RestorePlanColdStart} verdict, which is
   * also what the decider returns when `getLatestSnapshot` returns
   * `null`.
   *
   * Spec coverage: see `./replay.ts` for the FOREVER-STABLE invariants
   * the decider locks (snapshot is most-recent; deltas are contiguous
   * from baseSeq+1; corrupt seq gap → snapshot-only fallback).
   *
   * Forward-compat note (T4.6): when xterm-headless lands inside the
   * pty-host child, the hydration plan will additionally be sent over
   * IPC to the child so its `xterm-headless.write()` replay matches
   * the in-memory emitter state. The seq-anchor for the new child's
   * accumulator (currently `firstSeq = 1` per child.ts) will move to
   * `plan.nextEmitSeq`. Today, with node-pty + xterm-headless still
   * stubbed in the child, the emitter-only hydration is sufficient
   * to prove the wire-up against the daemon-boot e2e harness.
   */
  readonly priorState?: SnapshotStore;
}

/**
 * Handle returned by `spawnPtyHostChild`. Exposes only the surface the
 * daemon main process needs in T4.1: send the close signal, observe the
 * exit, and read the resolved spawn-env that *would* be passed to the
 * `claude` CLI subprocess (used by T4.2's per-OS argv shaping + by the
 * 1-hour soak harness's snapshot byte-equality assertion).
 *
 * The `messages` async iterator yields every well-formed IPC message
 * from the child until the child exits or disconnects. Malformed
 * messages are dropped silently (the child is trusted code; this is
 * defensive for forward-compat where a future T4.x adds a kind the
 * daemon hasn't been recompiled to handle yet).
 */
export interface PtyHostChildHandle {
  /** Session id this child owns (mirrors `payload.sessionId`). */
  readonly sessionId: string;
  /** Underlying child PID; useful for crash_log rows + log lines. */
  readonly pid: number;
  /** Resolved UTF-8 env that this child will pass to `claude` on
   *  spawn. Computed once at fork time; immutable after. */
  readonly claudeSpawnEnv: Readonly<Record<string, string>>;
  /** Resolves with the child's first `ready` message (after which the
   *  daemon may begin sending input / resize messages). Rejects if the
   *  child exits before sending `ready`. */
  ready(): Promise<void>;
  /** Send a single host→child IPC message. Throws if the channel has
   *  been disconnected or the child has exited. */
  send(msg: HostToChildMessage): void;
  /** Resolves with the child exit outcome. Always resolves (never
   *  rejects); the daemon distinguishes graceful vs crash via
   *  `result.reason` per ch06 §1. */
  exited(): Promise<ChildExit>;
  /** Async iterator over every well-formed child→host message. Ends
   *  when the child disconnects or exits. */
  messages(): AsyncIterable<ChildToHostMessage>;
  /** Convenience: send `{kind:'close'}` and await graceful exit. If the
   *  child does not exit within `timeoutMs`, falls through with a
   *  `SIGKILL` so the caller is never blocked. Returns the observed
   *  {@link ChildExit}. */
  closeAndWait(timeoutMs?: number): Promise<ChildExit>;
}

const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Resolve the default child entrypoint path at runtime. We resolve
 * relative to *this module's* URL so the same code works whether the
 * daemon is running from source (`src/pty-host/host.ts` →
 * `src/pty-host/child.ts`) or from the SEA-built dist
 * (`dist/pty-host/host.js` → `dist/pty-host/child.js`).
 */
function defaultChildEntrypoint(): string {
  const here = fileURLToPath(import.meta.url);
  // Replace the basename `host.{ts,js}` with `child.{ts,js}`. Use the
  // same extension as `here` so source-mode and dist-mode both work.
  const ext = here.endsWith('.ts') ? '.ts' : '.js';
  return join(dirname(here), `child${ext}`);
}

/**
 * Spawn a per-session pty-host child via `child_process.fork`.
 *
 * The returned handle does NOT auto-send the spawn payload — the caller
 * decides when to call `send({kind:'spawn', payload})`. This split keeps
 * the IPC handshake observable in tests (a test can subscribe to
 * `messages()` before the spawn is sent and see the full sequence).
 *
 * Spec invariants enforced here:
 *   - `child_process.fork` is the spawn primitive (not `spawn`, not
 *     `worker_threads.Worker`). Forever-stable.
 *   - The child receives `stdin = stdout = stderr = 'inherit'` so any
 *     accidental `console.log` from native modules is captured by the
 *     daemon's stdout (which the install-time log scrape already tails
 *     per ch10 §6). The IPC channel is `'ipc'` per `fork`'s default.
 *   - The child's env inherits the daemon's env by default. The UTF-8
 *     contract env (the env *for `claude`*, NOT for the child) is
 *     computed eagerly via `computeUtf8SpawnEnv` and surfaced on the
 *     handle so the child can request it via a future RPC if needed —
 *     T4.1 just exposes it.
 */
export function spawnPtyHostChild(opts: SpawnPtyHostChildOptions): PtyHostChildHandle {
  const entrypoint = opts.childEntrypoint ?? defaultChildEntrypoint();
  const platform = opts.platformOverride ?? process.platform;
  const claudeSpawnEnv = computeUtf8SpawnEnv({
    platform,
    inheritedEnv: process.env,
    darwinFallbackLocale: opts.darwinFallbackLocale,
    envExtra: opts.payload.envExtra,
  });

  const child: ChildProcess = fork(entrypoint, [], {
    // 'ipc' is implicit but spelled out for grep-ability.
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: opts.forkEnv
      ? Object.fromEntries(
          Object.entries(opts.forkEnv).filter(([, v]) => v !== undefined),
        ) as Record<string, string>
      : process.env as Record<string, string>,
    serialization: 'advanced', // lets us pass Buffer / Uint8Array later
  });

  const sessionId = opts.payload.sessionId;

  // --- T-PA-5 emitter wiring ---------------------------------------------
  // Resolve the registry seam (default: production module-level registry).
  // 'disabled' opts the wire-up out entirely so unit tests that re-use a
  // sessionId across `it` cases don't trip the registry's duplicate-id
  // guard (see SpawnPtyHostChildOptions.emitterRegistry jsdoc).
  const emitterRegistry =
    opts.emitterRegistry === 'disabled'
      ? null
      : opts.emitterRegistry ?? {
          register: registerEmitterDefault,
          unregister: unregisterEmitterDefault,
        };
  // The emitter is constructed lazily on the child's `'ready'` IPC (per
  // spec §2.3: "created when the pty-host child's `ready` IPC fires").
  // Holding a let-binding here lets the `'message'` and `'exit'` handlers
  // both reach it without reaching back into the registry on every IPC.
  let emitter: PtySessionEmitter | null = null;

  // --- T4.11b DEGRADED state wire-up (Task #385) -------------------------
  // Per-session bookkeeping for the 3-strike + 60 s cooldown decider in
  // ./degraded-state.ts. The coalescer owns the *strike count* (it sees
  // every disk-class failure on its own write paths); we mirror it here
  // via the 'session-degraded' / 'session-recovered' events because
  // `decideDegraded` needs the count + last-failure timestamp to
  // determine the gate state for every snapshot enqueue attempt.
  //
  // Flow (spec ch06 §4):
  //   1. coalescer.enqueueSnapshot fails with disk-class error.
  //   2. coalescer increments its internal counter; on the 3rd consecutive
  //      failure it emits 'session-degraded'. We bump our local
  //      `degradedFailures` to the threshold and stamp `lastFailureMs`.
  //   3. host.ts publishSessionStateChanged('DEGRADED') via the emitter
  //      (subscribers see PtyFrame.session_state_changed on the wire).
  //   4. For the next 60s, every snapshot IPC arriving from the child is
  //      gated CLOSED — we skip the enqueueSnapshot call entirely (the
  //      in-memory emitter fan-out still runs). This implements the spec
  //      "stops attempting snapshot writes for this session for the next
  //      60 seconds" exactly.
  //   5. After the 60s mark, `decideDegraded` returns gateOpen=true and
  //      we let the next snapshot through. If it fails again, the
  //      coalescer re-emits 'session-degraded' and the cycle restarts; if
  //      it succeeds, the coalescer emits 'session-recovered' and we
  //      reset the counter + publish 'RUNNING'.
  const nowMs = opts.nowMs ?? (() => Date.now());
  let degradedFailures = 0;
  let lastFailureMs: number | null = null;
  let degradedReportedState: 'RUNNING' | 'DEGRADED' = 'RUNNING';
  // Hold onto the bound listeners so we can unsubscribe in the exit
  // handler (production WriteCoalescer is shared across many sessions;
  // leaking listeners would accumulate over a daemon's uptime).
  let onCoalescerDegraded: ((sid: string, err?: Error) => void) | null = null;
  let onCoalescerRecovered: ((sid: string) => void) | null = null;

  /**
   * Re-evaluate the DEGRADED decider and, if the reported state changed
   * since last call, publish a session-state-changed event through the
   * emitter. Called after every coalescer event AND after every snapshot
   * gate check (so a stale DEGRADED reported during cooldown promotes
   * back to RUNNING speculatively at the t+60s mark, matching the
   * decider's own "cooldown elapsed → RUNNING" semantics).
   */
  function reconcileDegradedState(reasonOverride?: string): void {
    if (emitter === null) return;
    const decision = decideDegraded({
      consecutiveFailures: degradedFailures,
      lastFailureAtMs: lastFailureMs,
      nowMs: nowMs(),
    });
    if (decision.state !== degradedReportedState) {
      const reason =
        reasonOverride ??
        (decision.state === 'DEGRADED'
          ? `snapshot write failure x${degradedFailures}; cooldown ${DEGRADED_COOLDOWN_MS}ms`
          : 'snapshot write cooldown elapsed; resuming writes');
      emitter.publishSessionStateChanged({
        state: decision.state,
        reason,
        sinceUnixMs: nowMs(),
      });
      degradedReportedState = decision.state;
    }
  }

  // --- Lifecycle wiring ---------------------------------------------------
  let exitOutcome: ChildExit | null = null;
  let observedGracefulExitNotice = false;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  const readyPromise = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  let exitedResolve: ((x: ChildExit) => void) | null = null;
  const exitedPromise = new Promise<ChildExit>((resolve) => {
    exitedResolve = resolve;
  });

  // Buffered message queue + waiters for the async iterator.
  const queue: ChildToHostMessage[] = [];
  const waiters: Array<(r: IteratorResult<ChildToHostMessage>) => void> = [];
  let iteratorClosed = false;

  function pushMessage(msg: ChildToHostMessage): void {
    if (iteratorClosed) return;
    const w = waiters.shift();
    if (w) {
      w({ value: msg, done: false });
    } else {
      queue.push(msg);
    }
  }
  function closeIterator(): void {
    if (iteratorClosed) return;
    iteratorClosed = true;
    while (waiters.length > 0) {
      const w = waiters.shift();
      w?.({ value: undefined as never, done: true });
    }
  }

  child.on('message', (raw: unknown) => {
    if (!isChildToHostMessage(raw)) {
      // Drop silently — see jsdoc on `messages()` for rationale.
      return;
    }
    if (raw.kind === 'ready' && readyResolve) {
      readyResolve();
      readyResolve = null;
      readyReject = null;
      // T-PA-5 / spec §2.3: construct the per-session emitter on `'ready'`
      // and register it so the Attach handler (T-PA-6) can find it via
      // `getEmitter(sessionId)`. We use the host-side `sessionId`
      // (resolved at fork time from `opts.payload.sessionId`) rather than
      // the IPC payload's sessionId field — the host always knows its own
      // session id and the child currently sends an empty string in the
      // T4.1 stub (see child.ts: `send({kind:'ready', sessionId:''})`).
      if (emitterRegistry !== null && emitter === null) {
        try {
          emitter = new PtySessionEmitter(sessionId);
          emitterRegistry.register(emitter);
        } catch (err) {
          // Registration failure (e.g. duplicate sessionId) is a daemon
          // wire-up bug, not a per-session runtime error. Log and clear
          // the local ref so the IPC route below doesn't try to publish
          // into a half-initialized emitter; the lifecycle (ready /
          // exited / messages iterator) is unaffected.
          // eslint-disable-next-line no-console
          console.error(
            `[ccsm-daemon] spawnPtyHostChild(${sessionId}): emitter register failed`,
            err,
          );
          emitter = null;
        }
        // T4.11b (Task #385) — subscribe to the coalescer's degraded /
        // recovered events so we can flip the per-session gate + publish
        // PtyFrame.session_state_changed via the emitter. Filtered to
        // OUR sessionId (the coalescer is shared across all sessions in
        // production). Done here (not at construction time) because
        // emitter is only valid after a successful 'ready'; subscribing
        // earlier would let an out-of-order degraded event reach a null
        // emitter.
        if (
          emitter !== null &&
          opts.coalescer !== undefined &&
          typeof opts.coalescer.on === 'function'
        ) {
          onCoalescerDegraded = (sid: string) => {
            if (sid !== sessionId) return;
            // Mirror the coalescer's threshold semantically — we don't
            // need the exact count, just "at or above threshold".
            // The decider treats >=THRESHOLD identically (see
            // degraded-state.spec.ts "treats higher strike counts the
            // same as the 3rd strike").
            degradedFailures = Math.max(
              degradedFailures + 1,
              // bump to threshold on first observation so the gate
              // closes immediately even if our counter started at 0
              3,
            );
            lastFailureMs = nowMs();
            reconcileDegradedState();
          };
          onCoalescerRecovered = (sid: string) => {
            if (sid !== sessionId) return;
            degradedFailures = 0;
            lastFailureMs = null;
            reconcileDegradedState('snapshot probe succeeded; resuming writes');
          };
          opts.coalescer.on('session-degraded', onCoalescerDegraded);
          opts.coalescer.on('session-recovered', onCoalescerRecovered);
        }
      }
      // T4.14 (Task #51) — post-restart hydration. Runs INSIDE the
      // 'ready' handler AFTER the emitter is constructed AND after
      // the coalescer event subscriptions are wired (so a
      // mid-hydration degraded transition still flips state cleanly).
      // Spec ch06 §7: "restored pty-host hydrates xterm-headless from
      // snapshot then writes the post-snapshot deltas back". Today,
      // with xterm-headless still stubbed inside the child, the
      // hydration is emitter-only — subscribers see the prior snapshot
      // + deltas via Attach, which is exactly what the daemon-boot
      // e2e harness asserts (see daemon-boot-end-to-end.spec.ts §T4.14).
      //
      // The hydration intentionally fires AFTER the child's synthetic
      // baseSeq=0 snapshot lands (which it does later in this same
      // 'message' handler — see the `raw.kind === 'snapshot'` branch
      // below). Order across IPC ticks: child's `'ready'` + synthetic
      // 'snapshot' arrive in two consecutive 'message' callbacks; we
      // schedule the hydration via `queueMicrotask` so it runs AFTER
      // the synthetic snapshot has been published into the emitter
      // (replacing the cold-start state) — the hydrated snapshot then
      // OVERRIDES `currentSnapshot` which is the desired effect (the
      // restored state supersedes the cold-start empty buffer).
      if (emitter !== null && opts.priorState !== undefined) {
        const store = opts.priorState;
        const liveEmitter = emitter;
        // Capture the sessionId in closure to avoid shadowing.
        const sid = sessionId;
        // queueMicrotask via Promise.resolve().then so we don't reach
        // for the global (eslint env config doesn't list it). Same
        // microtask-queue semantics: the callback runs after the
        // current 'message' handler returns but before any I/O tick.
        void Promise.resolve().then(() => {
          // Re-check both refs — the child could exit between 'ready'
          // and the microtask drain (rare but legal). publish* are
          // no-ops on a closed emitter so this is defense in depth.
          try {
            const latest = store.getLatestSnapshot(sid);
            const deltas =
              latest === null
                ? []
                : store.getDeltasSince(sid, latest.baseSeq);
            const plan = decideRestoreReplay({
              latestSnapshot: latest,
              postSnapDeltas: deltas,
            });
            if (plan.kind === 'no_prior_state') {
              // Cold start — nothing to do; the synthetic baseSeq=0
              // snapshot already published by the child stands.
              return;
            }
            // Both 'hydrate' and 'corrupt_seq_gap' carry a snapshot to
            // republish. publishSnapshot replaces `currentSnapshot` in
            // the emitter (atomic per spec §2.4) — subscribers
            // attaching after this point see the hydrated state via
            // the T-PA-2 attach decider's `since_seq=0` branch.
            liveEmitter.publishSnapshot({
              kind: 'snapshot',
              baseSeq: plan.snapshot.baseSeq,
              schemaVersion: plan.snapshot.schemaVersion,
              geometry: plan.snapshot.geometry,
              screenState: plan.snapshot.screenState,
            });
            if (plan.kind === 'hydrate') {
              for (const delta of plan.deltas) {
                liveEmitter.publishDelta({
                  kind: 'delta',
                  seq: delta.seq,
                  tsUnixMs: delta.tsUnixMs,
                  payload: delta.payload,
                });
              }
              // eslint-disable-next-line no-console
              console.log(
                `[ccsm-daemon] spawnPtyHostChild(${sid}): hydrated from ` +
                  `prior snapshot baseSeq=${plan.snapshot.baseSeq} + ` +
                  `${plan.deltas.length} post-snap deltas (lastReplayedSeq=${plan.lastReplayedSeq})`,
              );
            } else {
              // corrupt_seq_gap — snapshot-only fallback. Logged as
              // an error so ops can grep daemon stdout. No deltas
              // published; the snapshot is recoverable on its own per
              // spec §2.4.
              // eslint-disable-next-line no-console
              console.error(
                `[ccsm-daemon] spawnPtyHostChild(${sid}): replay seq gap detected ` +
                  `(expected=${plan.expectedSeq}, got=${plan.actualSeq}); ` +
                  `falling back to snapshot-only hydration`,
              );
            }
          } catch (err) {
            // Replay failures (SQL errors, malformed rows) MUST NOT
            // crash the daemon main process. The session keeps
            // running off the empty cold-start state — degraded UX
            // (the user sees an empty terminal until fresh deltas
            // arrive) but no data loss in the live stream.
            // eslint-disable-next-line no-console
            console.error(
              `[ccsm-daemon] spawnPtyHostChild(${sid}): replay hydration threw`,
              err,
            );
          }
        });
      }
    }
    if (raw.kind === 'exiting' && raw.reason === 'graceful') {
      observedGracefulExitNotice = true;
    }
    // T-PA-5 / spec §2.3 IPC routing: fan delta + snapshot IPCs into the
    // per-session emitter so subscribers (Attach handler in T-PA-6) see
    // them. The emitter itself is null when wiring is disabled (tests)
    // or when the child sent a delta/snapshot before `'ready'` (a child
    // bug; the fan-out is skipped silently — the daemon's
    // existing-message iterator still surfaces the IPC for diagnosis).
    if (emitter !== null) {
      if (raw.kind === 'snapshot') {
        emitter.publishSnapshot(raw);
      } else if (raw.kind === 'delta') {
        emitter.publishDelta(raw);
      }
    }
    // T4.11a (Task #386) — snapshot→WriteCoalescer wire-up. Runs in
    // parallel with the emitter fan-out above (in-memory live stream)
    // and writes a `pty_snapshot` row for cold-attach replay
    // (spec ch07 §5). Skipped silently when no coalescer was injected
    // (tests covering only emitter/lifecycle surfaces, or daemon-boot
    // paths before T5.x stitches the coalescer in).
    //
    // Mapping IPC SnapshotMessage → SnapshotWrite: the IPC shape
    // (pty-host/types.ts SnapshotMessage) is what the child posts; the
    // coalescer's payload (sqlite/coalescer.ts SnapshotWrite) is the
    // narrow column subset for `pty_snapshot`. We hold sessionId on the
    // host (resolved at fork time from `opts.payload.sessionId`) — the
    // child's IPC envelope intentionally does NOT carry sessionId
    // because the daemon-side IPC channel is one-to-one with a session.
    // `createdMs` uses Date.now() at receive time; the IPC payload does
    // not carry a capture timestamp (spec §2.4 SnapshotMessage), and
    // jitter at this layer is bounded by the IPC RTT (sub-ms locally).
    if (opts.coalescer !== undefined && raw.kind === 'snapshot') {
      // T4.11b (Task #385) cooldown gate. The coalescer's strike counter
      // is the producer of "did we just hit the threshold"; the decider
      // here is the per-IPC gate that turns a stale DEGRADED reported
      // state into "stop calling enqueueSnapshot for the next 60s".
      // Re-evaluating EVERY snapshot IPC means the gate auto-reopens at
      // exactly t+60s without a wall-clock timer.
      const decision = decideDegraded({
        consecutiveFailures: degradedFailures,
        lastFailureAtMs: lastFailureMs,
        nowMs: nowMs(),
      });
      // Reconcile reported state in case the cooldown elapsed since the
      // last event; this can promote DEGRADED → RUNNING speculatively
      // and publish a session-state-changed event so subscribers see the
      // recovery cleanly. Done BEFORE the gate check so a freshly-
      // promoted RUNNING state is consistent with the enqueue we're
      // about to attempt.
      reconcileDegradedState();
      if (!decision.gateOpen) {
        // Gate closed (cooldown active): skip the enqueue. Emitter
        // fan-out above already happened so live attach is unaffected.
        // eslint-disable-next-line no-console
        console.warn(
          `[ccsm-daemon] spawnPtyHostChild(${sessionId}): snapshot suppressed (DEGRADED cooldown active, ${degradedFailures} consecutive failures)`,
        );
      } else {
        const snap = raw satisfies SnapshotMessage;
        try {
          opts.coalescer.enqueueSnapshot({
            kind: 'snapshot',
            sessionId,
            baseSeq: Number(snap.baseSeq),
            schemaVersion: snap.schemaVersion,
            geometryCols: snap.geometry.cols,
            geometryRows: snap.geometry.rows,
            payload: snap.screenState,
            createdMs: Date.now(),
          });
        } catch (err) {
          // The coalescer's documented throw paths are RESOURCE_EXHAUSTED
          // (queue cap) and programmer-error rethrows. Both are session-
          // scoped and must NOT crash the daemon main process — the
          // session keeps running off the in-memory ring (emitter
          // fan-out above). The DEGRADED transition itself fires via
          // the coalescer's 'session-degraded' event after 3 strikes;
          // we don't double-count here.
          // eslint-disable-next-line no-console
          console.error(
            `[ccsm-daemon] spawnPtyHostChild(${sessionId}): coalescer.enqueueSnapshot threw`,
            err,
          );
        }
      }
    }
    pushMessage(raw);
  });

  child.on('error', (err) => {
    if (readyReject) {
      readyReject(err);
      readyReject = null;
      readyResolve = null;
    }
  });

  child.on('exit', (code, signal) => {
    const reason: ChildExit['reason'] = observedGracefulExitNotice && code === 0
      ? 'graceful'
      : 'crashed';
    exitOutcome = { reason, code: code ?? null, signal: signal ?? null };
    if (readyReject) {
      readyReject(new Error(
        `pty-host child for session ${sessionId} exited before ready ` +
        `(code=${String(code)} signal=${String(signal)})`,
      ));
      readyReject = null;
      readyResolve = null;
    }
    // T-PA-5 / spec §7.2 bullet 3: tear down the per-session emitter
    // BEFORE we resolve `exitedPromise`. Order: close() broadcasts the
    // 'closed' event to every Attach subscriber synchronously (the
    // listener forwards it as Code.Canceled + ErrorDetail.code =
    // 'pty.session_destroyed' on the wire — that mapping lives in
    // T-PA-6's Attach handler), then we drop the registry entry so a
    // late `getEmitter(sessionId)` returns undefined. Both steps are
    // idempotent so the wrapping try/catch only guards against a
    // listener throwing during broadcast.
    if (emitter !== null && emitterRegistry !== null) {
      try {
        emitter.close();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[ccsm-daemon] spawnPtyHostChild(${sessionId}): emitter.close() threw`,
          err,
        );
      }
      try {
        emitterRegistry.unregister(sessionId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[ccsm-daemon] spawnPtyHostChild(${sessionId}): emitterRegistry.unregister() threw`,
          err,
        );
      }
      emitter = null;
    }
    // Unsubscribe coalescer listeners. The production WriteCoalescer is
    // shared across all sessions for the lifetime of the daemon; leaking
    // listeners would accumulate across spawns. Tests that pass an
    // EventEmitter-based coalescer rely on this for clean teardown.
    if (
      opts.coalescer !== undefined &&
      typeof opts.coalescer.off === 'function'
    ) {
      if (onCoalescerDegraded !== null) {
        try {
          opts.coalescer.off('session-degraded', onCoalescerDegraded);
        } catch {
          /* best-effort */
        }
      }
      if (onCoalescerRecovered !== null) {
        try {
          opts.coalescer.off('session-recovered', onCoalescerRecovered);
        } catch {
          /* best-effort */
        }
      }
    }
    onCoalescerDegraded = null;
    onCoalescerRecovered = null;
    exitedResolve?.(exitOutcome);
    closeIterator();
  });

  // --- Public surface -----------------------------------------------------
  const handle: PtyHostChildHandle = {
    sessionId,
    pid: child.pid ?? -1,
    claudeSpawnEnv,
    ready: () => readyPromise,
    send(msg) {
      if (exitOutcome !== null) {
        throw new Error(
          `pty-host child for session ${sessionId} has exited; cannot send ${msg.kind}`,
        );
      }
      if (!child.connected) {
        throw new Error(
          `pty-host child for session ${sessionId} IPC channel disconnected`,
        );
      }
      child.send(msg);
    },
    exited: () => exitedPromise,
    messages(): AsyncIterable<ChildToHostMessage> {
      return {
        [Symbol.asyncIterator](): AsyncIterator<ChildToHostMessage> {
          return {
            next(): Promise<IteratorResult<ChildToHostMessage>> {
              const buffered = queue.shift();
              if (buffered !== undefined) {
                return Promise.resolve({ value: buffered, done: false });
              }
              if (iteratorClosed) {
                return Promise.resolve({ value: undefined as never, done: true });
              }
              return new Promise((resolve) => waiters.push(resolve));
            },
            return(): Promise<IteratorResult<ChildToHostMessage>> {
              closeIterator();
              return Promise.resolve({ value: undefined as never, done: true });
            },
          };
        },
      };
    },
    async closeAndWait(timeoutMs = DEFAULT_CLOSE_TIMEOUT_MS): Promise<ChildExit> {
      if (exitOutcome !== null) {
        return exitOutcome;
      }
      if (child.connected) {
        try {
          child.send({ kind: 'close' } satisfies HostToChildMessage);
        } catch {
          // Race: child disconnected between our check and send. Fall
          // through; the exit handler will resolve `exitedPromise`.
        }
      }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<ChildExit>((resolve) => {
        timer = setTimeout(() => {
          if (exitOutcome === null) {
            child.kill('SIGKILL');
          }
          // The 'exit' handler will resolve `exitedPromise` shortly;
          // forward whichever resolves first (this is racy and that's
          // fine — caller wants "the child is gone", not the exact
          // ordering of why).
          void exitedPromise.then(resolve);
        }, timeoutMs);
      });
      try {
        return await Promise.race([exitedPromise, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };

  return handle;
}

/**
 * Type guard for `ChildToHostMessage`. The unknown surface comes from
 * the IPC channel where Node may hand us anything the child JSON.stringify-d
 * (or, with `serialization: 'advanced'`, anything structured-clonable).
 */
function isChildToHostMessage(x: unknown): x is ChildToHostMessage {
  if (typeof x !== 'object' || x === null) return false;
  const k = (x as { kind?: unknown }).kind;
  if (
    k !== 'ready' &&
    k !== 'exiting' &&
    k !== 'delta' &&
    k !== 'snapshot' &&
    k !== 'send-input-rejected'
  ) {
    return false;
  }
  if (k === 'send-input-rejected') {
    // Flat shape per spec 2026-05-04-pty-attach-handler.md §2.2 —
    // pendingWriteBytes + attemptedBytes are top-level fields on the
    // message itself; no nested `payload`, no `sessionId` (the daemon
    // main process knows which child sent it via the IPC channel).
    const pwb = (x as { pendingWriteBytes?: unknown }).pendingWriteBytes;
    const ab = (x as { attemptedBytes?: unknown }).attemptedBytes;
    return (
      typeof pwb === 'number' &&
      Number.isFinite(pwb) &&
      pwb >= 0 &&
      typeof ab === 'number' &&
      Number.isFinite(ab) &&
      ab >= 0
    );
  }
  return true;
}
