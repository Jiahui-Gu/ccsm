// Daemon entrypoint. Spec ch02 §3 startup order: this file walks phases
// 1–5 in sequence, logs each transition, and exits non-zero on any phase
// failure. Wave 1 wire-up (Task #208) plumbed the Listener-A descriptor
// write, the SessionService.Hello handler, the Supervisor UDS server,
// and the crash-raw boot replay + capture-sources install — i.e. the
// previously-stubbed `runStartup` is now end-to-end.
//
// Out of scope (per task brief / future tasks):
//   - Session restore + orphan-uid check       → T3.4
//   - PtyHost / SessionManager wiring          → T6.x
//
// Wired here:
//   - DaemonEnv build                          → env.ts
//   - SQLite open + migrations + recovery      → T5.1 / T5.7
//   - Crash boot replay (ch09 §6)              → crash/raw-appender.replayCrashRawOnBoot
//   - Crash capture-sources install (ch09 §1)  → crash/sources.installCaptureSources
//   - Listener A bind                          → T1.4 (`makeListenerA`)
//   - HTTP/2 transport adapters                → T1.5 (h2c-uds / h2c-loopback / h2-named-pipe)
//   - ConnectRouter + real Hello handler       → T2.2 + T2.3 (`makeRouterBindHook({ helloDeps })`)
//   - bearer-token → PeerInfo bridge for       → this file (`bearerToPeerInfoInterceptor`)
//     loopback transport
//   - Listener-A descriptor file write         → T1.6 (`writeDescriptor`)
//   - Supervisor UDS HTTP server (/healthz,    → T1.7 (`makeSupervisorServer`)
//     /hello, /shutdown, /ack-recovery)
//   - systemd watchdog (main thread)           → T5.13 (`startSystemdWatchdog`)
//   - Graceful shutdown                        → T1.8 (`Shutdown.run` + signal handlers)

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import type { Interceptor } from '@connectrpc/connect';

import { PROTO_VERSION } from '@ccsm/proto';

import {
  PEER_INFO_KEY,
  peerCredAuthInterceptor,
  type PeerInfo,
} from './auth/index.js';
import { runMigrations } from './db/migrations/runner.js';
import { checkAndRecover, makeRecoveryFlag, type RecoveryFlag } from './db/recovery.js';
import { openDatabase, type SqliteDatabase } from './db/sqlite.js';
import { CrashPruner } from './crash/pruner.js';
import {
  fileSink,
  installCaptureSources,
  type Unsubscribe,
} from './crash/sources.js';
import { defaultCrashEventBus } from './crash/event-bus.js';
import { replayCrashRawOnBoot } from './crash/raw-appender.js';
import { buildDaemonEnv, type DaemonEnv } from './env.js';
import { Lifecycle, Phase } from './lifecycle.js';
import { makeListenerA } from './listeners/factory.js';
import { writeDescriptor, type DescriptorV1 } from './listeners/descriptor.js';
import type { Listener } from './listeners/types.js';
import { LISTENER_A_HELLO_ID } from './rpc/hello.js';
import { makeRouterBindHook } from './rpc/bind.js';
import { upsertSettingsBoot } from './rpc/settings/store.js';
import { SessionManager, type ISessionManager } from './sessions/SessionManager.js';
import { statePaths } from './state-dir/paths.js';
import {
  Shutdown,
  installShutdownHandlers,
  noopInFlightTracker,
  type ShutdownContext,
  type ShutdownResult,
} from './shutdown.js';
import { assertWired } from './runStartup.lock.js';
import {
  makeSupervisorServer,
  type SupervisorServer,
} from './supervisor/index.js';
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

/**
 * Result shape returned by `runStartup`. Probes (`captureSourcesInstalled`,
 * `crashReplayResult`) are surfaced so the daemon-boot end-to-end test
 * (Task #208) can assert that the boot path actually wired the production
 * subsystems — without the probes, a regression in wire-up would silently
 * ship `Unimplemented` / never-written descriptors with no test signal.
 */
