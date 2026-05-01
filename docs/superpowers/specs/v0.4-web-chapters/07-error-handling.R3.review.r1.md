# Review of chapter 07: Error handling and edge cases

Reviewer: R3 (Reliability / observability)
Round: 1

## Findings

### P1-1 (must-fix): JWT-expiry redirect loop has no break-out

**Where**: chapter 07 §2 ("Cloudflare Access misconfigured") + §4 ("JWT expires mid-session").
**Issue**: §2 acknowledges the "wrong AUD" failure produces an infinite redirect loop, mitigated only by daemon logging once per minute. §4 describes the happy path of JWT-expiry. But §4 has no failure path: what if Access returns a JWT that the daemon STILL can't validate (e.g. team-name was changed in dashboard, daemon's stored team-name is stale)? Same redirect loop without rate-limit-per-client. User refreshes → loop → refreshes → loop. No client-side detection of "this is the second redirect in <5s, abort."
**Why this is P1**: production-down scenario for the user. They cannot self-diagnose; loop continues until they think to check daemon log.
**Suggested fix**: §4 add failure path: SPA tracks redirect attempts (sessionStorage counter); 3 redirects in 30s → stop and show "Authentication looped — check daemon log or Cloudflare Access policy" banner with diagnostics link. Same fix applies to §2.

### P1-2 (must-fix): Daemon disk-full during write-RPC has undefined client semantics

**Where**: chapter 07 §1 ("Daemon disk full").
**Issue**: Spec says "SQLite write fails with `SQLITE_FULL`. Daemon's existing storage-full handler surfaces a `storage.full` banner." It doesn't say what the in-flight RPC returns. Does the bridge see `internal` Connect error? Does it retry (and re-burn disk attempts)? Does the client know to NOT retry write RPCs because they'd all fail until disk freed? Idempotency of partial writes on `SQLITE_FULL` rollback?
**Why this is P1**: cascading failure: client retries → more disk writes attempted → log fills → tighter spiral. Need explicit "stop retrying writes when storage.full" gate.
**Suggested fix**: §1 specify: SQLITE_FULL maps to Connect `resource_exhausted`. Bridge halts further write RPCs (returns local error) until daemon clears the `storage.full` flag. Reads continue normally. Add to chapter 02 §8 interceptor table: "storage-full short-circuit interceptor for write RPCs."

### P1-3 (must-fix): Updater rollback path on Win not verified for v0.4

**Where**: chapter 07 §8 ("Daemon binary corrupted (auto-update botched)") + chapter 10 R1.
**Issue**: §8 says "v0.3 frag-11 §11 + auto-update rollback (.bak path) covers this." R1 acknowledges the Win updater is "finicky." v0.4 changes: bundled `cloudflared` binary (~20 MB), new build artifacts, larger installer. None of the rollback testing carries forward automatically — `.bak` mechanism may not handle the now-larger payload or the new files (cloudflared binary). What if rollback ALSO fails (corrupted both .exe and .bak)?
**Why this is P1**: chapter 10 R1 already flags it HIGH severity. Spec defers to v0.3 mechanism without re-validating in v0.4 dogfood. R3-specific: no defined "rollback also failed" recovery state.
**Suggested fix**: §8 add: explicit dogfood check at M2 close (per chapter 09 §7 post-M2 7-day) for force-update v0.4-rc1 → rc2 + force ROLLBACK from rc2 → rc1 to verify both directions. Add catastrophic-recovery doc: "if both .exe and .bak fail, user must run installer manually from Public Desktop." Cite the manual recovery path in user-facing docs.

### P2-1 (nice-to-have): Bridge half-swap intermediate states (M1 in-flight) not enumerated

**Where**: chapter 07 §5 (wire skew) + chapter 09 §3 M2.
**Issue**: §5 covers full-version skew (v0.3 vs v0.4) but not the intra-M2-batch skew: during M2.A → M2.C, the data socket has SOME RPCs on Connect and SOME still on envelope. If one RPC hits Connect handler that hasn't been wired yet (developer error / merge order issue), Connect returns `unimplemented` — what does the bridge do? §5 says no soft-fallback. The bridge would surface `daemon.unreachable` for one RPC while others work.
**Why P2 not P1**: this is a developer/dogfood-window issue, not a user-facing v0.4-shipped one. But worth documenting for the M2 fixer.
**Suggested fix**: §5 add subsection: "during M2 bridge-swap, an `unimplemented` Connect error on a single bridge function is treated as a development error, surfaces a different banner ('feature unavailable in this build'), does NOT mark daemon unreachable for other bridges. Removed at M2.Z cleanup."

### P2-2 (nice-to-have): Drop-slowest event count not surfaced to user

**Where**: chapter 07 §3 ("Bandwidth-constrained network") + chapter 06 §7.
**Issue**: When drop-slowest fires repeatedly, user sees "PTY output skips ahead" but has no indication of how badly. No visible degradation badge on the affected session.
**Suggested fix**: Per-session drop-counter exposed in UI session-row badge (e.g. small "throttled" tag with count). Helps user know "not your fault — the network is slow."

### P2-3 (nice-to-have): Catastrophic recovery section missing "what to send the developer"

**Where**: chapter 07 §8.
**Issue**: §8 covers SQLite corruption (delete db, recreate), updater botched (re-run installer), CF compromise (out of scope), web SPA bug (rollback). Doesn't mention: when user encounters non-recoverable issue, what artifacts should they collect for bug report? Currently they have to know to grab `~/.ccsm/daemon.log`, `~/.ccsm/cloudflared.log`, browser console screenshot.
**Suggested fix**: Add §8.5 "Bug report kit": single command in tray menu "Export diagnostics" zips relevant logs + last N PTY snapshots + masked settings (no tokens) for user to send.

## Cross-file findings (if any)

- **Redirect-loop break-out (P1-1)** spans chapter 07 §2 + §4 + chapter 04 §6 (banner taxonomy). Single fixer aligns with chapter 04 P1-3.
- **Updater rollback validation (P1-3)** ties to chapter 09 §7 M2 dogfood gate. Need explicit test cited.
