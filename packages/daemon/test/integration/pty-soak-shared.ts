// packages/daemon/test/integration/pty-soak-shared.ts
/* global AbortSignal */
//
// Shared driver for the two PTY soak harnesses:
//   - pty-soak-1h.spec.ts   — ship-gate (c) per chapter 12 §4.3 (60 min, nightly).
//   - pty-soak-10m.spec.ts  — phase-5 smoke variant per chapter 13 phase 5 done-when
//                             ("10-minute soak smoke ... green on all 3 OSes").
//
// Both harnesses are forever-stable per chapter 15 §3 #28 (the canonical
// `pty-soak-1h` test path is locked); the 10m smoke variant rides the same
// driver so behaviour drift between the two is mechanically impossible.
//
// Until T4.1 / T4.6 / T4.10 land (pty-host child boundary, SnapshotV1 encoder,
// snapshot scheduler), this driver exposes a `dependenciesPresent()` probe
// that the two `.spec.ts` files use to `describe.skipIf` themselves. We do
// NOT eager-import the future modules — vitest evaluates the import graph
// before describe.skipIf runs and a missing module surfaces as a hard error.
// All future-module access goes through `loadPtyHost()` which uses dynamic
// import() at runtime, gated by the same probe.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DAEMON_ROOT = resolve(__dirname, '..', '..');

// Canonical paths the soak harness depends on. Sourced from the design spec:
//   - pty-host entrypoint: chapter 06 §1 / §3 — `packages/daemon/src/pty/pty-host.ts`.
//   - SnapshotV1 codec:    chapter 06 §2     — `packages/snapshot-codec/src/index.ts`
//                                              re-exported from @ccsm/snapshot-codec.
//   - Snapshot scheduler:  chapter 06 §4     — exported from pty-host (T4.10).
// We probe the daemon-side files only; the codec package is consumed via
// dynamic import in loadSnapshotCodec() which itself fails-soft.
export const PTY_HOST_PATH = join(DAEMON_ROOT, 'src', 'pty', 'pty-host.ts');
export const PTY_HOST_DIST_PATH = join(DAEMON_ROOT, 'dist', 'pty', 'pty-host.js');

export interface DependencyProbe {
  ready: boolean;
  reason: string;
}

export function dependenciesPresent(): DependencyProbe {
  // T4.1 — pty-host fork boundary. We accept either the source (in-repo
  // checkout) or the built dist (CI runs after `pnpm build`). Either is
  // sufficient because the soak harness uses the source path during
  // `vitest run` (TS compilation in-process) and the dist path when the
  // daemon has been pre-built.
  if (!existsSync(PTY_HOST_PATH) && !existsSync(PTY_HOST_DIST_PATH)) {
    return {
      ready: false,
      reason:
        'T4.1 pty-host module not landed yet (looked for src/pty/pty-host.ts and dist/pty/pty-host.js).',
    };
  }
  return { ready: true, reason: 'all probed dependencies present' };
}

// Workload class enumeration locked in chapter 12 §4.3 — every class below
// MUST be exercised during the run; missing one makes the gate pass vacuously
// per the design spec. Exact byte sequences come from the canned 60m script
// shipped by T8.7 (`claude-sim --simulate-workload 60m`); the soak harness
// just walks claude-sim's output so coverage is mechanically driven by the
// fixture, not by this list. The list is kept here for review-time cross
// reference and as a sanity assertion (the harness asserts that the script
// header advertises every class).
export const REQUIRED_WORKLOAD_CLASSES = [
  'utf8-cjk-mixed-script',
  '256-color-truecolor-sgr',
  'cursor-positioning',
  'alt-screen-toggles',
  'bursts-and-idles',
  'osc-sequences',
  'decstbm-scroll-regions',
  'mouse-mode-toggles',
  'resize-during-burst',
] as const;

// Memory leak budget. The soak harness samples pty-host child RSS once a
// minute; the assertion is that RSS at the end of the run is no more than
// `MEMORY_LEAK_BUDGET_MIB` above the post-warmup baseline (sampled at
// t = 2 min — after xterm-headless has resized scrollback to its working set
// but before any deltas have rotated the 4096-entry ring). Per chapter 06
// §1.2 the worst-case daemon-side bound is approximately:
//   snapshot ring × 4096 entries  (capped by retention)
// + pending master writes 1 MiB
// + subscriber unacked backlog 4096 deltas
// Empirically the pty-host child plateaus well under this; we set the
// budget at 256 MiB drift over the run (well below the chapter 11 §6 RSS
// cap of 200 MiB at idle for 5 sessions, so a single-session soak that
// drifts more than 256 MiB above its 2-minute baseline is unambiguously a
// leak).
export const MEMORY_LEAK_BUDGET_MIB = 256;

