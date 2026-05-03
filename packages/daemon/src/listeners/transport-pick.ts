// Listener A transport picker — pure decider that maps `(platform, env)`
// to a `BindDescriptor`. Spec ch03 §4 (transport pick A1-A4) plus the
// per-OS rationale from ch02 §2 (per-OS service shape).
//
// Pick rules (matches spec §4 + spike outcomes from
// `tools/spike-harness/probes/{uds-h2c, win-h2-named-pipe,
// loopback-h2c-on-25h2}/RESULT.md`):
//   - linux / darwin:  default A1 (UDS h2c) — `kind: 'KIND_UDS'`
//   - win32:           default A4 (named pipe h2) — `kind: 'KIND_NAMED_PIPE'`
//   - any platform with `CCSM_LISTENER_A_FORCE_LOOPBACK=1`:
//                      A2 (loopback h2c) — `kind: 'KIND_TCP_LOOPBACK_H2C'` —
//                      for dev / smoke runs that cannot use a UDS (CI Docker
//                      with no /run mount, IDE remote dev container, etc.).
//
// SRP: this module is a *decider* — pure function `(env, platform) →
// BindDescriptor`. No I/O, no side effects, no socket bind. The actual
// bind happens in `factory.ts` when `start()` runs.
//
// Layer 1 — repo-internal alternatives checked:
//   - `env.ts` `defaultListenerAddr()` already encodes the per-OS path
//     defaults; we *reuse* `env.paths.listenerAddr` directly rather than
//     re-deriving paths here. This keeps a single source of truth: any
//     future override (e.g. `CCSM_LISTENER_A_ADDR=/tmp/ccsm.sock`) flows
//     through env.ts and is picked up here transparently.
//   - The closed-enum `BindDescriptor` from `./types.ts` (T1.2) is the
//     contract; this module returns one of its four variants. The
//     `'KIND_TCP_LOOPBACK_H2_TLS'` variant (A3 fallback) is reserved for
//     v0.4 Listener B per ch03 §1a — v0.3 picks never produce it.

import type { DaemonEnv } from '../env.js';
import type { BindDescriptor } from './types.js';

/** NodeJS platform string. Re-exported as a type for testability — the
 * picker takes it as a parameter so unit tests can exercise every branch
 * on a single host without mocking `process.platform`. */
export type NodePlatform = NodeJS.Platform;

/** Loopback host pin. v0.3 always uses `127.0.0.1` (IPv4 loopback) — the
 * spec ch03 §1a closed enum does not cover `::1` for v0.3 and Connect
 * client transport factories key on the same string. */
const LOOPBACK_HOST = '127.0.0.1' as const;

/**
 * Loopback fallback port — `0` asks the OS for an ephemeral port. The
 * picker returns `0` here; the factory resolves the actual bound port
 * via `server.address()` after `start()` and exposes it through
 * `descriptor()` (which is the contract Electron reads via the
 * descriptor file, where the resolved port is recorded).
 *
 * Rationale: hard-coding a port number would (a) collide on dev
 * machines running multiple daemon instances and (b) require firewall
 * carve-outs on Win 11 even for loopback (Defender's loopback exemption
 * is not absolute on every profile). Ephemeral + descriptor-file-based
 * rendezvous is the spec's design for this exact reason.
 */
const EPHEMERAL_PORT = 0;

/**
 * Parse the loopback-fallback override from env. Returns `true` only when
 * the env var is exactly `'1'` (case-sensitive) — anything else (`'true'`,
 * `'yes'`, `'0'`, missing) is `false`. The strict check matches every
 * other env-flag idiom in this package and prevents accidental opt-ins
 * from common shell-typos like `CCSM_LISTENER_A_FORCE_LOOPBACK=true`.
 */
function forceLoopback(): boolean {
  return process.env.CCSM_LISTENER_A_FORCE_LOOPBACK === '1';
}

/**
 * Pick the transport for Listener A on this host.
 *
 * @param env       The daemon env (provides `paths.listenerAddr`).
 * @param platform  NodeJS platform string (`process.platform`).
 * @returns         A `BindDescriptor` whose `kind` is `'KIND_UDS'` |
 *                  `'KIND_NAMED_PIPE'` | `'KIND_TCP_LOOPBACK_H2C'` per
 *                  spec ch03 §1a.
 *
 * Spec ch03 §4 maps:
 *   - A1 (UDS h2c)            → linux / darwin default
 *   - A2 (loopback h2c)       → CCSM_LISTENER_A_FORCE_LOOPBACK=1, OR fallback
 *   - A3 (loopback h2 + TLS)  → reserved for v0.4 Listener B (NOT picked here)
 *   - A4 (named-pipe h2)      → win32 default
 *
 * The factory consumes this descriptor unchanged; the descriptor writer
 * (T1.6) writes `kind` directly into the `transport` field of
 * `listener-a.json` — they share one canonical vocabulary (spec ch03
 * §1a / §3.2).
 */
export function pickTransportForListenerA(
  env: DaemonEnv,
  platform: NodePlatform,
): BindDescriptor {
  // Operator override: forces loopback regardless of OS. Used by smoke
  // harnesses that cannot rely on UDS / named-pipe (e.g. running the
  // daemon inside a container without a writable `/run`).
  if (forceLoopback()) {
    return {
      kind: 'KIND_TCP_LOOPBACK_H2C',
      host: LOOPBACK_HOST,
      port: EPHEMERAL_PORT,
    };
  }

  if (platform === 'win32') {
    // A4: named pipe. `env.paths.listenerAddr` is already the
    // `\\.\pipe\ccsm-daemon` shape on win32 (set by `defaultListenerAddr`
    // in env.ts), so we forward it verbatim. Per-user pipe naming
    // (`\\.\pipe\ccsm-<sid>`) is a v0.3.x hardening item; the env-var
    // override path covers it today.
    return {
      kind: 'KIND_NAMED_PIPE',
      pipeName: env.paths.listenerAddr,
    };
  }

  // A1: UDS. `env.paths.listenerAddr` is the OS-appropriate UDS path
  // (e.g. `/var/run/com.ccsm.daemon/daemon.sock` on darwin,
  // `/run/ccsm/daemon.sock` on linux).
  return {
    kind: 'KIND_UDS',
    path: env.paths.listenerAddr,
  };
}