export interface RunStartupResult {
  readonly env: DaemonEnv;
  readonly listenerA: Listener | null;
  readonly db: SqliteDatabase;
  readonly crashPruner: CrashPruner;
  readonly supervisor: SupervisorServer | null;
  readonly descriptorPath: string | null;
  /** `true` iff `installCaptureSources` ran successfully on this boot. */
  readonly captureSourcesInstalled: boolean;
  /** Detach hook for the capture sources; null when install was skipped. */
  readonly captureSourcesUnsubscribe: Unsubscribe | null;
  /**
   * Crash-raw NDJSON replay outcome (ch09 §6 boot replay). Always present
   * — `fileMissing` covers the first-boot case where the file does not
   * exist yet.
   */
  readonly crashReplayResult: {
    readonly linesRead: number;
    readonly inserted: number;
    readonly malformed: number;
    readonly fileMissing: boolean;
  };
  /**
   * SessionManager instance bound to the production Listener A. `null` when
   * the listener bind was skipped (`CCSM_DAEMON_SKIP_LISTENER=1` smoke /
   * unit-test mode) — the manager is constructed inline with the listener
   * and shares its lifecycle. Surfaced so the daemon-boot e2e (Task #225
   * rolling extension) can publish a synthetic `created` event into the
   * SAME bus the Connect handler subscribes to, proving the WatchSessions
   * wire delivers events end-to-end (not just opens a stream). Future T6.x
   * pty-host wave will reuse this same instance for spawn wiring.
   */
  readonly sessionManager: ISessionManager | null;
  /**
   * Names of components actually wired by this `runStartup` invocation.
   * Compared against `REQUIRED_COMPONENTS` (see `runStartup.lock.ts`)
   * by the boot-time `assertWired` call AND by the daemon-boot e2e
   * test (Task #208 / #225 rolling-extension contract). Order matches
   * the canonical list so spec tests can deep-equal it.
   */
  readonly wired: ReadonlyArray<string>;
}

/**
 * Build the per-call `Interceptor` that translates an `Authorization:
 * Bearer <token>` header into a `LoopbackTcpPeer` `PeerInfo` so the
 * downstream `peerCredAuthInterceptor` can derive a `Principal`. v0.3
 * Listener A only relies on this on the loopback transport (UDS /
 * named-pipe peer-cred extraction is wired into the transport adapter
 * layer in a separate hardening task); for loopback this is the documented
 * test-bearer path (see `auth/peer-info.ts` `LoopbackTcpPeer` comment +
 * `auth/interceptor.ts` `TEST_BEARER_TOKEN`).
 *
 * Exported so the daemon-boot e2e test (Task #208) can assert the wire is
 * present.
 */
export const bearerToPeerInfoInterceptor: Interceptor = (next) => async (req) => {
  const authz = req.header.get('authorization');
  let bearerToken: string | null = null;
  if (authz !== null) {
    const match = /^Bearer\s+(.+)$/i.exec(authz);
    if (match !== null) {
      bearerToken = match[1] ?? null;
    }
  }
  const peer: PeerInfo = {
    transport: 'KIND_TCP_LOOPBACK_H2C',
    bearerToken,
    remoteAddress: '127.0.0.1',
    remotePort: 0,
  };
  req.contextValues.set(PEER_INFO_KEY, peer);
  return next(req);
};

/**
 * Run startup phases 1–5. Throws on any phase failure; caller exits 1.
 *
 * The optional `recoveryFlag` is shared with the supervisor server (T1.7 +
 * T5.7 / Task #60). The entrypoint constructs one if not supplied so the
 * /healthz `recovery_modal` field always reflects this boot's recovery
 * outcome — never a stale flag from a previous process.
 */
