# R0 (zero-rework) review of 02-process-topology.md

## P0 findings (block ship; v0.3 design must change to remove future rework)

### P0.1 Linux `installer adds installing user to group ccsm` — multi-user-on-one-host breaks v0.3 user expectations and v0.4 inherits

**Location**: `02-process-topology.md` §2.3
**Issue**: "Per-user Electron: installer adds the installing user to group `ccsm` (postinst, requires logout/login)." On a multi-user Linux host, only the installing user gets group membership; other users can't reach Listener A's `/run/ccsm/daemon.sock` even though the daemon they share is running. v0.4 with cf-access principals on Listener B *does* solve the "other users on the same box" problem (they reach via cloudflared) — but only if cloudflared is configured. v0.3 multi-user is silently broken for non-installing users; v0.4 inherits unless cloudflared is the only ingress.
**Why P0**: UNACCEPTABLE pattern "Any v0.3 single-tenant assumption that becomes wrong with multi-principal". The "single user is in `ccsm` group" assumption baked into postinst is exactly that.
**Suggested fix**: In v0.3 ship a per-user proxy socket scheme: daemon writes `/run/ccsm/users/<uid>.sock` for each detected interactive user (or on-demand at first connect attempt by anyone in any group). OR document explicitly that v0.3 supports exactly one Electron user per host, and lock that constraint in chapter 15 §3 forbidden-patterns ("daemon does NOT support multiple OS users with Electron clients on the same host in v0.3; v0.4 cf-access via Listener B is the only multi-user path"). Either way, take a position; don't leave a partial-multi-user posture that v0.4 has to clean up.

### P0.2 Daemon RPC accept policy during boot uses `UNAVAILABLE` — same code path on Listener B will need different signal

**Location**: `02-process-topology.md` §3 step 5; §6 first bullet
**Issue**: "If a client connects mid-startup (Supervisor `/healthz` 503), the daemon refuses with `UNAVAILABLE` Connect error code; Electron retries with backoff." For v0.3 Electron on loopback, retry-with-backoff is cheap. For v0.4 web client over CF Tunnel, `UNAVAILABLE` returned by the daemon during boot is NOT necessarily the right signal — cloudflared sees it as a backend issue and may fast-fail; CF Edge may serve a 502 to the web client. The Connect-RPC framing is the same; the operational interpretation diverges. The v0.3 design picks an error code; v0.4 inherits it across a tunnel that may rewrite/coerce it.
**Why P0**: UNACCEPTABLE pattern "Any v0.3 listener API that's not symmetric with what B will need". The accept-policy-during-boot is a Listener-trait-level concern.
**Suggested fix**: Lock the boot-state error code per-listener: Listener A returns `UNAVAILABLE`, Listener B returns `UNAVAILABLE` BUT with a structured `ErrorDetail` `code = "daemon.starting"` so cloudflared/CF Edge / web client can distinguish "transient boot" from "down". Add the structured detail to v0.3's `ErrorDetail` documentation in chapter 04 §2.

### P0.3 `shutdown` RPC on Supervisor UDS — admin-gated by peer-cred uid; semantics meaningless for v0.4 cf-access

**Location**: `02-process-topology.md` §4 ("`shutdown` RPC on Supervisor UDS")
**Issue**: "Used by installer uninstall, never by Electron UI." Admin-only via peer-cred uid check. In v0.4 a cf-access principal cannot reach Supervisor UDS at all (it's only on the local UDS, not on Listener B). That's correct — Supervisor stays local-admin-only forever. But the chapter doesn't say "Supervisor UDS is never exposed via Listener B in v0.4". A future contributor might think "let admins shut down via web UI" and add Supervisor's `shutdown` to Listener B — UNACCEPTABLE because it'd require shipping the JWT validator middleware on Supervisor too (reshape).
**Why P0**: UNACCEPTABLE pattern "Any v0.3 listener API that's not symmetric with what B will need" — *here, the asymmetry is correct and must be locked*.
**Suggested fix**: Add to chapter 15 §3 forbidden-patterns: "Supervisor UDS is local-only; v0.4 MUST NOT expose Supervisor endpoints (`/healthz`, `/hello`, `/shutdown`) via Listener B or any future remote listener. Equivalent functionality for remote callers MUST be exposed as new Connect RPCs on the data-plane listener with explicit principal authorization." Also re-state in this chapter §4.

## P1 findings (must-fix-before-merge; ambiguity / soft-rework risk)

### P1.1 macOS dedicated `_ccsm` user is author-extrapolated; brief only mandated "not SYSTEM" for Windows

**Location**: `02-process-topology.md` §2.2; flagged as author sub-decision in `15-zero-rework-audit.md` §4 item 6
**Issue**: Brief §7 says LocalService on win for least-privilege; author extrapolated to `_ccsm` on mac and `ccsm` on linux. Reasonable but adds installer complexity (user creation in postinst, ownership chain for state dirs). Not a v0.4 rework issue (v0.4 cf-access doesn't add OS users); flagged because the audit chapter asked.
**Why P1**: No zero-rework impact; documenting confirmation.
**Suggested fix**: Confirm the choice; document that v0.4 cf-access principals do NOT map to OS users (their "uid" is the JWT `sub`, not an OS account). Add to chapter 15 §3: "Daemon service account is per-OS one identity (`LocalService` win, `_ccsm` mac, `ccsm` linux); v0.4 cf-access principals MUST NOT be mapped to OS accounts."

### P1.2 Recovery policy on Windows ("first failure → restart 5s; second → 30s; subsequent → no command") loses crash-log fidelity after the third crash

**Location**: `02-process-topology.md` §2.1 (Recovery row)
**Issue**: After three rapid crashes, the service stops being auto-restarted. v0.3 user notices Electron disconnected, has to manually start the service. v0.4 web/iOS users have NO local UI to restart anything — daemon stays down until someone with local admin shows up. v0.4 inherits this stuck state.
**Why P1**: Operational gap; not zero-rework strictly but v0.4 reachability concern.
**Suggested fix**: After "no command" branch, set service to auto-restart on the next boot regardless. Or use Windows recovery's "Reset fail count after 1 day" knob (set `failureResetPeriod`). Lock the value in v0.3.

### P1.3 Process startup ordering says "re-spawn `claude` CLI subprocesses ... before binding Listener A" — but principal derivation depends on what?

**Location**: `02-process-topology.md` §3 steps 4-5
**Issue**: Step 4 re-spawns `claude` CLI for sessions marked `should-be-running`. At this moment Listener A is not bound yet (step 5). So the daemon spawns subprocesses with the recorded `owner_id` of each session — fine, the principal model is owner-id-recorded-in-row (chapter 05 §7). But: chapter 05 §3 says "`uid` MUST resolve or the request is rejected with `Unauthenticated`". On reboot, the recorded `uid` may not currently exist as an OS user (deleted between reboots). Daemon should detect and quarantine, not silently respawn `claude` under a now-orphan uid.
**Why P1**: Edge case; silent-data-corruption risk in v0.3, latent in v0.4.
**Suggested fix**: At step 4, validate every distinct `owner_id` resolves to a current OS account (for `local-user:*` only); orphans → mark sessions `CRASHED` and write `crash_log`; do not respawn `claude` for orphan owners. Lock in chapter 02 §3 step 4.
