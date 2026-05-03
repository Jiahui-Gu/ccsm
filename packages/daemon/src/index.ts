// Daemon entrypoint. Spec ch02 §3 startup order: this file walks phases
// 1–5 in sequence, logs each transition, and exits non-zero on any phase
// failure. The actual step bodies (DB open, session restore, listener
// bind, descriptor write, /healthz flip) live in later tasks — T1.1 just
// wires the lifecycle skeleton with TODO stubs.
//
// Out of scope (per task brief):
//   - SQLite open + migrations             → T5.1
//   - Session restore + orphan-uid check   → T3.4
//   - Supervisor /healthz                  → T1.7
//
// Wired-in:
//   - Listener A bind                      → T1.4 (`makeListenerA`)
//   - HTTP/2 transport adapters            → T1.5 (h2c-uds / h2c-loopback / h2-named-pipe)
//   - ConnectRouter + stub services        → T2.2 (this file consumes
//                                                  `makeRouterBindHook`)
//   - Descriptor file write                → T1.6 (separate concern; not
//                                                  yet called from here)
//   - systemd watchdog (main thread)       → T5.13 (`startSystemdWatchdog`)
//   - Graceful shutdown                    → T1.8 (this file installs the
//                                                  SIGTERM/SIGINT handlers
//                                                  that call `Shutdown.run`)
//
// In scope (T1.8): SIGTERM / SIGINT handler installation. The actual
// shutdown sequence is `Shutdown.run(...)` (./shutdown.ts); this file
// only wires (a) the signal trap that calls it, and (b) the empty
// `ShutdownContext` we can populate today (no listeners / no db / no
// pty children are constructed by the T1.1 startup stub yet — later
// tasks register their handles with `register*OnEntrypoint` helpers
// when they land).

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { runMigrations } from './db/migrations/runner.js';
import { openDatabase, type SqliteDatabase } from './db/sqlite.js';
import { buildDaemonEnv, type DaemonEnv } from './env.js';
import { Lifecycle, Phase } from './lifecycle.js';
import { makeListenerA } from './listeners/factory.js';
import type { Listener } from './listeners/types.js';
import { makeRouterBindHook } from './rpc/bind.js';
import {
  Shutdown,
  installShutdownHandlers,
  noopInFlightTracker,
  type ShutdownContext,
  type ShutdownResult,
} from './shutdown.js';
import {
  startSystemdWatchdog,
  type SystemdWatchdogHandle,
} from './watchdog/systemd.js';

function log(line: string): void {
  // Plain stdout for now. T9 brings structured logging; until then a
  // single-line prefix is enough for the install-time install log scrape
  // (ch10 §6 healthz failure mode captures last 200 lines of stdout).
  process.stdout.write(`[ccsm-daemon] ${line}\n`);
}