export async function runStartup(
  lifecycle: Lifecycle,
  recoveryFlag: RecoveryFlag = makeRecoveryFlag(),
): Promise<RunStartupResult> {
  lifecycle.onTransition((p) => log(`phase -> ${p}`));

  // Phase: LOADING_CONFIG  (build DaemonEnv from process.env)
  lifecycle.advanceTo(Phase.LOADING_CONFIG);
  const env = buildDaemonEnv();
  log(`env loaded: mode=${env.mode} bootId=${env.bootId} version=${env.version}`);

  // Phase: OPENING_DB  (T5.1 sqlite wrapper + T5.4 migration runner)
  lifecycle.advanceTo(Phase.OPENING_DB);

  // T5.7 / Task #60 — corrupt-DB recovery (ch07 §6). MUST run BEFORE any
  // other code opens the SQLite file. We resolve the canonical state paths
  // here (not from `env.paths`) because the entrypoint env shape predates
  // T5.3's `statePaths()` and only carries a `stateDir` string; the spec
  // pins the DB and crash-raw filenames to this module's constants.
  const sp = statePaths();
  const recovery = checkAndRecover({
    dbPath: sp.db,
    crashRawPath: sp.crashRaw,
    flag: recoveryFlag,
  });
  if (recovery.recovered) {
    log(
      `corrupt-DB recovery: integrity_check failed; renamed to ${recovery.corruptPath}`,
    );
  }

  const dbPath = sp.db;
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
    // Wave-3 #349 — UPSERT daemon-derived Settings rows (spec #337 §5).
    // Runs AFTER migrations (settings table exists) and BEFORE
    // assertWired so SettingsService.GetSettings sees both rows on the
    // first post-boot call. Idempotent — every boot writes the same
    // two rows; consecutive boots with no env change are a no-op at
    // the row-content level. The task brief simplifies the spec's
    // `~/.claude/settings.json` parse to an env-var fallback
    // (`CCSM_DETECTED_CLAUDE_DEFAULT_MODEL`) so the boot path stays
    // hermetic for the daemon-boot e2e — full settings.json parsing
    // is forward-safe (a sibling task can extend this UPSERT to read
    // the file without touching the wire shape).
    const detectedModel =
      process.env.CCSM_DETECTED_CLAUDE_DEFAULT_MODEL ?? '';
    upsertSettingsBoot(db, {
      userHomePath: homedir(),
      detectedClaudeDefaultModel: detectedModel,
    });
    log(
      `settings boot UPSERT: user_home_path=set ` +
        `detected_claude_default_model=${
          detectedModel === '' ? 'empty' : 'set'
        }`,
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

  // Crash boot-replay (ch09 §6.2). Drains any crash-raw NDJSON lines a
  // previous boot wrote during a fatal exit into the `crash_log` SQLite
  // table, then truncates the file. Idempotent — safe to call on every
  // boot, including first-ever boot (returns `fileMissing: true`).
  const crashReplayResult = replayCrashRawOnBoot({ path: sp.crashRaw, db });
  log(
    `crash-replay: linesRead=${crashReplayResult.linesRead} ` +
      `inserted=${crashReplayResult.inserted} ` +
      `malformed=${crashReplayResult.malformed} ` +
      `fileMissing=${crashReplayResult.fileMissing}`,
  );

  // T5.12 / Task #64 — crash retention pruner. Constructed AFTER
  // openDatabase + runMigrations + recoveryFlag so the pruner's first
  // (post-warmup) IMMEDIATE transaction can never race the migration
  // runner. Caller (main / tests) calls `crashPruner.start()` after
  // shutdown handlers are installed; `stop()` is invoked from the
  // shutdown context in the entrypoint.
  const crashPruner = new CrashPruner({
    db,
    log: {
      info: (line) => log(line),
      warn: (line) => log(line),
    },
    // Settings reader wires in with T5-Settings (later task); until
    // then `() => ({})` collapses to the spec defaults (10000 / 90).
    readSettings: () => ({}),
  });

  // Install crash-capture sources (ch09 §1 + §6.2). `installCaptureSources`
  // wires every CAPTURE_SOURCES row (uncaughtException, claudeExit,
  // sqliteOp, listenerBind, watchdogMiss) into a single sink that appends
  // a JSON line per crash event to `crash-raw.ndjson`. Sources whose
  // dependency hooks (claudeChildren / sqliteErrors / etc.) are absent
  // install no-ops — boot-order tolerance per ch09 §1 commentary. The
  // unsubscribe is captured into the shutdown context below so SIGTERM
  // detaches every source cleanly.
  let captureSourcesUnsubscribe: Unsubscribe | null = null;
  let captureSourcesInstalled = false;
  if (process.env.CCSM_DAEMON_SKIP_CRASH_CAPTURE === '1') {
    log('CCSM_DAEMON_SKIP_CRASH_CAPTURE=1: skipping installCaptureSources (test mode)');
  } else {
    captureSourcesUnsubscribe = installCaptureSources({
      hooks: {
        // Claude child / sqlite error / watchdog signal hooks land with
        // their owning subsystems (T6.x sessions, T5.x sqlite error bus,
        // T5.13 watchdog). Until they wire here, the matching capture
        // sources install no-ops by design (ch09 §1 boot-order
        // tolerance). The `uncaughtException` source binds to `process`
        // unconditionally and is the boot-day floor.
      },
      sink: fileSink(sp.crashRaw),
    });
    captureSourcesInstalled = true;
    log(`crash-capture: installed sink=${sp.crashRaw}`);
  }

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

  // Bind Listener A with the Connect-router-aware HTTP/2 hook (T2.2 +
  // T2.3). `helloDeps` flips the SessionService.Hello handler from the
  // T2.2 `Unimplemented` stub to the real T2.3 handler — every other
  // service stays `Unimplemented` until its owning task lands. The
  // `bearerToPeerInfoInterceptor` deposits a `LoopbackTcpPeer` PeerInfo
  // from the Authorization header so the downstream auth interceptor can
  // derive a Principal on loopback (the dev / test transport per spec
  // ch03 §4 — UDS / named-pipe peer-cred extraction is wired into the
  // transport adapter directly in its own hardening pass).
  let listenerA: Listener | null = null;
  let descriptorPath: string | null = null;
  let sessionManager: SessionManager | null = null;
  if (process.env.CCSM_DAEMON_SKIP_LISTENER === '1') {
    log('CCSM_DAEMON_SKIP_LISTENER=1: skipping listener bind (smoke / unit-test mode)');
  } else {
    const helloDeps = {
      daemonVersion: env.version,
      protoVersion: PROTO_VERSION,
      listenerId: LISTENER_A_HELLO_ID,
    };
    // Wave-3 #290 — wire SessionService.WatchSessions handler in
    // production. `makeWatchSessionsHandler` (T3.3 / PR #939) is fully
    // implemented but was never bound at boot, so the wire returned
    // `Code.Unimplemented` despite the handler shipping. Construct the
    // SessionManager off the same `db` handle the rest of startup uses
    // (single owner of the sessions table; the T6.x pty-host bridge
    // will reuse this same instance when it lands) and pass the deps
    // through `makeRouterBindHook`. The bind hook in `rpc/router.ts`
    // installs the combined Hello + WatchSessions registration on
    // SessionService when both deps are present (see
    // `registerSessionService` "twice replaces" caveat).
    sessionManager = new SessionManager(db);
    const watchSessionsDeps = { manager: sessionManager };
    // Wave-3 #229 — wire CrashService.GetCrashLog handler in production.
    // Wave-3 #334 — wire CrashService.GetRawCrashLog server-streaming
    // handler in the same overlay (separate sub-task because the
    // streaming + 64 KiB chunk semantics are non-overlapping with the
    // unary GetCrashLog handler; same `registerCrashService` call site
    // because `ConnectRouter.service(desc, impl)` REPLACES the prior
    // registration — see `register.ts` header comment).
    // Audit #228 sub-task 2/3 (docs/superpowers/specs/2026-05-04-rpc-stub-gap-audit.md):
    // pre-#229 the entire CrashService was a stub on the wire even though
    // `crash_log` is populated end-to-end at boot (`replayCrashRawOnBoot`).
    // We pass the SAME `db` handle the rest of startup uses (single owner
    // of the SQLite file; the #335 WatchCrashLog overlay reuses this same
    // boot for its event-bus subscription) and the SAME `sp.crashRaw`
    // path the capture-source sink writes to and `replayCrashRawOnBoot`
    // reads from (the #334 GetRawCrashLog streaming handler reads it
    // back over the wire).
    //
    // Wave-3 #335 — wire CrashService.WatchCrashLog. The handler subscribes
    // to `defaultCrashEventBus` (Task #340) — the SAME singleton
    // `crash/raw-appender.ts:appendCrashRaw` emits on after fsync. Routing
    // every CrashService method through the same `crashDeps` payload keeps
    // the `registerCrashService` overlay's "single service() call covers
    // every method" invariant honest (calling `service()` twice for the
    // same descriptor would silently drop the earlier registration — see
    // `register.ts` header).
    //
    // Wave-3 #334 — wire CrashService.GetRawCrashLog server-streaming
    // handler. With #334 landed, every v0.3 CrashService method is wired
    // and none falls through to the router's "absent method ->
    // Unimplemented" fallback.
    const crashDeps = {
      getCrashLogDeps: { db },
      watchCrashLogDeps: { bus: defaultCrashEventBus },
      getRawCrashLogDeps: { crashRawPath: sp.crashRaw },
    };
    // Wave-3 §6.9 sub-task 5 (Task #336) — wire the SessionService read
    // pair (ListSessions / GetSession) on top of the WatchSessions
    // overlay. Both handlers reuse the same `sessionManager` (single
    // owner of the sessions table; sharing keeps SQL access in one
    // place). See `registerSessionService` for the "registering a
    // descriptor twice replaces" caveat that forces all SessionService
    // handlers into one registration.
    const readHandlersDeps = { manager: sessionManager };
    // Wave-3 #349 — wire SettingsService + DraftService production
    // overlays (spec #337 §6.1 step 1). Both services share the same
    // `db` handle (drafts ride on the `settings` table under key
    // `draft:<session_id>` per spec §2.2). Pre-#349 both services
    // were stubs returning `Code.Unimplemented` despite `001_initial.sql`
    // having created the `settings` table from day one — closing the
    // wire gap that the audit #228 sub-task 9 flagged. The boot UPSERT
    // for `user_home_path` / `detected_claude_default_model` ran above
    // (after `runMigrations`) so the first post-boot `GetSettings`
    // call sees the daemon-derived rows.
    const settingsDeps = {
      getSettingsDeps: { db, onUnknownKey: (k: string) => log(`settings: unknown key '${k}' (forward-tolerant; ignored)`) },
      updateSettingsDeps: { db, onUnknownKey: (k: string) => log(`settings: unknown key '${k}' (forward-tolerant; ignored)`) },
    };
    const draftDeps = {
      getDraftDeps: { db },
      updateDraftDeps: { db },
    };
    listenerA = makeListenerA(env, {
      bindHook: makeRouterBindHook({
        helloDeps,
        watchSessionsDeps,
        crashDeps,
        readHandlersDeps,
        settingsDeps,
        draftDeps,
        // Order matters: bearer→PeerInfo deposit MUST run before
        // peerCredAuthInterceptor (which reads PEER_INFO_KEY and
        // derives Principal). `requestMetaInterceptor` is prepended by
        // `makeRouterBindHook` itself so it always sees an unmolested
        // RequestMeta first.
        interceptors: [bearerToPeerInfoInterceptor, peerCredAuthInterceptor],
      }),
    });
    await listenerA.start();
    const desc = listenerA.descriptor();
    log(`listener-a bound: kind=${desc.kind}`);

    // Atomic descriptor write (ch03 §3.1 / §3.2). Spec ordering: write
    // BEFORE Supervisor /healthz flips to 200 so Electron observing
    // `ready=true` is guaranteed to find a fresh descriptor.
    const payload: DescriptorV1 = {
      version: 1,
      transport: desc.kind,
      address: addressFromDescriptor(desc),
      tlsCertFingerprintSha256: null,
      supervisorAddress: env.paths.supervisorAddr,
      boot_id: env.bootId,
      daemon_pid: process.pid,
      listener_addr: addressFromDescriptor(desc),
      protocol_version: 1,
      bind_unix_ms: Date.now(),
    };
    mkdirSync(dirname(env.paths.descriptorPath), { recursive: true });
    await writeDescriptor(env.paths.descriptorPath, payload);
    descriptorPath = env.paths.descriptorPath;
    log(`descriptor written: ${descriptorPath}`);
  }

  // Phase: READY  (Supervisor /healthz flips to 200 once we're here)
  lifecycle.advanceTo(Phase.READY);

  // Bring up the Supervisor UDS HTTP server (ch03 §7). Separate from
  // Listener A — admin-only, peer-cred guarded, exposes `/healthz`,
  // `/hello`, `/shutdown`, `/ack-recovery`. `/healthz` reads
  // `lifecycle.isReady()`, which is `true` from this point onwards.
  let supervisor: SupervisorServer | null = null;
  if (process.env.CCSM_DAEMON_SKIP_SUPERVISOR === '1') {
    log('CCSM_DAEMON_SKIP_SUPERVISOR=1: skipping supervisor bind (test mode)');
  } else {
    // The actual triggerShutdown closure lives in `main()`; for the
    // runStartup-only path (unit tests / e2e) callers can trigger
    // graceful shutdown by stopping the returned server directly. We
    // surface `process.kill(process.pid, 'SIGTERM')` here so a real
    // production /shutdown call wakes up the same SIGTERM handler the
    // entrypoint installs — keeps a single shutdown path.
    supervisor = makeSupervisorServer({
      lifecycle,
      bootId: env.bootId,
      version: env.version,
      startTimeMs: Date.now(),
      address: env.paths.supervisorAddr,
      recoveryFlag,
      onShutdown: () => {
        try {
          process.kill(process.pid, 'SIGTERM');
        } catch {
          // best-effort — the entrypoint also responds to direct
          // `triggerShutdown` calls when not run via `main()`.
        }
      },
    });
    mkdirSync(dirname(env.paths.supervisorAddr), { recursive: true });
    await supervisor.start();
    log(`supervisor bound: ${supervisor.address()}`);
  }

  // Collect canonical wire-up component names actually present on this
  // boot, then assert against `REQUIRED_COMPONENTS` (see
  // `runStartup.lock.ts`). Throws if any required-and-not-WARN_ONLY
  // component is missing — failing boot is the right behavior because
  // the daemon would otherwise silently ship a stub (the exact "library
  // shipped but never wired" regression Wave 0/1 + Task #221 exist to
  // catch). The two skip-env paths (`CCSM_DAEMON_SKIP_LISTENER`,
  // `CCSM_DAEMON_SKIP_SUPERVISOR`, `CCSM_DAEMON_SKIP_CRASH_CAPTURE`)
  // are smoke / unit-test seams; in those modes the corresponding
  // component name is correctly absent from `wired` and `assertWired`
  // throws. Smoke / unit tests that intentionally skip MUST handle the
  // throw (the existing daemon-boot e2e leaves all skips off — it tests
  // the production boot path).
  const wired: string[] = [];
  if (listenerA !== null) wired.push('listener-a');
  if (supervisor !== null) wired.push('supervisor');
  if (captureSourcesInstalled) wired.push('capture-sources');
  // `replayCrashRawOnBoot` always returns a result (even on first boot
  // it returns `{ fileMissing: true, ... }`) — its presence in the
  // outer scope proves the wire-up fired, regardless of whether the
  // file existed.
  if (crashReplayResult !== null && crashReplayResult !== undefined) {
    wired.push('crash-replayer');
  }
  // `crash-rpc`: bound to the Listener A Connect router via
  // `makeRouterBindHook({ crashDeps })` above. Track it as wired iff
  // Listener A actually bound — the test seam
  // `CCSM_DAEMON_SKIP_LISTENER=1` short-circuits the listener bind, in
  // which case the CrashService overlay never reaches the router and
  // this name correctly stays absent from `wired` (assertWired then
  // throws on the missing `listener-a` first).
  if (listenerA !== null) wired.push('crash-rpc');
  // `settings-service` / `draft-service`: bound to the Listener A
  // Connect router via `makeRouterBindHook({ settingsDeps, draftDeps })`
  // above (Wave-3 #349 / spec #337 §6.1 step 1). Both names are tied
  // to the listener bind: `CCSM_DAEMON_SKIP_LISTENER=1` short-circuits
  // the bind and the overlays never reach the router, in which case
  // these names correctly stay absent from `wired` (assertWired then
  // throws on the missing `listener-a` first).
  if (listenerA !== null) wired.push('settings-service');
  if (listenerA !== null) wired.push('draft-service');
  // `write-coalescer`: NOT pushed yet — module exists at
  // `src/sqlite/coalescer.ts` but the per-session pty-host bridge
  // wires in T6.x. `assertWired` treats this name as WARN_ONLY for now
  // (see `runStartup.lock.ts` `WARN_ONLY`), so this is a soft-fail
  // until that task lands.
  assertWired(wired, { warn: log });

  return {
    env,
    listenerA,
    db,
    crashPruner,
    supervisor,
    descriptorPath,
    captureSourcesInstalled,
    captureSourcesUnsubscribe,
    crashReplayResult,
    sessionManager,
    wired,
  };
}

/**
 * Render the bound `BindDescriptor` into the `address` string field of
 * the listener-a.json descriptor (spec ch03 §3.2). One canonical formatter
 * per transport; symmetric with `auth/peer-info.ts`'s transport vocabulary.
 */
function addressFromDescriptor(
  desc:
    | { readonly kind: 'KIND_UDS'; readonly path: string }
    | { readonly kind: 'KIND_NAMED_PIPE'; readonly pipeName: string }
    | { readonly kind: 'KIND_TCP_LOOPBACK_H2C'; readonly host: string; readonly port: number }
    | { readonly kind: 'KIND_TCP_LOOPBACK_H2_TLS'; readonly host: string; readonly port: number },
): string {
  switch (desc.kind) {
    case 'KIND_UDS':
      return desc.path;
    case 'KIND_NAMED_PIPE':
      return desc.pipeName;
    case 'KIND_TCP_LOOPBACK_H2C':
    case 'KIND_TCP_LOOPBACK_H2_TLS':
      return `${desc.host}:${desc.port}`;
  }
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
  let crashPruner: CrashPruner | null = null;
  let captureSourcesUnsubscribe: Unsubscribe | null = null;

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
    // Cancel the crash pruner timer BEFORE shutdown.run so its 6h
    // tick can't sneak in a stray IMMEDIATE write between the WAL
    // checkpoint (step 6) and db.close (step 7).
    crashPruner?.stop();
    // Detach crash-capture sources before shutdown so an
    // `uncaughtException` raised during the drain does not race the WAL
    // checkpoint with a stray crash-raw append.
    captureSourcesUnsubscribe?.();
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
    crashPruner = result.crashPruner;
    captureSourcesUnsubscribe = result.captureSourcesUnsubscribe;
    // Register the bound listener with the shutdown context so SIGTERM
    // closes it during step 1 (stop accepting). Register the db handle
    // so the WAL checkpoint (step 6) + close (step 7) actually fire.
    if (listenerA !== null) {
      // Reconstruct the listeners array rather than mutating it in place
      // — the `ccsm/no-listener-slot-mutation` ESLint rule (T1.9 #29)
      // bans `.push()` / `.splice()` / etc. on listener-named arrays to
      // protect the closed 2-slot tuple invariant (spec ch03 §1).
      ctxRef.listeners = [...ctxRef.listeners, listenerA];
    }
    ctxRef.db = result.db;
    ctxRef.supervisor = result.supervisor;
    // Start the crash retention pruner AFTER shutdown handlers are
    // installed (above) — a SIGTERM during the 30s warmup must still
    // cancel the pending timer cleanly.
    crashPruner.start();
    log('crash-pruner: scheduled (30s warmup, then every 6h)');
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
    crashPruner?.stop();
    captureSourcesUnsubscribe?.();
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
