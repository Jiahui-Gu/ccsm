// daemon.shutdownForUpgrade handler (T21) — control-socket RPC that prepares
// the daemon for an in-place auto-update by writing a clean-shutdown marker
// the next supervisor boot will treat as "do not increment crash-loop counter".
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-design.md / frag-6-7 §6.4
//     "`daemon.shutdownForUpgrade` RPC + shutdown marker" lock — caller is
//     Electron-main on `update-downloaded`; daemon MUST atomically write
//     `<dataRoot>/daemon.shutdown` (O_CREAT|O_EXCL on `.tmp` → fsync → rename),
//     then run the §6.6.1 ordered shutdown sequence, release the daemon.lock,
//     and process.exit(0) within 5 s.
//   - frag-6-7 §6.4 "Marker payload is a single line
//     `{ "reason": "upgrade", "version": "<current>", "ts": <epoch_ms> }`"
//     — schema MUST match the T22 reader (`ShutdownMarkerPayload`).
//   - frag-6-7 §6.4 "Marker corruption / partial write (rel-S-R8)" — the T22
//     reader treats any non-ENOENT condition as PRESENT, so even a half-flushed
//     `daemon.shutdown` (post-rename, pre-fsync of dir entry) is safe; the
//     write protocol below preserves that invariant.
//   - T22 reader (a797826): exposes `DAEMON_SHUTDOWN_MARKER_FILENAME` constant
//     + `ShutdownMarkerPayload` shape — this writer matches both.
//   - T13 runtimeRoot (34ff871): caller injects `markerDir = resolveRuntimeRoot()`
//     so this module stays path-agnostic and trivially testable.
//
// Single Responsibility (per repo memory `feedback_single_responsibility.md`):
//   - PRODUCER: callers (control-socket transport) deliver an empty `req` and
//     a `ShutdownForUpgradeContext` containing the current daemon version +
//     a clock + the marker dir.
//   - DECIDER: `planShutdownForUpgrade` returns a fully-formed plan
//     (`markerPayload` + ordered `planSteps`) — a pure function. ZERO I/O.
//   - SINK: `executeShutdownForUpgrade(plan, actions)` invokes the injected
//     `ShutdownForUpgradeActions` (writeMarker, runShutdownSequence,
//     releaseLock, exit). The default action provider performs the real
//     side effects; tests inject fakes. The handler NEVER calls process.exit
//     directly (spec §6.4 step 4 ownership lives in the actions sink, not the
//     decider).
//
// Distinct from T20 `daemon.shutdown` (uninstall path): T20 has no marker and
// a 2 s force-kill budget. T21's marker is the load-bearing signal that lets
// the next-boot supervisor distinguish "planned upgrade" from "crash" — the
// difference between a clean upgrade and a false crash-loop trip.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import {
  DAEMON_SHUTDOWN_MARKER_FILENAME,
  type ShutdownMarkerPayload,
} from '../marker/reader.js';

/** Marker reason MUST be the literal `'upgrade'` for the T22 reader to map it
 *  to the §6.1 R2 "do not increment crash-loop counter" branch. The reader's
 *  `ShutdownMarkerPayload.reason` is widened to `'upgrade' | string` for
 *  forward-compat, but the writer is the single producer and stays narrow. */
export const SHUTDOWN_MARKER_REASON_UPGRADE = 'upgrade' as const;

/** Tmp-file suffix per spec §6.4 step 1 (atomic write protocol:
 *  `daemon.shutdown.tmp` → rename → `daemon.shutdown`). Exported so wiring
 *  layer + tests share one literal. */
export const DAEMON_SHUTDOWN_MARKER_TMP_SUFFIX = '.tmp' as const;

/** Daemon protocol version field surfaced inside the marker payload alongside
 *  the daemon binary semver. The spec calls it `version` (the daemon binary
 *  semver), not the protocol version — kept narrow to match the reader. */
export interface ShutdownForUpgradeContext {
  /** Semver-string of the running daemon binary (matches `/healthz.version`).
   *  Becomes `markerPayload.version`. */
  readonly version: string;
  /** Epoch-ms clock — injected so tests get deterministic `ts`. Production =
   *  `() => Date.now()`. */
  readonly now: () => number;
  /** Absolute path to the directory under which `daemon.shutdown` lives.
   *  Production = `resolveRuntimeRoot()` (T13). */
  readonly markerDir: string;
}

/** RPC ack returned over the wire. The caller (Electron-main) uses
 *  `accepted: true` as the 5 s ack window confirmation per frag-11 §11.6.5. */
export interface ShutdownForUpgradeAck {
  readonly accepted: true;
  /** Echo back the planned reason so the supervisor log entry on the caller
   *  side carries it without needing to mirror the constant. */
  readonly reason: typeof SHUTDOWN_MARKER_REASON_UPGRADE;
}

