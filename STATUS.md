# ccsm status

As of 2026-05-01. This file is a high-level pointer to where the project actually is. Prefer pointers over copied detail — STATUS files rot fast. For tabular implementation tracking of v0.1/v0.2 features see `docs/status/STATUS.md` (historical).

## Current release

**v0.2.0** — shipped 2026-04-30. https://github.com/Jiahui-Gu/ccsm/releases/tag/v0.2.0

Single-process Electron app. Embedded PTY via `node-pty`, claude-agent-sdk consumption, SQLite persistence, groups + drag-reorder, permission prompts as UI, command palette, auto-update via electron-updater. v0.1.0 (2026-04-27) was the first ship; v0.2.0 is the first dogfood-stable release.

See `README.md` for the user-facing feature list.

## In-flight: v0.3 daemon split (mostly landed)

As of 2026-05-01. Refactor only — splits the long-running side (PTY, SDK, persistence) into a standalone daemon process; Electron becomes a thin client over a same-machine same-user named pipe / Unix socket with HMAC handshake and a hand-rolled length-prefixed JSON envelope.

- **Design**: `docs/superpowers/specs/v0.3-design.md` (locked at r12, 7 review angles converged).
- **Implementation plan**: `docs/superpowers/plans/2026-04-30-v0.3-daemon-split.md`.
- **State**: daemon process, Connect server skeleton (#752), control + data sockets, ptySubscribe streaming RPC (#723), upgrade-shutdown call site (#720), and the e2e harness (#718) all merged. Migration probes (#713 #719 #738), reconnect probe (#739), modal coexistence probe (#740), L8 drop-slowest probe (#731), cross-user ACL probe (#721), and uninstall hygiene probe (#724) all green.
- **Open follow-up**: T05.1 follow-ups paused along with v0.4 implementation work (PR #755 closed 2026-05-01) — Connect server P1 polish (chain order, caps, rate-limit, pino, socket wiring) pending re-dispatch. Tracked under v0.4 because it lands on the v0.4 Connect surface, not the v0.3 envelope.
- **CI tolerance window** (per `feedback_migration_window_ci_tolerance`): some workflows currently disabled during the v0.4 M1 swap; re-enable trigger is M2 start.

## Next: v0.4 web client + Connect/Protobuf swap (M1 in flight)

As of 2026-05-01. Spec frozen at `docs/superpowers/specs/2026-05-01-v0.4-web-design.md` (consolidated 2026-05-01 stage-4 r2, R1-R6 all APPROVE). Predecessor design at `docs/superpowers/specs/2026-04-30-web-remote-design.md`.

Per user clarification 2026-05-01, v0.4 = "do the web client": (a) replace v0.3's hand-rolled envelope with Connect + Protobuf generated from a versioned `proto/` schema, (b) swap every preload bridge, (c) ship a Vite SPA web client deployed via Cloudflare Pages, fronted by Cloudflare Access (GitHub OAuth IdP), reaching the user's local daemon over Cloudflare Tunnel.

Milestones (chapter 09 release-slicing):

- **M1 — `proto/` locked + first bridge swapped end-to-end.** In flight. T01 proto skeleton (#746), T02 8-domain protos + 46-RPC inventory (#749), T03 `@ccsm/proto-gen` wrapper + tree-shake verification (#750), T04 pkg ESM-interop spike (#751, verdict: NO-GO direct, GO via `esbuild → CJS bundle → pkg`), T05 Connect server bound on daemon data socket (#752), T07 parity-test framework (#754), T31 schema-additive migration lint (#747), T32 fixture lint (#745). Remaining M1 tasks: T05.1 follow-ups (paused with v0.4 implementation), T06, T08.
- **M2 — all bridges swapped, envelope deleted from data socket.** Not started. Gated on M1 close + 7-day post-M2 dogfood (chapter 09 §7 / §1914).
- **M3 — web client functional (local-only, via dev TCP listener).** Not started.
- **M4 — Cloudflare wired, remote access live.** Not started. Pre-M4 spike: 7-day Cloudflare Tunnel bandwidth probe required before implementation begins (`docs/spikes/2026-05-cloudflare-tunnel-bandwidth.md`, not yet started).

Parallel track: **crash observability** (`docs/superpowers/specs/2026-05-01-crash-observability-design.md`, plan at `docs/superpowers/plans/2026-05-01-crash-observability.md`). Phase 1 recoverable artifacts (#736), phase 2 Sentry routing + DSN (#744), phase 3 symbol pipeline + native daemon segfaults (#748), phase 4 first-run consent + send-last-crash button (#753) all merged. Remaining: phase 5 retention + forwarder (in flight on `feat/crash-phase5-retention-and-forwarder`).

## Recent ship

- 2026-05-01 — v0.4 M1 batch + crash observability phases 1-4 + v0.4 web design lock (#743): T01-T03 proto + tooling, T04 pkg spike verdict, T05 Connect-on-data-socket, T07 parity framework, crash consent UI + Sentry routing + native daemon symbol pipeline.
- 2026-04-30 — **v0.2.0 release** tagged and published.
- 2026-04-30 — v0.3 daemon-split design locked at r12; daemon process, Connect skeleton, e2e harness, and migration probes land throughout 2026-05-01.
- 2026-04-27 — **v0.1.0 first ship**.

## Repo layout

No local main repo. All development happens in pre-installed worktrees under `~/ccsm-worktrees/pool-N` (plus topic-named worktrees for long-running branches). `origin` (`Jiahui-Gu/ccsm`) is the source of truth. Branch flow: feature → `working` → `main`; release tag `v*` triggers release CI. The companion notify package lives at `Jiahui-Gu/ccsm-notify` and is consumed via git+https tag pin in `optionalDependencies`.

## Where to look

- **Design specs**: `docs/superpowers/specs/`. Current locked specs: `2026-05-01-v0.4-web-design.md`, `v0.3-design.md`, `2026-05-01-crash-observability-design.md`; v0.2 baseline at `docs/mvp-design.md`.
- **Implementation plans**: `docs/superpowers/plans/`.
- **Roadmap pointer**: `docs/roadmap.md` (slice list, lighter than this file).
- **2026-04-30 architecture audits**: `docs/audit-2026-04-30-{architecture,code-rot,deps,docs,git,persistence,summary,test}.md`.
- **Dogfood notes**: `docs/dogfood/`.
- **Spikes**: `docs/spikes/` (e.g. `2026-05-pkg-esm-connect.md`).
- **Historical implementation status table** (v0.1/v0.2 features): `docs/status/STATUS.md`. Frozen at PR #18 era — not updated for v0.3/v0.4.
- **Design system**: `docs/design-system.md`.
