// packages/daemon/src/crash/sources.ts
//
// Table-driven crash capture sources for the daemon.
//
// Spec refs:
//   - docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//     ch09 §1 (capture sources — open string set, table of v0.3 named
//     sources + owner_id attribution rules) and ch09 §6.2 (table-driven
//     contract: §1 table mirrored in code as `CAPTURE_SOURCES`; tests
//     iterate the array; adding a v0.4 source = appending one entry).
//   - ch09 §1 rate-limit row: `sqlite_op` records "one entry per ~60s per
//     code-class to prevent flooding". Implemented here (NOT in the
//     appender — the appender is FATAL-path-only and must not deduplicate).
//
// SRP layering — three roles kept separate per dev.md §2:
//   * decider: per-source `format(raw) -> CrashRawEntry` is a pure function
//     mapping raw event payload + a synthesised id/ts/owner_id into the
//     wire shape. No I/O, no clocks (the clock is a `now()` injection).
//   * producer: per-source `install(ctx) -> Unsubscribe` registers the
//     listener with the underlying subsystem (Node `process`, child_process
//     `exit`, `net.Server` `error`, `process.on('SIGABRT')`, the sqlite
//     wrapper's `onError` hook). Returns an idempotent unsubscribe.
//   * sink: a single `installCaptureSources(ctx)` orchestrator wires every
//     entry to a single shared `appendCrashRaw` call. The orchestrator
//     does NOT format; it does NOT decide which source fired; it only
//     plumbs `(source, raw) -> entry -> appendCrashRaw`.
//
// Layer 1 — alternatives checked:
//   - We do NOT add a `ulid` npm dep. The raw-appender's id contract is
//     "non-empty string"; ULID is a hint for "lexicographically time-
//     ordered" so SQLite's PRIMARY KEY index trends append-only. We use
//     `${ts.toString(36).padStart(9,'0')}-${randomUUID()}` which is
//     monotone-by-prefix on ts — matches the property the index cares
//     about without pulling a dep. Time goes backward across NTP steps,
//     same as ulid; both are advisory ordering hints, not crypto.
//   - We do NOT subclass / extend the listener factory from #24. The
//     factory exposes a `Listener` trait with `start()/stop()`; the
//     `listener_bind` source listens on the `'error'` event of the
//     underlying `net.Server` via the factory's `bindHook` injection
//     seam. Wiring lives at boot in `installCaptureSources` — this
//     module knows the contract, not the factory internals.
//   - We do NOT couple to `better-sqlite3` here. The sqlite source
//     receives errors via a `SqliteErrorBus.onError(cb)` shape that
//     `packages/daemon/src/db/sqlite.ts` (T5.x) wires up. Decoupling
//     means tests can fire synthetic errors without opening a DB.
//   - Rate-limit table is per-process in-memory (`Map<string, number>`).
//     A persistent rate-limit would require a SQLite write per attempt,
//     defeating the point of suppressing flood. The 60 s window resets on
//     daemon restart — acceptable per the spec's "to prevent flooding"
//     framing (post-restart we WANT to know the first error again).
//
// Out of scope (separate tasks — DO NOT touch from here):
//   - Wiring sources into the actual daemon boot sequence -> T5.13 boot.
//   - `crash_log` table writes (replay path)                -> #876 schema / #59 replay.
//   - Retention pruner (10000 / 90 days)                    -> T5.12 / Task #64.
//   - Coalescer for non-fatal sources                       -> T5.6 / Task #58.

import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:net';

import { appendCrashRaw, type CrashRawEntry } from './raw-appender.js';

// ---------------------------------------------------------------------------
// Owner-id sentinels — locked by spec ch09 §1.
// ---------------------------------------------------------------------------

/** Sentinel for daemon-side crashes that cannot be tied to a session. */
export const DAEMON_SELF = 'daemon-self' as const;

/** Per-source owner attribution policy (mirrors §1 table column 5). */
export type DefaultOwner = 'daemon-self' | 'session-principal';

/** Severity per §1 table column 3. v0.3 honours `fatal` (exit after append)
 *  and `warn` (append only) policy decisions in the orchestrator (see
 *  `installCaptureSources` notes). */
