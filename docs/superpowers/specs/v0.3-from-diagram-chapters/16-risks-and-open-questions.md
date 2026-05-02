# 16 — Risks + open questions

## Scope

Two lists:

1. **Risks** that v0.3 ships with — known, scoped, accepted, with mitigation. Reviewers MUST sanity-check that "accepted" is the right call.
2. **Open questions** — decisions this spec did NOT make and which the implementer / reviewer / Stage 2 must answer before code lands. Each is a candidate for AskUserQuestion or a sub-spec.

## Risks v0.3 ships with

### R1 — Listener B has no live client; bugs may go unnoticed until v0.4

**Risk:** the JWT interceptor + bind path are exhaustively unit-tested but not exercised by an actual external caller in v0.3. A bug in TLS-termination assumptions, HTTP/2 framing under cloudflared specifically, or JWKS pinning could ship to v0.4 users.

**Mitigation:** UT matrix (chapter 04) covers all 17 documented failure modes. v0.4 spec (per `../2026-05-02-final-architecture.md` §4) explicitly calls for an integration test against a real cloudflared-against-fake-Access setup; that's the first time live-end-to-end happens. v0.3 ships honestly: "Listener B is bound and will accept JWT-validated traffic; nothing in v0.3 sends it any."

**Accepted because:** the alternative is leaving Listener B out, which is exactly the rework v0.3 forbids.

### R2 — `daemon.SetRemoteEnabled` in proto returns `Unimplemented`; clients calling it from v0.4 stubs against a v0.3 daemon get a clear error

**Risk:** a future v0.4 client built against v0.3 daemon will get `Unimplemented` on `SetRemoteEnabled` rather than a useful "v0.3 daemon, upgrade required" message.

**Mitigation:** v0.4 client SHOULD probe `daemon.Info` first (returns version) and surface a "your local daemon needs to be updated" UI. This is a v0.4 client concern, not a v0.3 daemon concern.

**Accepted because:** `Unimplemented` IS the standard Connect-RPC signal; clients consuming the schema can detect it.

### R3 — In-RAM scrollback lost on daemon restart

**Risk:** if daemon crashes or shuts down for upgrade, all session scrollback is gone. Sessions metadata remains in DB; PTY children are killed by JobObject / PR_SET_PDEATHSIG; on next daemon boot, those sessions appear in the list as `closed`.

**Mitigation:** `daemon.shutdownForUpgrade` triggers a coordinated path; user sees "upgrading…" UI. For unexpected crashes, this is a v0.5 problem (scrollback persistence, see chapter 08 §"Persistence boundary").

**Accepted because:** v0.5 deferred per principle non-goal in chapter 01; current v0.2 has the same characteristic.

### R4 — No OS-level supervisor in v0.3

