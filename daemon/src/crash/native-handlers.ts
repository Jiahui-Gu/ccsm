// daemon/src/crash/native-handlers.ts
//
// Phase 3 crash observability (spec §5.2 option A, plan Task 11).
//
// POSIX-only best-effort signal trap for SIGSEGV / SIGBUS / SIGFPE / SIGILL /
// SIGABRT. Writes a JSON marker (`<runtimeRoot>/crash/<bootNonce>-native.dmp`)
// describing the signal, pid, V8 stack at trap time, and runtime versions.
//
// CAVEAT: a real native segfault inside V8 / a native module cannot reliably
// run JS afterwards — so this trap fires only for signals *delivered* to the
// process (e.g. `kill -SEGV <pid>` from the supervisor, or a co-operative
// abort via `process.kill(pid, 'SIGSEGV')` from another runtime). For an
// in-process V8 crash, the supervisor's exit-code + stderr-tail capture
// (phase 1) remains the only artifact. A future Windows path
// (DrWatson / WER) is deferred — see spec §5.2.
//
// The output file is named `*-native.dmp` (not `.json`) so the supervisor's
// adoption logic in `electron/daemon/supervisor.ts` can rename it to
// `backend.dmp` inside the umbrella incident dir, matching the spec §10
// directory layout. The contents are JSON regardless of extension — this
// is a marker, not a real minidump (Crashpad-style minidumps are deferred
// pending native-handler work).
//
// Skipped on Windows (no POSIX signals).
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface InstallNativeOpts {
  /** `CCSM_RUNTIME_ROOT`-rooted path; the marker lands at `<runtimeRoot>/crash/<bootNonce>-native.dmp`. */
  runtimeRoot: string;
  bootNonce: string;
  /** Test seam — defaults to `process`. */
  processRef?: NodeJS.Process;
  /** Test seam — defaults to `fs.writeFileSync`. */
  writeFileSyncImpl?: (p: string, data: string) => void;
}

/** Signals trapped on POSIX. Order matters only for documentation. */
export const TRAPPED_SIGNALS = ['SIGSEGV', 'SIGBUS', 'SIGFPE', 'SIGILL', 'SIGABRT'] as const;
export type TrappedSignal = (typeof TRAPPED_SIGNALS)[number];

interface NativeMarkerV1 {
  schemaVersion: 1;
  surface: 'daemon-native';
  signal: TrappedSignal;
  pid: number;
  bootNonce: string;
  ts: string;
  stack: string;
  env: {
    node: string;
    daemon: string;
    platform: NodeJS.Platform;
    arch: string;
  };
}

interface RegisteredHandler {
  /** Absolute path the marker would be written to on signal. */
  dmpPath: string;
  /** Signals this handler subscribed to. Empty on win32. */
  signals: readonly TrappedSignal[];
}

let _registered: RegisteredHandler | null = null;

/**
 * Install POSIX signal trap for native-fault signals. No-op on Windows.
 *
 * Returns the registered handler descriptor (for tests / introspection); also
 * exposed via `_registeredHandlerForTest()`.
 */
export function installNativeCrashHandlers(opts: InstallNativeOpts): RegisteredHandler | null {
  const proc = opts.processRef ?? process;
  if (proc.platform === 'win32') {
    _registered = null;
    return null;
  }

  const dir = path.join(opts.runtimeRoot, 'crash');
  fs.mkdirSync(dir, { recursive: true });
  const dmpPath = path.join(dir, `${opts.bootNonce}-native.dmp`);

  const writeFileSyncImpl = opts.writeFileSyncImpl ?? ((p, d) => fs.writeFileSync(p, d, 'utf8'));

  function makeMarker(signal: TrappedSignal): NativeMarkerV1 {
    return {
      schemaVersion: 1,
      surface: 'daemon-native',
      signal,
      pid: proc.pid,
      bootNonce: opts.bootNonce,
      ts: new Date().toISOString(),
      stack: new Error('native-fault marker').stack ?? '',
      env: {
        node: proc.versions.node,
        daemon: (proc.env.npm_package_version as string | undefined) ?? '',
        platform: proc.platform,
        arch: proc.arch,
      },
    };
  }

  for (const signal of TRAPPED_SIGNALS) {
    proc.on(signal as NodeJS.Signals, () => {
      try {
        const marker = makeMarker(signal);
        writeFileSyncImpl(dmpPath, JSON.stringify(marker, null, 2));
      } catch {
        // swallow — best-effort; supervisor still has exit-code / stderr.
      }
      // Don't re-raise: the caller (supervisor) sees the signal via
      // `child.on('exit')`'s `signal` argument and adopts the marker.
      try { proc.exit(70); } catch { /* swallow */ }
    });
  }

  _registered = { dmpPath, signals: TRAPPED_SIGNALS };
  return _registered;
}

/** Test-only inspector. Returns the most recent registration, or null on win32 / not-yet-installed. */
export function _registeredHandlerForTest(): RegisteredHandler | null {
  return _registered;
}

/** Test-only reset. */
export function _resetForTest(): void {
  _registered = null;
}