export type CrashSeverity = 'fatal' | 'warn';

// ---------------------------------------------------------------------------
// Capture-source table-driven types — spec ch09 §6.2 contract.
// ---------------------------------------------------------------------------

/**
 * Function returned by every `install` — caller invokes to detach the
 * underlying listener. Idempotent (safe to call twice).
 */
export type Unsubscribe = () => void;

/**
 * Sink injected by the orchestrator. Each source's `install` calls this
 * once per fire. The sink is normally `appendCrashRaw`-bound but tests
 * inject a spy.
 */
export type CrashSink = (entry: CrashRawEntry) => void;

/**
 * Boot-time context every source needs. The orchestrator builds it once
 * and passes the same instance to every `install`.
 */
export interface CaptureContext {
  /** Append the entry to crash-raw.ndjson (or test sink). */
  readonly sink: CrashSink;
  /** Wall clock — injected so tests can advance time deterministically. */
  readonly now: () => number;
  /** Subsystem hooks each source binds to. Optional fields = source skipped
   *  silently if its dependency isn't wired (boot order tolerance). */
  readonly hooks: CaptureHooks;
}

/** Per-subsystem injection seams. Each is a thin event registrar; sources
 *  never reach into globals (`process` is the lone exception, since it IS
 *  the global subsystem the source captures). */
export interface CaptureHooks {
  /** A child_process the daemon owns, plus the session principal that owns
   *  it. Multiple children = call `installSourceFor('claude_exit', ...)`
   *  per child; this hook is for the orchestrator's "register one" path. */
  readonly claudeChildren?: ChildEventBus;
  /** The Listener A `net.Server`. Sources subscribe to `'error'`. */
  readonly listenerServer?: Server;
  /** Sqlite wrapper's error bus — fires on any prepare/run/all throw. */
  readonly sqliteErrors?: SqliteErrorBus;
  /** Watchdog (linux/systemd) "missed deadline" signal source. Defaults
   *  to `process` (`'SIGABRT'`) which is what systemd sends per ch09 §6.
   *  Tests override with a fake EventEmitter. */
  readonly watchdogSignal?: SignalBus;
}

/** A bus the orchestrator drives for child-process exits. The daemon's
 *  session manager (T6.x) owns the actual `ChildProcess` instances and
 *  posts to this bus on `exit`. Decouples this module from the session
 *  manager. */
export interface ChildEventBus {
  onChildExit(
    cb: (info: ClaudeExitInfo) => void,
  ): Unsubscribe;
}

export interface ClaudeExitInfo {
  readonly sessionId: string;
  readonly principalKey: string;
  readonly child: Pick<ChildProcess, 'pid'>;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  /** Last 4 KiB of stderr ring buffer per §1 table — already trimmed. */
  readonly tailStderr: string;
}

export interface SqliteErrorBus {
  onError(cb: (info: SqliteErrorInfo) => void): Unsubscribe;
}

export interface SqliteErrorInfo {
  /** SQLite extended error code class: e.g. `'SQLITE_BUSY'`,
   *  `'SQLITE_CORRUPT'`, `'SQLITE_IOERR'`. We rate-limit by this string. */
  readonly codeClass: string;
  /** Redacted SQL (caller redacts before posting; we do not parse). */
  readonly redactedSql: string;
  readonly message: string;
  /** Optional session principal — present iff the failing query was
   *  session-scoped (e.g. snapshot write). */
  readonly principalKey?: string;
}

export interface SignalBus {
  on(signal: NodeJS.Signals, cb: () => void): void;
  off(signal: NodeJS.Signals, cb: () => void): void;
}

/**
 * One capture source — table row from spec ch09 §1 mirrored in code per
 * §6.2. The orchestrator iterates `CAPTURE_SOURCES` to install every row.
 *
 * `install` returns an `Unsubscribe`. Sources whose required hook is
 * absent return a no-op unsubscribe — booting without (e.g.) a
 * `listenerServer` should not crash the daemon.
 */
