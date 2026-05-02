# 01 — Goals and non-goals

> Authority: [final-architecture §2](../2026-05-02-final-architecture.md#2-locked-principles), [§3](../2026-05-02-final-architecture.md#3-what-this-doc-does-not-decide).

## Goals (MUST ship in v0.3)

G1. **Single binary `ccsm-daemon`** distributed for darwin-arm64, darwin-x64, linux-x64, linux-arm64, win-x64, win-arm64. **Why:** final-architecture §2.1 ("backend = single binary, runs on the user's local machine ONLY").

G2. **Two loopback listeners physically bound at daemon start.** Listener A (UDS / named pipe, peer-cred trusted) and Listener B (`127.0.0.1:PORT_TUNNEL`, CF Access JWT validated). **Why:** §2.3 ("listeners are physically separate; the JWT bypass is keyed on the listener (transport identity), never on a request header"). Binding Listener B from day 1 — even with no consumer — is required to forbid retrofitting a header-keyed bypass later.

G3. **Connect-RPC over HTTP/2 as the entire data plane**, generated from `proto/`. The `proto/` schema MUST already declare every service v0.4 will need (sessions, pty, db, presence stub, control). **Why:** §2.8 ("data plane … moves to Connect-RPC over HTTP/2 on Listener A and Listener B. Generated from `proto/`"). v0.3 generates code from the v0.4-complete schema; v0.4 only adds method bodies / wires more clients. No proto rewrite at v0.4.

G4. **Supervisor control plane retained on UDS with the v0.3 envelope**, restricted to `/healthz`, `daemon.hello`, `daemon.shutdown*` and lifecycle. **Hello-HMAC removed.** **Why:** §2.8 ("supervisor control plane … stays on the local UDS with the v0.3 hand-rolled envelope. Unchanged"); HMAC removal is the v0.3 reconciliation — peer-cred replaces it; carrying HMAC into v0.3 produces dead code that v0.4 must delete (rework).

G5. **Daemon owns its own lifecycle.** It is **not** an Electron child process. Closing the desktop client does not stop the daemon; killing the daemon does not affect already-running PTY processes' `claude` subprocess until daemon respawn reattaches. **Why:** §2.9 ("daemon is not a child of any client").

G6. **Backend-authoritative session model**, with snapshot+delta catch-up, broadcast-all + LWW writes, **PTY fan-out registry sized for N ≥ 3 subscribers from day 1**. **Why:** §2.7. Sizing for N=1 and "scaling later" is forbidden — that is rework at v0.4.

G7. **Electron desktop client is a pure thin client** speaking Connect over Listener A. No business logic in renderer. No business logic in main beyond OS chrome, file dialogs, deep links, and a Connect client constructor pointed at the UDS. **Why:** §2.4 ("desktop on the same machine → Listener A"); §2.7 ("backend-authoritative; clients are pure subscribers").

G8. **Crash collector and structured logs in-daemon.** **Why:** §1 diagram ("crash collector" listed inside daemon).

G9. **SQLite lives in-daemon** behind a Connect `db.*` service. Electron does not open SQLite directly. **Why:** §1 diagram (SQLite inside daemon box); §2.1 (backend is the source of truth).

G10. **Dogfood smoke gate (4 metrics)** must pass before tagging v0.3:
   1. Cold start (Electron launch → first PTY byte) under target.
   2. PTY echo round-trip latency under target.
   3. Daemon survives Electron renderer kill + main kill (re-launch reattaches existing session).
   4. SQLite write throughput under target with three concurrent Connect clients.
   Targets are calibrated against v0.2 baseline; numbers live in [15-testing-strategy](./15-testing-strategy.md).

## Non-goals (MUST NOT ship in v0.3)

NG1. **No `cloudflared` sidecar** — neither bundled nor lifecycled. Listener B is bound but has no intended consumer in v0.3. **Why deferred:** final-architecture §3 ("`cloudflared` install / supply-chain / update flow"); v0.4.

NG2. **No web client.** No `@connectrpc/connect-web` build target. **Why deferred:** §3 ("v0.4 client UX spec — … web SPA shape"); v0.4.

NG3. **No iOS client.** No `connect-swift` consumption. **Why deferred:** same as NG2.

NG4. **No OS-level supervisor.** v0.3 does not install launchd plists, Windows Services, or systemd-user units. The daemon is started by the Electron launcher (and continues running after Electron exits via OS process detach), or manually by the dev. **Why deferred:** §3 ("OS-level supervisor for headless mode … and the daemon-detach-from-Electron lifecycle"); v0.4.

NG5. **No scrollback persistence to SQLite.** PTY scrollback remains the existing in-RAM ring buffer. **Why deferred:** §2.7 ("scrollback: RAM-only … long-tail history persistence is a separate, later feature").

NG6. **No multi-machine semantics.** **Why deferred:** §3.

NG7. **No backend-issued tokens, no user database.** **Why:** §2.5 ("backend never issues its own tokens. Backend never stores a user database"). This is a hard non-goal, not a "later".

NG8. **No supervisor envelope on the data plane.** No HMAC-protected hello on the control plane. **Why:** §2.8 plus reconciliation: data plane is Connect; control plane is the bare-minimum envelope; HMAC was a v0.2 artifact whose threat (lateral-process spoofing on UDS) is now covered by peer-cred.

## Anti-patterns (any of these in any chapter = P0 reject)

The reviewer in Stage 2 must reject the spec set if **any** chapter, code path, or comment includes:

- "Send data plane over the supervisor envelope first; switch to Connect in v0.4."
- "Bind Listener B in v0.4 once the sidecar is ready."
- "Fan-out registry only needs N=1 for v0.3; resize at v0.4."
- "Electron keeps {session manager / PTY / SQLite client} for v0.3; move into daemon at v0.4."
- "Keep hello-HMAC for compatibility / one release / belt-and-suspenders."
- Any inline marker of the form `TODO(v0.4)`, `FIXME: v0.4`, `// v0.4 will …`.
- Any header-keyed JWT bypass on Listener B (e.g. `if req.header('X-Local') === '1' skipJwt()`).
- Any "OS supervisor stub" file created with empty bodies — either ship it or omit it.

The pattern is the same in each: the line **predicts** that v0.4 will edit/delete v0.3 code. That is the definition of rework.

## §1.Z Zero-rework self-check

**v0.4 时本章哪些决策/代码会被修改?** 无。Goals G1..G10 是 final-architecture §2 原则的直接投影, v0.4 同样满足这些原则 (引 §2.1, §2.3, §2.5, §2.7, §2.8, §2.9), 不会撤销。Non-goals NG1..NG6 在 v0.4 变成 goals — 这是**追加** v0.4 spec, 不是修改 v0.3 chapter。NG7 (no backend tokens) / NG8 (no envelope on data plane / no HMAC on hello) 是永久 non-goals, v0.4 也不做 (引 §2.5, §2.8)。

## Cross-refs

- [00-overview](./00-overview.md)
- [02-process-topology](./02-process-topology.md) — operationalizes G5.
- [04-listener-B-jwt](./04-listener-B-jwt.md) — operationalizes G2 + NG1.
- [14-deletion-list](./14-deletion-list.md) — files whose presence implies an anti-pattern.