/** Step IDs in the order the actions sink MUST execute them. The decider
 *  emits this fixed sequence; the sink iterates and invokes the matching
 *  action. Naming mirrors the spec §6.4 step numbering 1→4. */
export type ShutdownForUpgradePlanStep =
  | 'write-marker'
  | 'run-shutdown-sequence'
  | 'release-lock'
  | 'exit';

export interface ShutdownForUpgradePlan {
  readonly ack: ShutdownForUpgradeAck;
  readonly markerPayload: ShutdownMarkerPayload;
  readonly markerPath: string;
  readonly markerTmpPath: string;
  /** Ordered: marker → §6.6.1 drain → unlock → exit(0). */
  readonly planSteps: ReadonlyArray<ShutdownForUpgradePlanStep>;
}

/** Pure decider. No I/O. No clock side effects beyond the injected `now()`.
 *  Same `(req, ctx)` always yields the same plan for the same clock value. */
export function planShutdownForUpgrade(
  _req: unknown,
  ctx: ShutdownForUpgradeContext,
): ShutdownForUpgradePlan {
  const ts = ctx.now();
  const markerPayload: ShutdownMarkerPayload = {
    reason: SHUTDOWN_MARKER_REASON_UPGRADE,
    version: ctx.version,
    ts,
  };
  const markerPath = join(ctx.markerDir, DAEMON_SHUTDOWN_MARKER_FILENAME);
  const markerTmpPath = markerPath + DAEMON_SHUTDOWN_MARKER_TMP_SUFFIX;

  return {
    ack: { accepted: true, reason: SHUTDOWN_MARKER_REASON_UPGRADE },
    markerPayload,
    markerPath,
    markerTmpPath,
    planSteps: [
      'write-marker',
      'run-shutdown-sequence',
      'release-lock',
      'exit',
    ],
  };
}

// ---------------------------------------------------------------------------
// Sink — actions provider + executor
// ---------------------------------------------------------------------------

/** Injected side-effect surface. The default provider wires real fs / lock /
 *  shutdown / exit; tests pass fakes that record call order. */
export interface ShutdownForUpgradeActions {
  /** Atomic marker write: tmp → fsync(file) → fsync(dir) → rename. MUST be
   *  crash-safe so a power loss mid-write never leaves a partially-renamed
   *  `daemon.shutdown`. */
  writeMarker(plan: ShutdownForUpgradePlan): Promise<void>;
  /** §6.6.1 drain ordering: subscribers → SIGCHLD wind-down → DB checkpoint
   *  → pino.final. Owned by the daemon shell; injected here as an opaque
   *  callback so this handler stays decoupled from session/db modules. */
  runShutdownSequence(): Promise<void>;
  /** `proper-lockfile` `unlock(<dataRoot>/daemon.lock)`. Injected so tests
   *  don't touch a real lockfile. */
  releaseLock(): Promise<void>;
  /** `process.exit(0)`. Last call; never returns under production. Injected
   *  so tests can verify it was called WITHOUT actually exiting the worker. */
  exit(code: number): void;
}

/** Default marker-write implementation. Spec §6.4 step 1 mandates
 *  `O_CREAT | O_EXCL | O_WRONLY` on the tmp file, then `rename()` over the
 *  final name. We add `fsync(file)` + `fsync(dir)` so the entry is durable
 *  before the rename — without the dir fsync the rename can be lost on a
 *  power-cut and the next boot sees no marker (false crash-loop trip).
 *
 *  If the tmp file already exists (left over from a previous crashed write),
 *  EEXIST is the spec-correct response per O_EXCL — but a stale tmp is also
 *  the literal "partial-write window" the T22 reader is designed to tolerate
 *  on the FINAL marker, not the tmp. We unlink + retry once: a stale tmp is
 *  unrecoverable garbage (no other process owns it; the daemon is the single
 *  writer per §6.4) and refusing to retry would brick every subsequent
 *  upgrade after a single crashed shutdown.
 */
