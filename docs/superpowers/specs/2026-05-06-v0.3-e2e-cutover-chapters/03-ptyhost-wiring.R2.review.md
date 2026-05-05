# Review of chapter 03: ptyHost wiring

Reviewer: R2 (security)
Round: 1

## Findings

### P1-1 (must-fix): spec must pin daemon HTTP listen address to 127.0.0.1 (not 0.0.0.0)

**Where**: chapter 03, §3 "Daemon-port readiness (HP-3)", Option C decision block (lines ~158-180) — and missing entirely from chapter 02 §1 "Surface catalog".

**Issue**: §3 talks about "the port" repeatedly and Option C mandates `await spawnDaemon()` before BrowserWindow, but **nowhere does the chapter state the daemon HTTP server MUST bind to `127.0.0.1` (loopback) and not `0.0.0.0` (all interfaces)**. Chapter 00 §4 lists wave-2 substrate including `badbf48d daemon http server skeleton` and the iron rule §3.6 says "no transport regression", which implies preserving loopback — but iron rule §3.6 is phrased as "no IPC reversion", not "no exposure widening". A fixer reading chapter 03 in isolation has no spec-level guard that prevents flipping the bind address to `0.0.0.0` "for easier debugging" or "for the v0.4 web frontend prep". If that ever happened, the daemon (which has zero auth — see iron rule §3.5 implicitly: three RPCs are unauthenticated) would expose `pty.write` (arbitrary terminal input → arbitrary shell exec) to anyone on the local network.

**Why this is P1** (not P0): the wave-2 substrate today binds 127.0.0.1 (verified in `daemon/http/*` per HP-11 KEEP). v0.3 PR set (chapter 05) does not touch the bind. So the **current code** is fine. But the spec is the contract for fixers and a P0 v0.4 web-frontend-design effort already in flight (`spec/2026-04-30-v0.4-web-frontend-design.md`). Without an explicit MUST in chapter 03, the v0.4 author/fixer might reasonably interpret "expose daemon to web" as "switch bind to 0.0.0.0" without realizing the current threat model assumes loopback. Pinning it now in chapter 03 §3 is one sentence and prevents a P0 in v0.4.

**Suggested fix**: in chapter 03 §3 "Required contract", add a MUST: "The daemon HTTP server MUST bind to `127.0.0.1` only. Binding to `0.0.0.0`, `::`, or any non-loopback interface is a P0 regression — the daemon has no authentication and `pty.write` (HP-9 §5.1 `input` RPC) gives arbitrary shell exec. Loopback binding is the **sole** trust boundary for the unauthenticated daemon API. v0.4 web-frontend exposure (if any) MUST land an auth/origin layer in the same PR that widens the bind." Cross-link from chapter 02 §1 surface-catalog footer.

### P2-1 (nice-to-have): pty-spawn child env should not inherit `CCSM_DAEMON_PORT`

**Where**: chapter 03, §3 Option C (lines ~158-180) and §5.1 `input` RPC implementation note (lines ~245-256).

**Issue**: With Option C `await spawnDaemon()` in main, the daemon child inherits main's env. The renderer learns the port via `window.ccsm.getDaemonPort()`. Separately, pty sessions spawn the `claude` binary as further children. Chapter doesn't specify whether the pty-spawn child receives an env containing the daemon port (e.g., `CCSM_DAEMON_PORT`). If it does, any process launched by the user inside the terminal (i.e., user's shell, scripts) can `curl http://127.0.0.1:<port>/api/pty/input?sid=...&data=...` and inject keystrokes into other live pty sessions. Since the user already has shell access in their own pty, this is mostly self-attack — but a malicious script run inside session A could hijack session B's input stream.

**Why this is P2**: weak attack (user-trusted child attacking user-trusted sibling); blast radius is local, single-user. v0.2 might already have this issue (loopback + no auth means port discoverability is the only barrier). The fix is cheap (whitelist env at spawn).

**Suggested fix**: in §5.1 `input` RPC, add a one-line MUST: "The pty-spawn child env MUST NOT include `CCSM_DAEMON_PORT` or any other variable that would let pty-child processes discover the daemon HTTP port. Daemon spawn (`daemon/ptyHost/lifecycle.ts` `spawn` impl) MUST construct an explicit env whitelist rather than passing `process.env` through." Verify in fixer's UT.

### P2-2 (nice-to-have): SSE subscriber sid validation not explicit

**Where**: chapter 03, §2 "SSE event delivery" guarantees G-1..G-4 (lines ~76-100).

**Issue**: §2 defines pty event delivery guarantees but doesn't say the SSE handler MUST validate that the requested `sid` belongs to the requesting subscriber. Today there's exactly one renderer (single-window Electron) so "subscriber identity" is moot — every subscriber is "the renderer". v0.4 multi-window or web frontend would need per-window sid scoping. v0.3 doesn't have to solve it but should not paint into a corner where the SSE multiplexer assumes "all subscribers see everything is fine."

**Why this is P2**: pre-existing, v0.4 concern.

**Suggested fix**: in §2 G-1 add a parenthetical: "(v0.3 single-renderer model: any caller of the SSE endpoint receives data for any sid — acceptable under loopback + single-renderer trust. v0.4 multi-window MUST add per-window sid ownership before this assumption breaks.)" Pure documentation; no code change.

## Cross-file findings (if any)

P1-1 (loopback-bind MUST) is cross-cutting with chapter 02 §1 surface-catalog (which lists `window.ccsm.getDaemonPort` as production) and chapter 05 §1 gate G9 ("no transport regression" — could be tightened to "no transport regression AND no exposure widening"). A single fixer (likely PR-3 owner since it touches `electron/main.ts` daemon-spawn path) should add the MUST to chapter 03 §3, the cross-link to chapter 02 §1, and tighten G9 wording in chapter 05 §1, in one commit.