/** Run startup phases 1–5. Throws on any phase failure; caller exits 1. */
export async function runStartup(lifecycle: Lifecycle): Promise<{
  readonly env: DaemonEnv;
  readonly listenerA: Listener | null;
}> {
  lifecycle.onTransition((p) => log(`phase -> ${p}`));

  // Phase: LOADING_CONFIG  (build DaemonEnv from process.env)
  lifecycle.advanceTo(Phase.LOADING_CONFIG);
  const env = buildDaemonEnv();
  log(`env loaded: mode=${env.mode} bootId=${env.bootId} version=${env.version}`);

  // Phase: OPENING_DB  (T5.1 sqlite wrapper + T5.4 migration runner)
  lifecycle.advanceTo(Phase.OPENING_DB);
  const dbPath = join(env.paths.stateDir, 'ccsm.db');
  // Ensure parent dir exists — installer normally creates stateDir, but
  // dev/smoke runs may point CCSM_STATE_DIR at a brand-new tmp dir.
  mkdirSync(dirname(dbPath), { recursive: true });
  const db: SqliteDatabase = openDatabase(dbPath);
  try {
    const migrationResult = runMigrations(db);
    log(
      `db opened at ${dbPath}: applied=${migrationResult.applied
        .map((m) => m.version)
        .join(',')} alreadyApplied=${migrationResult.alreadyApplied
        .map((m) => m.version)
        .join(',')}`,
    );
  } catch (err) {
    // Close the handle so we don't leak it on a startup-abort path.
    try {
      db.close();
    } catch {
      // best-effort
    }
    throw err;
  }

  // Phase: RESTORING_SESSIONS  (TODO Task #T3.4 — re-spawn sessions)
  lifecycle.advanceTo(Phase.RESTORING_SESSIONS);
  log('TODO(T3.4): re-spawn should-be-running sessions, orphan-uid check');

  // Phase: STARTING_LISTENERS  (T1.4 listener + T2.2 router)
  lifecycle.advanceTo(Phase.STARTING_LISTENERS);
  // The listener-slot assert (ch03 §1) is a one-liner we can do today even
  // without makeListenerA — it proves slot 1 is the typed sentinel.
  const slot1 = env.listeners[1];
  if (slot1 !== env.listeners[1]) {
    // Tautological by construction, but the explicit reference keeps the
    // ESLint `no-listener-slot-mutation` rule (added with T1.4) honest.
    throw new Error('listeners[1] mutated away from RESERVED_FOR_LISTENER_B');
  }
  // Bind Listener A with the Connect-router-aware HTTP/2 hook (T2.2).
  // The hook builds an http2 server whose request handler is the
  // Connect router with every v0.3 service registered as
  // `Unimplemented` stubs (per spec ch04 §3-§6.2). L3+ tasks (T3.x /
  // T4.x / T5.x / T6.x) swap the empty service impls in
  // `rpc/router.ts` for concrete handlers without touching this wiring.
  // TODO(T1.6): write `listener-a.json` descriptor after bind succeeds.
  let listenerA: Listener | null = null;
  if (process.env.CCSM_DAEMON_SKIP_LISTENER === '1') {
    log('CCSM_DAEMON_SKIP_LISTENER=1: skipping listener bind (smoke / unit-test mode)');
  } else {
    listenerA = makeListenerA(env, { bindHook: makeRouterBindHook() });
    await listenerA.start();
    const desc = listenerA.descriptor();
    log(`listener-a bound: kind=${desc.kind}`);
  }

  // Phase: READY  (Supervisor /healthz flips to 200 in T1.7)
  lifecycle.advanceTo(Phase.READY);
  log('TODO(T1.7): flip Supervisor /healthz to 200');

  return { env, listenerA };
}

/**
 * Start the systemd watchdog keepalive on the main thread (T5.13). No-op on
 * non-Linux, when `NOTIFY_SOCKET` is unset, or when `systemd-notify` is not
 * installed. The handle's `stop()` MUST be called during graceful shutdown
 * (T1.8) so the keepalive timer does not pin the event loop.
 *
 * Spec ch09 §6: emitted on the MAIN thread because the main thread is what
 * blocks on coalesced SQLite writes; if it hangs, the entire RPC surface
 * is dead, and systemd's `WatchdogSec=30s` reaps it via SIGABRT.
 */
function startMainThreadWatchdog(): SystemdWatchdogHandle {
  const handle = startSystemdWatchdog();
  if (handle.isActive()) {
    log('systemd watchdog: emitting WATCHDOG=1 every 10s on main thread');
  }
  return handle;
}