export interface CaptureSource {
  readonly source: string;
  readonly severity: CrashSeverity;
  readonly defaultOwnerId: DefaultOwner;
  /**
   * Wire the underlying event into `ctx.sink`. Returns an `Unsubscribe`
   * that detaches the listener.
   */
  install(ctx: CaptureContext): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Helpers shared by per-source `install` impls.
// ---------------------------------------------------------------------------

/** Build a unique, monotone-by-prefix id. See file header Layer 1 note for
 *  why this beats both `randomUUID()` alone (no time prefix → bad index
 *  locality) and adding a `ulid` dep (one more transitive). */
export function newCrashId(now: () => number = Date.now): string {
  const tsPart = now().toString(36).padStart(9, '0');
  return `${tsPart}-${randomUUID()}`;
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes. Used to keep the
 *  NDJSON line bounded for fields like stack traces and stderr tails. The
 *  spec doesn't mandate a hard cap on line length but multi-MiB stacks
 *  blow the 4 KiB PIPE_BUF atomic-append guarantee — we cap at 64 KiB. */
export function truncateUtf8(s: string, maxBytes: number): string {
  // Fast path — most inputs are ASCII or small.
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  // Walk down byte-budget; cut on a code-point boundary so `JSON.stringify`
  // never produces lone surrogates.
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (Buffer.byteLength(s.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo);
}

const MAX_DETAIL_BYTES = 64 * 1024;

/** Convert any thrown value into a `{summary, detail}` pair safely. */
function describeError(err: unknown): { summary: string; detail: string } {
  if (err instanceof Error) {
    const summary = err.message.length > 0 ? err.message : err.name;
    const detail = truncateUtf8(err.stack ?? `${err.name}: ${err.message}`, MAX_DETAIL_BYTES);
    return { summary, detail };
  }
  if (typeof err === 'string') {
    return { summary: err.slice(0, 200), detail: truncateUtf8(err, MAX_DETAIL_BYTES) };
  }
  let serialised: string;
  try {
    serialised = JSON.stringify(err);
  } catch {
    serialised = String(err);
  }
  return {
    summary: 'non-Error thrown',
    detail: truncateUtf8(serialised, MAX_DETAIL_BYTES),
  };
}

// ---------------------------------------------------------------------------
// `sqlite_op` rate-limit — spec ch09 §1: "one entry per ~60s per code-class
// to prevent flooding". Module-private state intentionally — the limit is
// process-wide and resets on daemon restart by design.
// ---------------------------------------------------------------------------

/** Window in ms — spec says ~60s. */
export const SQLITE_RATE_LIMIT_MS = 60_000;

/**
 * Rate limiter, exported for test injection. One slot per code-class. The
 * orchestrator builds one per `installCaptureSources` call so test
 * harnesses don't leak state between cases.
 */
export class SqliteRateLimiter {
  private readonly lastEmit = new Map<string, number>();
  constructor(private readonly windowMs: number = SQLITE_RATE_LIMIT_MS) {}
  /** Returns true iff this `codeClass` should be emitted now. Records the
   *  emit time on `true`. */
  shouldEmit(codeClass: string, nowMs: number): boolean {
    const last = this.lastEmit.get(codeClass);
    if (last !== undefined && nowMs - last < this.windowMs) return false;
    this.lastEmit.set(codeClass, nowMs);
    return true;
  }
  /** For tests / boot reset. */
  reset(): void {
    this.lastEmit.clear();
  }
}

// ---------------------------------------------------------------------------
// Per-source factories. Each is a function returning a `CaptureSource`
// rather than a literal so it can close over per-install state (the
// rate limiter for sqlite, the process target for uncaughtException).
// ---------------------------------------------------------------------------

/** `process.on('uncaughtException')` — fatal. We append the entry then let
 *  the existing top-level handler exit; we deliberately do NOT call
 *  `process.exit` here (the supervisor / test harness owns exit policy). */
function makeUncaughtException(target: NodeJS.EventEmitter = process): CaptureSource {
  return {
    source: 'uncaughtException',
    severity: 'fatal',
    defaultOwnerId: DAEMON_SELF,
    install(ctx) {
      const handler = (err: Error): void => {
        const { summary, detail } = describeError(err);
        ctx.sink({
          id: newCrashId(ctx.now),
          ts_ms: ctx.now(),
          source: 'uncaughtException',
          summary,
          detail,
          labels: { errorName: err?.name ?? 'unknown' },
          owner_id: DAEMON_SELF,
        });
      };
      target.on('uncaughtException', handler);
      return () => target.off('uncaughtException', handler);
    },
  };
}

/** `claude_exit` — child exit with non-zero code. Severity `warn` per §1
 *  table; owner = session principal. */
function makeClaudeExit(): CaptureSource {
  return {
    source: 'claude_exit',
    severity: 'warn',
    defaultOwnerId: 'session-principal',
    install(ctx) {
      const bus = ctx.hooks.claudeChildren;
      if (bus === undefined) return () => {};
      return bus.onChildExit((info) => {
        // Source only fires on non-zero exits per spec; the bus contract
        // says it only posts non-zero. We still defend (cheap) since a
        // future bus refactor could change.
        if (info.code === 0 && info.signal === null) return;
        ctx.sink({
          id: newCrashId(ctx.now),
          ts_ms: ctx.now(),
          source: 'claude_exit',
          summary: `claude exited code=${info.code ?? 'null'} signal=${info.signal ?? 'null'} session=${info.sessionId}`,
          detail: truncateUtf8(info.tailStderr, MAX_DETAIL_BYTES),
          labels: {
            sessionId: info.sessionId,
            code: String(info.code),
            signal: info.signal ?? '',
            pid: String(info.child.pid ?? ''),
          },
          owner_id: info.principalKey,
        });
      });
    },
  };
}

/** `sqlite_op` — rate-limited 1/60s per code-class. */
function makeSqliteOp(limiterFactory?: () => SqliteRateLimiter): CaptureSource {
  return {
    source: 'sqlite_op',
    severity: 'warn',
    defaultOwnerId: DAEMON_SELF,
    install(ctx) {
      const bus = ctx.hooks.sqliteErrors;
      if (bus === undefined) return () => {};
      const limiter = (limiterFactory ?? (() => new SqliteRateLimiter()))();
      return bus.onError((info) => {
        const nowMs = ctx.now();
        if (!limiter.shouldEmit(info.codeClass, nowMs)) return;
        ctx.sink({
          id: newCrashId(ctx.now),
          ts_ms: nowMs,
          source: 'sqlite_op',
          summary: `${info.codeClass}: ${info.message.slice(0, 200)}`,
          detail: truncateUtf8(
            `${info.codeClass}\nsql: ${info.redactedSql}\n\n${info.message}`,
            MAX_DETAIL_BYTES,
          ),
          labels: {
            codeClass: info.codeClass,
            sql: info.redactedSql,
          },
          owner_id: info.principalKey ?? DAEMON_SELF,
        });
      });
    },
  };
}

/** `listener_bind` — `server.on('error')` during startup step 5. Fatal per
 *  §1 (the daemon cannot serve without Listener A). */
function makeListenerBind(): CaptureSource {
  return {
    source: 'listener_bind',
    severity: 'fatal',
    defaultOwnerId: DAEMON_SELF,
    install(ctx) {
      const server = ctx.hooks.listenerServer;
      if (server === undefined) return () => {};
      const handler = (err: Error & { code?: string }): void => {
        const { summary, detail } = describeError(err);
        ctx.sink({
          id: newCrashId(ctx.now),
          ts_ms: ctx.now(),
          source: 'listener_bind',
          summary: `listener bind failed: ${summary}`,
          detail,
          labels: {
            errno: err?.code ?? '',
          },
          owner_id: DAEMON_SELF,
        });
      };
      server.on('error', handler);
      return () => server.off('error', handler);
    },
  };
}

/** `watchdog_miss` — systemd sends SIGABRT when WATCHDOG=1 stops landing.
 *  We capture the signal, append, and let the default handler take over
 *  (the OS will core-dump / restart). */
function makeWatchdogMiss(): CaptureSource {
  return {
    source: 'watchdog_miss',
    severity: 'fatal',
    defaultOwnerId: DAEMON_SELF,
    install(ctx) {
      const bus: SignalBus = ctx.hooks.watchdogSignal ?? (process as unknown as SignalBus);
      const handler = (): void => {
        ctx.sink({
          id: newCrashId(ctx.now),
          ts_ms: ctx.now(),
          source: 'watchdog_miss',
          summary: 'watchdog missed deadline (SIGABRT)',
          detail: `process uptime: ${process.uptime().toFixed(3)}s`,
          labels: { signal: 'SIGABRT' },
          owner_id: DAEMON_SELF,
        });
      };
      bus.on('SIGABRT', handler);
      return () => bus.off('SIGABRT', handler);
    },
  };
}

// ---------------------------------------------------------------------------
// THE TABLE — spec ch09 §6.2 source-of-truth.
//
// Order matches §1 reading order so a `diff` against the spec is trivial.
// The list is the v0.3 baseline — adding a v0.4 source = appending one
// `make*()` factory and a row here. Tests iterate this array, so the
// "did we wire it" coverage grows automatically.
// ---------------------------------------------------------------------------

/**
 * The capture-sources table. Frozen so consumers can't mutate the wiring
 * post-boot (the spec contract is "registered at boot, before any RPC").
 */
export const CAPTURE_SOURCES: readonly CaptureSource[] = Object.freeze([
  makeUncaughtException(),
  makeClaudeExit(),
  makeSqliteOp(),
  makeListenerBind(),
  makeWatchdogMiss(),
]);

// ---------------------------------------------------------------------------
// Orchestrator — wires every source to a single sink. Returns one
// `Unsubscribe` that detaches every source on shutdown / test teardown.
// ---------------------------------------------------------------------------

export interface InstallOpts {
  /** Hooks for the per-source subsystems. Missing hook = source skipped. */
  readonly hooks: CaptureHooks;
  /** Override sink (test injection). Defaults to appending to a real file. */
  readonly sink?: CrashSink;
  /** Override clock. Defaults to `Date.now`. */
  readonly now?: () => number;
  /** Override the source list. Defaults to `CAPTURE_SOURCES`. Used by the
   *  table-driven tests to install a single row in isolation. */
  readonly sources?: readonly CaptureSource[];
}

/**
 * Default sink factory — binds `appendCrashRaw` to a fixed path. Kept
 * separate so tests can call `installCaptureSources({sink: ...})` without
 * needing a tmp file.
 */
export function fileSink(path: string): CrashSink {
  return (entry) => appendCrashRaw(path, entry);
}

/**
 * Install every source in `opts.sources` (or the default `CAPTURE_SOURCES`).
 * Returns a single `Unsubscribe` that detaches every source. Idempotent.
 *
 * The orchestrator is intentionally tiny: it iterates the table, calls
 * `install`, and collects the per-source unsubscribes. It does NOT decide
 * severity-driven behaviour (e.g., `process.exit(1)` after a fatal append)
 * — that policy lives in the supervisor / boot sequence which knows the
 * crash policy for the running mode (test harness vs. service).
 */
export function installCaptureSources(opts: InstallOpts): Unsubscribe {
  const sources = opts.sources ?? CAPTURE_SOURCES;
  const ctx: CaptureContext = {
    sink: opts.sink ?? (() => {
      throw new Error('installCaptureSources: no sink configured (pass `sink` or `fileSink(path)`)');
    }),
    now: opts.now ?? Date.now,
    hooks: opts.hooks,
  };
  const unsubs: Unsubscribe[] = [];
  for (const src of sources) {
    unsubs.push(src.install(ctx));
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    // Drain in reverse install order — symmetrical with `start`/`stop`
    // discipline used elsewhere (listeners/factory.ts, lifecycle.ts).
    for (let i = unsubs.length - 1; i >= 0; i--) {
      try {
        unsubs[i]();
      } catch {
        // A misbehaving subsystem hook must not break sibling teardowns.
        // We swallow — the worst case is a leaked listener at shutdown.
      }
    }
  };
}