**Risk:** if daemon crashes while Electron is closed, no service restarts it until user reopens Electron. Web/iOS users (don't exist in v0.3) would be unreachable.

**Mitigation:** v0.3 has no web/iOS users; this risk is inert until v0.4. v0.4 ships the OS supervisor + cloudflared together.

**Accepted because:** matches the deferred non-goal; daemon is OS-supervisor-ready (G4) so adding the supervisor in v0.4 is purely additive.

### R5 — `pkg` (or whatever single-binary tool is chosen) Node 22 ABI compatibility with native modules

**Risk:** packaging Node 22 + node-pty + better-sqlite3 + ccsm_native into a single binary has been verified for v0.3-old envelope build; the Connect-Node addition must be re-verified.

**Mitigation:** packaging spike must run in Stage 2 / early implementation as a dedicated task. Failing fast here is critical.

**Accepted because:** existing v0.3 packaging work (#45 KEEP) already proved single-binary feasibility; adding Connect-Node (pure JS, no native deps) is low-risk.

### R6 — Connect-Node HTTP/2 over UDS support breadth

**Risk:** `@connectrpc/connect-node` may not officially document HTTP/2-over-UDS. If the library's transport assumes TCP, we may need a custom transport.

**Mitigation:** Node's `http2.createServer` accepts a UNIX socket path via `server.listen(path)`. Connect-Node consumes a Node `Server`; it should be transport-agnostic. If it isn't, fallback is a thin custom transport wrapping h2 frames. Stage 2 packaging spike covers this.

**Accepted because:** Node's HTTP/2 stack natively supports UDS; the risk is purely library-layer wiring.

## Open questions

These are decisions this spec deliberately leaves to Stage 2 reviewers / implementers / sub-specs. None blocks v0.3 design approval; all block implementation start.

### Q1 — `better-sqlite3` vs `sqlite3` library choice

The two options have different trade-offs:

- `better-sqlite3`: synchronous API (simpler), excellent perf, mature Win prebuild support.
- `sqlite3`: async API (consistent with Node idioms), older but battle-tested.

This spec defers the choice. Recommendation: **better-sqlite3** unless the implementer hits a concrete blocker (sync I/O concerns under load are unlikely at v0.3 scale).

### Q2 — Single-binary packager: `pkg` vs `node-sea` vs `nexe`

`pkg` is the v0.3-old choice. Node 22 SEA (single executable apps) is officially supported now and may be preferred for long-term maintenance. This spec defers but flags: SEA + native deps integration is less mature than pkg's; pick conservatively for v0.3 ship and revisit in v0.4.

### Q3 — `cwdHash` algorithm details (collision resilience)

Chapter 03 specifies `sha256(canonicalRepoRoot).slice(0, 8)`. 8 hex chars = 32 bits = ~birthday collision at 65k checkouts. For dev machines with O(10) worktrees this is fine; for any pathological case (CI with hundreds of fresh worktrees per day on the same host) it could collide. Open: should we extend to 12 hex chars (~48 bits) for safety margin?

### Q4 — Windows named pipe path length limits

Chapter 03 names pipes `\\.\pipe\ccsm-data-<cwdHash>-<uidHash>`. Total length under 256 chars per Windows pipe naming. Confirm the constants chosen (8-char hash each + prefix) don't exceed.

### Q5 — JWKS team URL configuration UX in v0.3

Listener B's JWT interceptor needs a team URL + AUD. v0.3 has no UI for this (no remote enabled). Ship with empty defaults (interceptor rejects all), or expose a hidden config file in `<dataRoot>/config.json`?

This spec opts for "empty defaults; reject all". Q for reviewers: is there value in shipping a config-file path (read-only for v0.3) so users can pre-stage config before v0.4?

### Q6 — Snapshot serialization format

Chapter 08 says PtySnapshot includes "the visible screen with attributes + scrollback + cursor + mode flags" but does not specify wire encoding. Options: dump xterm-headless internal state (couples to xterm-headless version), or a portable terminal-state schema.

**Recommended:** lean on xterm-headless's serialize-into-bytes API (or a tight wrapper) for v0.3; if v0.4 web client uses a different terminal renderer, abstract then. Defer detailed encoding to implementation; reviewers should challenge this if they have stronger opinions.

### Q7 — Connect-Node version pin

What version of `@connectrpc/connect-node` + `@connectrpc/connect`? Pin in `package.json` to a specific minor at v0.3 ship time; defer the exact pin to dependency-update PR.

### Q8 — Daemon binary CLI surface

Chapter 10 mentions `--data-root`. What other flags? `--version`, `--help`, `--log-level`, `--inspect`? Spec defers; recommend minimal set: `--version`, `--data-root`, `--log-level`, `--help`.

### Q9 — Single-binary inclusion of claude-agent-sdk

The v0.3-old design has dual-staging for claude-agent-sdk (Electron CJS + daemon ESM). Once PTY moves fully to daemon, only daemon needs the SDK. Confirm the Electron-side staging can be removed (and chapter 13 packaging notes need updating to single-staging).

### Q10 — How "remote-ready" gate interacts with v0.4

Chapter 04 mentions a `bind-gate` for JWKS pre-warm. v0.3 has no consumer. v0.4 cloudflared sidecar spawn flow consumes it. Confirm the v0.4 spec inherits this contract verbatim — or, if Stage 2 reviewers see a cleaner shape, flag.

### Q11 — Test isolation when running Listener B JWT IT in CI

Fake JWKS server runs on localhost; multiple parallel IT processes need port isolation. Use port 0 + per-process URL injection. This is implementation detail but worth flagging.

### Q12 — Spec coverage of notification fan-out

Chapter 12 mentions "notification fan-out moves to daemon" but no chapter specifies where/how. The existing `electron/notify/bootstrap/` has business logic that classifies events. Open: should notification fan-out be its own daemon module + Connect service (`ccsm.v1.NotificationsService`?), or just an internal daemon hook with the OS-display side living in Electron?

**Suggested for Stage 2:** if the existing notify code is non-trivial, propose a `NotificationsService` in `proto/` (additive — no breaking change) so web/iOS in v0.4 get notifications too. Otherwise just hook session events. Reviewer call.

## What this chapter does NOT decide

- Sub-spec ownership (which OS-supervisor, JWT detail spec, etc.) — see `../2026-05-02-final-architecture.md` §4.
- Resourcing / scheduling — Stage 6 DAG concern.
- Stage 2 reviewer angles — Stage 2 protocol concern.

## Cross-refs

- [00 — Overview](./00-overview.md)
- [01 — Goals + non-goals](./01-goals-and-non-goals.md)
- All chapters; this is the open-questions backstop.