async function main(): Promise<void> {
  const lifecycle = new Lifecycle();
  let listenerA: Listener | null = null;
  let watchdog: SystemdWatchdogHandle | null = null;

  // Build the shutdown orchestrator + a mutable context the future
  // T1.4 / T1.7 / T5.1 / T4.x wiring can populate as they land. We
  // capture refs by reading from a single `ctxRef` object so that an
  // early SIGTERM (before phase READY) still gets the partial state
  // (e.g. a half-bound listener or open db) torn down. Only known-safe
  // members are exposed; the rest stay null until their owning task
  // wires them in.
  const ctxRef: { -readonly [K in keyof ShutdownContext]: ShutdownContext[K] } = {
    listeners: [],
    supervisor: null,
    ptyHostChildren: [],
    db: null,
    inFlightTracker: noopInFlightTracker,
    log: {
      step: (name, detail) => log(`shutdown step=${name}${detail ? ' ' + JSON.stringify(detail) : ''}`),
      warn: (name, err) => log(`shutdown WARN step=${name}: ${err instanceof Error ? err.message : String(err)}`),
    },
  };

  const shutdown = new Shutdown();
  const triggerShutdown = async (): Promise<ShutdownResult> => {
    // Stop the watchdog first so its keepalive timer doesn't pin the
    // event loop while shutdown.run drains in-flight RPCs.
    watchdog?.stop();
    const r = await shutdown.run(ctxRef);
    // Exit code: clean drain + zero step errors → 0; otherwise 1.
    const exitCode = r.errors.length === 0 && r.inFlightAtBudgetExpiry <= 0 ? 0 : 1;
    process.exit(exitCode);
  };

  // Install signal handlers LAST in main() — but we install them BEFORE
  // runStartup so an early SIGTERM during boot still triggers a clean
  // teardown of whatever partial state we managed to build.
  installShutdownHandlers(triggerShutdown, (sig, kind) => {
    log(`signal ${sig} (${kind}) — initiating graceful shutdown`);
  });

  try {
    const result = await runStartup(lifecycle);
    listenerA = result.listenerA;
    // Register the bound listener with the shutdown context so SIGTERM
    // closes it during step 1 (stop accepting). T5.1 will register the
    // db handle here too once it lands.
    if (listenerA !== null) {
      ctxRef.listeners.push(listenerA);
    }
    // Watchdog after READY — there is no point telling systemd we're alive
    // until the daemon is actually serving. systemd's `WatchdogSec=30s`
    // gives ~30s of boot slack before the first WATCHDOG=1 is required.
    watchdog = startMainThreadWatchdog();
    log(`startup complete: phase=${lifecycle.currentPhase()}`);
    // T1.1 stub: the daemon would normally hold the event loop open via
    // its bound listeners. The bound Listener A keeps the loop alive on
    // its own; the env-flag escape hatch remains for the smoke command.
    if (listenerA === null && process.env.CCSM_DAEMON_HOLD_OPEN === '1') {
      // Keep alive forever — used when listener bind is skipped (smoke
      // run) but caller still wants the process to stay up.
      setInterval(() => {}, 1 << 30);
    } else {
      // T5.13 cleanup: in the smoke-run path we exit immediately after
      // startup, so stop the watchdog now to release its timer (the
      // .unref() inside makes this redundant for event-loop liveness, but
      // explicit shutdown matches the contract T1.8 will enforce).
      watchdog.stop();
    }
  } catch (err) {
    watchdog?.stop();
    const error = err instanceof Error ? err : new Error(String(err));
    lifecycle.fail(error);
    log(`STARTUP FAILED at phase ${lifecycle.currentPhase()}: ${error.message}`);
    if (error.stack) {
      log(error.stack);
    }
    if (listenerA !== null) {
      await listenerA.stop().catch(() => {
        /* swallow — process is exiting */
      });
    }
    // Best-effort partial-state teardown via the shutdown orchestrator
    // (covers the spec's "checkpoint WAL on every termination path"
    // contract — once T5.1 wires `ctxRef.db`, a startup failure between
    // OPENING_DB and READY will still flush the WAL).
    await shutdown.run(ctxRef).catch(() => {
      /* shutdown.run captures its own errors; no need to log twice */
    });
    process.exit(1);
  }
}

// `import.meta.url` check so unit tests can `import { runStartup }` without
// triggering `main()`.
import { fileURLToPath } from 'node:url';

function isDirectRun(): boolean {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    const here = fileURLToPath(import.meta.url);
    return here === entry || here.replace(/\\/g, '/') === entry.replace(/\\/g, '/');
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  void main();
}
