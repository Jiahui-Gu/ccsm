// Supervisor admin allowlist — pure decider that says yes/no on whether a
// given OS-level peer principal may invoke /hello or /shutdown. /healthz
// MUST NOT consult this allowlist (any peer that can reach the socket may
// probe readiness — spec ch03 §7.1 last paragraph).
//
// Spec refs:
//   - ch03 §7.1 admin allowlist table (per OS):
//       * Linux : uid 0 (root) OR uid of the `ccsm` system account
//       * macOS : uid 0 (root) OR `_ccsm` service account uid
//       * Windows: SID in BUILTIN\Administrators OR LocalService SID
//         (NT AUTHORITY\LocalService = S-1-5-19)
//   - ch02 §4 shutdown RPC admin-only (table-tested by
//     `test/integration/supervisor/admin-only.spec.ts` per spec lines 193-194).
//   - ch15 §3 forbidden-pattern #9 — endpoint URLs / response shapes locked
//     by `test/supervisor/contract.spec.ts` (already shipped).
//
// SRP: this module is a *decider*. It performs no I/O, never reads
// process.uid or process.env on its own. The caller (`server.ts`) injects
// an `AdminAllowlist` shape, the decider answers `isAllowed(peer)` against it.
// The default factory `defaultAdminAllowlist()` synthesises the spec's
// per-OS rules from `process.geteuid()` / well-known Windows SIDs so the
// supervisor server can wire it without an explicit config object.

import type { NamedPipePeerCred, UdsPeerCred } from '../auth/peer-info.js';

/**
 * The shape the supervisor's per-request admin gate consults. Closed —
 * exactly two principal kinds the daemon will ever see on the Supervisor
 * channel (UDS uid on POSIX, named-pipe SID on Windows). Loopback TCP is
 * forbidden on this channel by spec ch03 §7 (UDS-only forever).
 */
export interface AdminAllowlist {
  /** Numeric uids allowed on POSIX UDS (linux, macOS). */
  readonly uids: ReadonlySet<number>;
  /** SIDs allowed on Windows named-pipe. SID strings in canonical form. */
  readonly sids: ReadonlySet<string>;
}

/**
 * Well-known SIDs the spec table pins. Exposed as named constants so a
 * grep from spec ch03 §7.1 lands here directly.
 *
 *   - `BUILTIN\Administrators` group SID.
 *   - `NT AUTHORITY\LocalService` = `S-1-5-19` (the daemon's service
 *     account on Windows; allows the daemon to call its own Supervisor
 *     for self-test / shutdown coordination per ch03 §7.2 last bullet).
 *
 * Reference: Microsoft "Well-known SIDs"
 *   https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-security-identifiers
 */
export const SID_BUILTIN_ADMINISTRATORS = 'S-1-5-32-544';
export const SID_LOCAL_SERVICE = 'S-1-5-19';

/**
 * Build the spec-default allowlist for the current OS. Pure factory — takes
 * `process.platform` + `process.geteuid` (or a stub) so tests can drive
 * each OS branch without spawning a subprocess.
 *
 * Per ch03 §7.1:
 *   - Linux : uid 0 + the daemon's own euid (the `ccsm` service account).
 *   - macOS : uid 0 + the daemon's own euid (the `_ccsm` service account).
 *   - Windows: BUILTIN\Administrators group SID + LocalService SID.
 *
 * On POSIX, "uid of the ccsm system account" is whatever uid the daemon
 * process is currently running as. Reading it from `geteuid()` is the
 * right move: the installer (ch10 §5) is responsible for ensuring the
 * daemon runs as the correct service account; this file just trusts the
 * runtime. Hard-coding a numeric uid would couple the daemon to a
 * specific installer policy, which the spec does NOT pin.
 *
 * The Windows SID set CANNOT include "BUILTIN\Administrators group
 * membership" as a single SID — the spec's check is "SID is in the
 * Administrators group", which is a runtime token-membership query, not
 * an SID compare. The per-request `isAllowed` honours this: a caller's
 * SID may match `SID_BUILTIN_ADMINISTRATORS` directly (uncommon — that's
 * the group SID, not a user's SID), OR pass a separate
 * `isMemberOfAdministrators(sid)` callback (T1.7 ships the structural
 * gate; the membership-check addon lands alongside the named-pipe DACL
 * in T1.5 + the Windows installer DACL setup in ch10 §5).
 */
export function defaultAdminAllowlist(
  platform: NodeJS.Platform = process.platform,
  geteuid: () => number = posixGetEuid,
): AdminAllowlist {
  if (platform === 'win32') {
    return {
      uids: new Set<number>(),
      sids: new Set<string>([SID_BUILTIN_ADMINISTRATORS, SID_LOCAL_SERVICE]),
    };
  }
  // Linux + darwin + every other POSIX: root + the daemon's own euid.
  const uids = new Set<number>([0]);
  const ownUid = geteuid();
  if (Number.isInteger(ownUid) && ownUid >= 0) {
    uids.add(ownUid);
  }
  return { uids, sids: new Set<string>() };
}

/**
 * Default POSIX uid lookup. `process.geteuid` is undefined on Windows; the
 * caller of `defaultAdminAllowlist` should pass `platform = 'win32'` (which
 * skips this branch entirely) when running there. Calling this on Windows
 * returns `-1` so the eventual set is `{0}` — harmless because the Windows
 * branch never reads `uids` anyway.
 */
function posixGetEuid(): number {
  const fn = (process as { geteuid?: () => number }).geteuid;
  return typeof fn === 'function' ? fn() : -1;
}

/**
 * Per-request admin gate. Pure: returns `true` iff the peer's uid (POSIX)
 * or SID (Windows) appears in the allowlist. The caller is responsible for
 * choosing the gate — `/healthz` MUST NOT call this; `/hello` and
 * `/shutdown` MUST.
 *
 * `isMemberOfAdministrators` (Windows only) is an optional escape hatch
 * for the runtime token-membership query that named-pipe peer-cred
 * extraction can perform via `CheckTokenMembership`. T1.7 ships without
 * it; until it lands the supervisor accepts only callers whose own SID is
 * literally in the allowlist (typically just LocalService — i.e., the
 * daemon itself). The Windows installer is expected to wire up the proper
 * membership check alongside the DACL setup (ch10 §5 / spec ch03 §7.1
 * Windows row).
 */
export function isAllowed(
  allowlist: AdminAllowlist,
  peer: UdsPeerCred | NamedPipePeerCred,
  isMemberOfAdministrators?: (sid: string) => boolean,
): boolean {
  if (peer.transport === 'uds') {
    return allowlist.uids.has(peer.uid);
  }
  // namedPipe
  if (allowlist.sids.has(peer.sid)) return true;
  if (isMemberOfAdministrators && isMemberOfAdministrators(peer.sid)) return true;
  return false;
}
