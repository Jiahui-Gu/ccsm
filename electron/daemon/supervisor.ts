// electron/daemon/supervisor.ts
//
// Phase 1 crash observability supervisor hooks (spec §5.3, plan Task 4).
// This module ships only the crash-capture wiring; broader v0.3 daemon
// supervision (spawn, healthz, restart) extends the same DaemonChildHandle
// shape in later PRs.
//
// Phase 2 (spec §6, plan Task 8) adds `spawnDaemon`: a thin wrapper around
// node:child_process.spawn that forwards `CCSM_DAEMON_SENTRY_DSN` to the
// daemon child so daemon/src/sentry/init.ts can route uncaught/unhandled
// errors to the same Sentry project (de-muxed by `tags.surface = 'daemon'`).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as readline from 'node:readline';
import { RingBuffer } from '../crash/ring-buffer';
import type { CrashCollector } from '../crash/collector';

export interface DaemonChildHandle {
  child: ChildProcess;
  bootNonce?: string;
  lastTraceId?: string;
  runtimeRoot: string;
  /** invoked after recordIncident; supervisor uses this to send the renderer IPC */
  onCrash?: (incidentDir: string, payload: { exitCode: number | null; signal: string | null; bootNonce?: string; markerPresent: boolean; incidentId: string }) => void;
  ringStdout?: RingBuffer<string>;
  ringStderr?: RingBuffer<string>;
  lastHealthzAt?: number;
}

export function attachCrashCapture(handle: DaemonChildHandle, collector: CrashCollector): void {
  const ringStderr = handle.ringStderr ?? new RingBuffer<string>(200);
  const ringStdout = handle.ringStdout ?? new RingBuffer<string>(200);
  handle.ringStderr = ringStderr;
  handle.ringStdout = ringStdout;

  if (handle.child.stderr) {
    readline.createInterface({ input: handle.child.stderr }).on('line', (l) => ringStderr.push(l));
  }
  if (handle.child.stdout) {
    readline.createInterface({ input: handle.child.stdout }).on('line', (l) => ringStdout.push(l));
  }

  handle.child.on('exit', (code, signal) => {
    const markerPath = handle.bootNonce
      ? path.join(handle.runtimeRoot, 'crash', `${handle.bootNonce}.json`)
      : undefined;
    const lastHealthzAgoMs = handle.lastHealthzAt ? Date.now() - handle.lastHealthzAt : null;
    const dir = collector.recordIncident({
      surface: ringStderr.length === 0 && ringStdout.length === 0 && (!markerPath || !fs.existsSync(markerPath)) ? 'daemon-boot-crash' : 'daemon-exit',
      exitCode: code,
      signal,
      stderrTail: ringStderr.snapshot(),
      stdoutTail: ringStdout.snapshot(),
      lastTraceId: handle.lastTraceId,
      bootNonce: handle.bootNonce,
      lastHealthzAgoMs,
      markerPath,
    });
    // Phase 3 crash observability (spec §5.2 / §10, plan Task 11):
    // adopt the daemon native-fault marker (`<bootNonce>-native.dmp`)
    // written by daemon/src/crash/native-handlers.ts into the umbrella
    // incident dir as `backend.dmp`. Best-effort — abnormal-exit paths
    // (signal != null OR exitCode != 0 && != 70) get adopted; orderly
    // exit (code === 0) skips the scan since no native fault could
    // produce a marker on a clean shutdown.
    const abnormal = signal != null || (code != null && code !== 0 && code !== 70);
    if (abnormal && handle.bootNonce) {
      const nativeDmp = path.join(handle.runtimeRoot, 'crash', `${handle.bootNonce}-native.dmp`);
      if (fs.existsSync(nativeDmp)) {
        try {
          fs.renameSync(nativeDmp, path.join(dir, 'backend.dmp'));
          // eslint-disable-next-line no-console
          console.info(`[daemon-crash] adopted backend.dmp at ${path.join(dir, 'backend.dmp')}`);
        } catch {
          /* swallow — adoption is best-effort */
        }
      }
    }
    const incidentId = path.basename(dir).split('-').pop()!;
    // markerPresent: true means the daemon-marker.json file exists in the
    // incident dir (i.e. collector successfully adopted the marker file
    // produced by daemon's installCrashHandlers). Read it back from
    // meta.json so the wire payload cannot disagree with what was written
    // to disk.
    let markerPresent = false;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
      markerPresent = !!meta?.backend?.markerPresent;
    } catch { /* meta unreadable — leave markerPresent = false */ }
    handle.onCrash?.(dir, {
      exitCode: code, signal, bootNonce: handle.bootNonce,
      markerPresent,
      incidentId,
    });
  });
}

// ---------------------------------------------------------------------------
// Phase 2 — Sentry DSN forwarding to daemon child (spec §6, plan Task 8).
// ---------------------------------------------------------------------------

/**
 * Resolve the daemon Sentry DSN. Resolution order (first non-empty wins):
 *   1. process.env.SENTRY_DSN_DAEMON       — runtime override
 *   2. process.env.SENTRY_DSN              — legacy single-DSN env
 *   3. dist/electron/build-info.js         — baked at packaging time by
 *                                            scripts/before-pack.cjs
 *
 * Returns '' when nothing is configured. Empty string is forwarded verbatim
 * so the daemon can apply its own short-circuit policy (see
 * daemon/src/sentry/init.ts) — the supervisor does NOT decide whether the
 * daemon initializes Sentry; it only owns transport.
 */
export function resolveDaemonSentryDsn(): string {
  const envDsn = process.env.SENTRY_DSN_DAEMON?.trim() || process.env.SENTRY_DSN?.trim() || '';
  if (envDsn) return envDsn;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
    const buildInfo = require('../../dist/electron/build-info.js') as { sentryDsnDaemon?: string };
    return (buildInfo.sentryDsnDaemon ?? '').trim();
  } catch {
    return '';
  }
}

export interface SpawnDaemonOpts {
  /** Path to ccsm-daemon binary (or node script in dev). */
  binary: string;
  args?: string[];
  /** Forwarded as `CCSM_RUNTIME_ROOT` so daemon writes crash markers there. */
  runtimeRoot?: string;
  /** Override DSN (otherwise resolveDaemonSentryDsn). Mostly for tests. */
  dsn?: string;
  /** Pass-through spawn options. `env` is merged on top of the baseline. */
  spawnOptions?: SpawnOptions;
  /** Test seam — defaults to node:child_process.spawn. */
  spawnFn?: typeof spawn;
}

/**
 * Spawn the daemon child process with `CCSM_DAEMON_SENTRY_DSN` populated
 * from resolveDaemonSentryDsn() (or `opts.dsn`). The variable is ALWAYS set
 * (even to '') so the daemon can rely on `process.env.CCSM_DAEMON_SENTRY_DSN`
 * being defined and apply its own short-circuit; this also lets a test assert
 * the supervisor wired the forwarding correctly without distinguishing
 * "didn't set" from "set to empty".
 */
export function spawnDaemon(opts: SpawnDaemonOpts): ChildProcess {
  const dsn = opts.dsn ?? resolveDaemonSentryDsn();
  const spawnFn = opts.spawnFn ?? spawn;
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CCSM_DAEMON_SENTRY_DSN: dsn,
  };
  if (opts.runtimeRoot) baseEnv.CCSM_RUNTIME_ROOT = opts.runtimeRoot;
  const merged: SpawnOptions = {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts.spawnOptions,
    env: { ...baseEnv, ...(opts.spawnOptions?.env ?? {}) },
  };
  return spawnFn(opts.binary, opts.args ?? [], merged);
}