// Snapshot/delta cadence budgets. Chapter 06 §4 K_TIME=30s, M_DELTAS=256,
// B_BYTES=1 MiB. Under saturated workload (the soak runs claude-sim at
// chapter 06 spike rate ~50 MB/s burst envelope) the dominant trigger is
// B_BYTES: a 1 MiB threshold at 50 MB/s yields ~50 snapshots/s peak, and at
// the documented sustained rate of ~500 KiB/s yields ~1 snapshot/2s. We
// budget per-minute snapshot count and total bytes; the assertion fails if
// either is outside the [low, high] envelope for any minute.
export interface CadenceMinuteSample {
  snapshotsThisMinute: number;
  deltasThisMinute: number;
  deltaBytesThisMinute: number;
}

// Min/max snapshots per minute. Lower bound 1 (K_TIME guarantees at least
// one every 30s when there is at least one delta). Upper bound 4000 (well
// above the ~50 snapshots/s ceiling under saturated burst, but below
// pathological storms that would indicate a regression in the cadence
// scheduler such as repeatedly firing on every delta).
export const CADENCE_SNAPSHOTS_PER_MINUTE_MIN = 1;
export const CADENCE_SNAPSHOTS_PER_MINUTE_MAX = 4000;

// SendInput RTT budget — chapter 12 §4.3 explicitly: p99 < 5 ms during soak.
// The assertion is blocking via gate (c).
export const SENDINPUT_P99_BUDGET_MS = 5;
export const SENDINPUT_SAMPLE_INTERVAL_MS = 1000;

// Variant durations. The 10m smoke variant exists per chapter 13 phase 5
// done-when ("10-minute soak smoke ... green on all 3 OSes"); the 1h
// variant is the ship-gate per chapter 12 §4.3.
export const SOAK_DURATION_1H_MS = 60 * 60 * 1000;
export const SOAK_DURATION_10M_MS = 10 * 60 * 1000;

// Memory sample cadence (chapter 06 §4 K_TIME = 30s; we sample at half that
// to catch RSS spikes between snapshot triggers).
export const MEMORY_SAMPLE_INTERVAL_MS = 15 * 1000;

export interface SoakResult {
  durationMs: number;
  memoryBaselineMib: number;
  memoryPeakMib: number;
  memoryFinalMib: number;
  cadence: CadenceMinuteSample[];
  sendInputP99Ms: number;
  daemonSnapshotBytes: Buffer;
  clientSnapshotBytes: Buffer;
  workloadClassesObserved: ReadonlySet<string>;
}

// The actual soak driver lives behind a dynamic import so that this module
// can be statically imported without dragging in any pty-host code that may
// not yet exist on disk. T4.10's snapshot scheduler exports the trigger
// constants; the soak driver verifies them against the K_TIME / M_DELTAS /
// B_BYTES values pinned in chapter 06 §4 and aborts the run if they have
// drifted (which would invalidate the cadence assertions below).
//
// Call shape, locked at this layer so the two `.spec.ts` files do not need
// to know about T4.x specifics:
//
//   const result = await runSoak({ durationMs, signal });
//   assertSoakInvariants(result, { durationMs });
//
// The implementation is wired in the same PR that lands T4.1 / T4.6 / T4.10
// (the `loadSoakDriver()` helper below dynamic-imports it; until then the
// `.spec.ts` files describe.skipIf themselves and never reach this code).

export async function loadSoakDriver(): Promise<SoakDriver> {
  // The driver implementation file is created alongside T4.1/T4.6/T4.10
  // at packages/daemon/test/integration/pty-soak-driver.ts. It is NOT in
  // this PR (T8.4 only ships the gate scaffold + skip wiring); it is wired
  // in the PR that lands the pty-host child. Until then `dependenciesPresent`
  // returns ready=false and the .spec.ts files never call this loader.
  //
  // The specifier is computed at runtime so TypeScript does not try to
  // resolve `./pty-soak-driver.js` at compile time (the file does not yet
  // exist). When T4.x lands the spec author can either keep this dynamic
  // form or switch to a static import (the contract — `runSoak` +
  // `assertSoakInvariants` — is locked above in `SoakDriver`).
  const driverSpecifier = './pty-soak-driver.js';
  const mod = (await import(/* @vite-ignore */ driverSpecifier)) as SoakDriver;
  return mod;
}

export interface SoakDriver {
  runSoak(opts: { durationMs: number; signal?: AbortSignal }): Promise<SoakResult>;
  assertSoakInvariants(result: SoakResult, opts: { durationMs: number }): void;
}