export async function defaultWriteShutdownMarker(
  plan: ShutdownForUpgradePlan,
): Promise<void> {
  const data = JSON.stringify(plan.markerPayload);

  // Open the tmp with O_CREAT|O_EXCL|O_WRONLY (mode 0o600 → user-only; on
  // Windows this maps to inherited per-user ACL). On EEXIST, unlink stale
  // tmp and retry once (see jsdoc rationale).
  let handle: import('node:fs/promises').FileHandle;
  try {
    handle = await fs.open(plan.markerTmpPath, 'wx', 0o600);
  } catch (err) {
    if (isEexist(err)) {
      await fs.unlink(plan.markerTmpPath).catch(() => undefined);
      handle = await fs.open(plan.markerTmpPath, 'wx', 0o600);
    } else {
      throw err;
    }
  }

  try {
    await handle.writeFile(data);
    // fsync the file so the data is on disk BEFORE the rename. Without this,
    // a power-cut between rename and journal-flush can produce a zero-length
    // marker — the T22 reader does treat that as PRESENT (good), but we
    // prefer the payload land too so forensics work.
    await handle.sync();
  } finally {
    await handle.close();
  }

  // Atomic rename: on POSIX rename(2) is atomic within the same filesystem;
  // on Windows fs.promises.rename uses MoveFileExW with REPLACE_EXISTING for
  // the cross-volume case (here always same dir = same volume).
  await fs.rename(plan.markerTmpPath, plan.markerPath);

  // fsync the directory so the rename is durable. Best-effort: Windows
  // doesn't support fsync on a directory handle and will throw EPERM /
  // EISDIR depending on the libuv version — swallow those, the rename
  // itself is already journalled by NTFS.
  try {
    const dirHandle = await fs.open(
      dirnameOf(plan.markerPath),
      'r',
    );
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Best-effort; see jsdoc.
  }
}

function isEexist(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'EEXIST'
  );
}

function dirnameOf(p: string): string {
  // node:path/posix.dirname would mangle Windows paths; use a tiny inline
  // split that handles both separators without dragging in `node:path` here
  // (the only other path use in this file is `join` in the decider).
  const lastSep = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return lastSep <= 0 ? p : p.slice(0, lastSep);
}

/**
 * Sink executor. Iterates `plan.planSteps` in order, invoking the matching
 * action. Returns AFTER `release-lock`; the `exit` step is invoked but the
 * default `exit` action calls `process.exit(0)` and never returns, so any
 * code after this call should not be relied on in production.
 *
 * Tests inject an `exit` action that records the code; the function returns
 * normally so the `await` at the call site resolves.
 *
 * Failure mode: if `writeMarker` throws, the error propagates and the
 * remaining steps are NOT executed. The caller (control-socket transport)
 * surfaces this to Electron-main, which then falls back to its 5 s force-kill
 * (frag-11 §11.6.5 step 4). This preserves the spec invariant: a failed
 * marker write means "no upgrade marker" → next boot applies normal
 * crash-loop accounting, which is the conservative correct behaviour.
 */
export async function executeShutdownForUpgrade(
  plan: ShutdownForUpgradePlan,
  actions: ShutdownForUpgradeActions,
): Promise<void> {
  for (const step of plan.planSteps) {
    switch (step) {
      case 'write-marker':
        await actions.writeMarker(plan);
        break;
      case 'run-shutdown-sequence':
        await actions.runShutdownSequence();
        break;
      case 'release-lock':
        await actions.releaseLock();
        break;
      case 'exit':
        actions.exit(0);
        break;
      default: {
        // Exhaustiveness guard — if a new step is added to the plan tuple
        // without updating this switch, TypeScript flags it at compile time.
        const _exhaustive: never = step;
        void _exhaustive;
      }
    }
  }
}

/**
 * Convenience adapter for the T16 dispatcher signature
 * `(req) => Promise<unknown>`. Wires the pure decider to the injected
 * actions sink and returns the ack synchronously after kicking off the
 * shutdown sequence in the background.
 *
 * The shutdown sequence runs AFTER the ack is returned (fire-and-forget
 * with a `.catch` to surface marker-write failures to the injected logger).
 * This matches spec §6.4 "ack within 5 s" — the caller MUST receive the ack
 * before the daemon starts tearing down, so the 5 s budget covers the full
 * marker → drain → unlock → exit window starting AFTER the wire reply.
 *
 * Wiring (post-T21-merge follow-up commit):
 *   dispatcher.register(
 *     'daemon.shutdownForUpgrade',
 *     makeShutdownForUpgradeHandler(ctx, actions, onError),
 *   );
 */
export function makeShutdownForUpgradeHandler(
  ctx: ShutdownForUpgradeContext,
  actions: ShutdownForUpgradeActions,
  onError?: (err: unknown) => void,
): (req: unknown) => Promise<ShutdownForUpgradeAck> {
  return async (req: unknown) => {
    const plan = planShutdownForUpgrade(req, ctx);
    // Fire-and-forget the side effects. The caller awaits only the ack.
    // We schedule via queueMicrotask so the wire-level reply is flushed
    // before the marker write begins; this guarantees the ack arrives at
    // the supervisor BEFORE process.exit(0) tears down the socket.
    queueMicrotask(() => {
      executeShutdownForUpgrade(plan, actions).catch((err) => {
        if (onError) onError(err);
      });
    });
    return plan.ack;
  };
}
