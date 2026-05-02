# 13 — Release Slicing

v0.3 is shipped as a sequence of merges into the working branch with explicit ordering: foundation → wire → daemon internals → cutover → installer → ship-gate verification. This chapter pins the phase ordering, the merge-precedence rules, the P0 milestones each tied to a brief §11 ship-gate, and the seed for the stage-6 task DAG extraction.

### 1. Phases (high-level ordering)

```
Phase 0    — Repo + tooling foundation
Phase 0.5  — Transport spikes (resolves all MUST-SPIKE items in [03])
Phase 1    — Proto + codegen
Phase 2    — Daemon skeleton + Listener A + Supervisor UDS
Phase 3    — SQLite + migrations + principal model
Phase 4    — Session manager + claude CLI subprocess control
Phase 4.5  — PTY worker spike [child-process-pty-throughput] (F3 picked child_process; this confirms throughput envelope)
Phase 5    — PTY host (xterm-headless + node-pty + snapshot/delta)
Phase 6    — Crash collector
Phase 7    — Settings service
Phase 8a   — Electron: proto-client wiring + transport bridge + descriptor reader (no behavior change; coexists with IPC)
Phase 8b   — Electron: big-bang IPC removal cutover (the cutover PR; behind feature flag per F6 ch 08 rollback story)
Phase 8c   — Electron: cleanup pass (delete dead files; flip feature flag default; wire CI `lint:no-ipc` gate)
Phase 9    — Per-OS service registration + Supervisor lifecycle
Phase 9.5  — Build/notarization spikes ([sea-on-22-three-os], [macos-notarization-sea], [msi-tooling-pick])
Phase 10   — Per-OS installer + signing/notarization
Phase 11   — Ship-gate verification harnesses (a)/(b)/(c)/(d)
Phase 12   — Soak + dogfood + ship
```

Spike phases (0.5, 4.5, 9.5) are explicit pre-phase gates. A spike's failure is a chapter-edit (fallback design lands in the relevant chapter) — NOT a downstream phase redo. Implementation phases assume spike outcomes are frozen.

Phases are NOT serial — they have explicit dependencies that allow parallelism (see §3). A phase is "done" when every PR in it is merged AND all its acceptance criteria are green.

### 2. Phase contents and acceptance criteria

#### Phase 0 — Foundation
- Set up monorepo layout per [11](./11-monorepo-layout.md) §2.
- pnpm + Turborepo wired; CI install + cache works.
- `tsconfig.base.json`, ESLint, Prettier, Changesets configured.
- ESLint `no-restricted-imports` enforces inter-package boundaries.
- **Done when**: `pnpm install && pnpm run build && pnpm run lint && pnpm run test` runs in CI in < 10 min on a clean cache; **≥ 80% Turborepo cache hit rate on a no-op rebuild** (measured via `turbo run build --dry=json` task summary; `cached / total >= 0.8`).

#### Phase 0.5 — Transport spikes
- Resolve every MUST-SPIKE item in [03](./03-listeners-and-transport.md) §1 and [14](./14-risks-and-spikes.md) (transport-related).
- Output: per-OS transport decision matrix appended to chapter 03 §1.
- **Done when**: spike harnesses under `tools/spike-harness/transport/` green on all 3 OSes; chapter 03 §1 decision matrix committed.

#### Phase 1 — Proto
- `.proto` files per [04](./04-proto-and-rpc-surface.md).
- `buf.gen.yaml` produces TS code consumed by daemon and electron stubs.
- Lock file: `packages/proto/lock.json` with SHA256 per `.proto` file (committed; CI rejects any `.proto` mutation that does not bump the matching SHA — see [11](./11-monorepo-layout.md) §6).
- `buf lint` clean; `buf breaking` job is **active from this phase forward** (NOT deferred until v0.3 tag); pre-tag the comparison target is the PR's merge-base SHA on the working branch, post-tag it switches to the v0.3 release tag.
- **Done when**: `pnpm --filter @ccsm/proto run gen && pnpm --filter @ccsm/proto run lint && pnpm --filter @ccsm/proto run lock-check && pnpm --filter @ccsm/proto run breaking` green in CI on all OSes.

#### Phase 2 — Daemon skeleton + Listener A + Supervisor
- Daemon binary boots (no sessions); writes `listener-a.json`; binds Listener A; Supervisor `/healthz` returns 200.
- `Hello` RPC works end-to-end via Connect over Listener A.
- Listener trait + 2-slot array; `makeListenerB` throws.
- Peer-cred middleware on Listener A produces `local-user` principal.
- All MUST-SPIKE items in [03](./03-listeners-and-transport.md) resolved **in phase 0.5**; phase 2 consumes the per-OS transport decision matrix as a frozen input.
- **Done when**: integration test `connect-roundtrip` Hello-only variant green on all OSes.
- **P0 milestone**: this phase unblocks every other daemon-side phase.

#### Phase 3 — SQLite + migrations + principal model
- `001_initial.sql` applied on boot; `principals`, `sessions`, `pty_*`, `crash_log`, `settings`, `cwd_state` tables exist.
- `principalKey` + `assertOwnership` implemented and unit-tested.
- Write coalescer for deltas implemented.
- **Done when**: unit + integration tests for `db/*` and `principal/*` green.

#### Phase 4 — Session manager + claude CLI
- `SessionService.{Create,List,Get,Destroy,WatchSessions}` implemented.
- `claude` CLI subprocess spawn/supervise; respawn on daemon boot per §7 of [05](./05-session-and-principal.md).
- **Done when**: integration `connect-roundtrip` full variant green.

#### Phase 4.5 — PTY worker spike
- Resolve `[child-process-pty-throughput]` from [14](./14-risks-and-spikes.md) (F3 picked `child_process` over `worker_threads`; this phase confirms the throughput envelope holds for `node-pty` driving `xterm-headless` under realistic input bursts).
- Output: pinned per-OS throughput baseline (bytes/sec) appended to chapter 06 §4.
- **Done when**: spike harness `tools/spike-harness/pty-throughput/` green on all 3 OSes; chapter 06 §4 baseline committed.

#### Phase 5 — PTY host
- `worker_threads` per session; node-pty + xterm-headless wired.
- `PtyService.{Attach,SendInput,Resize}` implemented.
- Snapshot encoder per [06](./06-pty-snapshot-delta.md) §2; delta segmenter per §3; cadence per §4; reconnect tree per §5.
- All MUST-SPIKE items in [06](./06-pty-snapshot-delta.md) resolved **in phase 4.5**; phase 5 consumes the throughput baseline as a frozen input.
- **Done when**: `pty-attach-stream` + `pty-reattach` + `pty-too-far-behind` integration tests green AND a **10-minute soak smoke** (`pty-soak-10m.spec.ts`, scaled-down variant of ship-gate (c)) green on all 3 OSes. The full 1-hour soak ship-gate (c) runs in phase 11.
- **P0 milestone**: phase 5 + phase 11 ship-gate (c) is the dogfood quality bar.

#### Phase 6 — Crash collector
- All capture sources from [09](./09-crash-collector.md) §1 wired.
- `CrashService.{GetCrashLog,WatchCrashLog}` implemented.
- `crash-raw.ndjson` recovery on boot.
- **Done when**: `crash-stream` integration test green.

#### Phase 7 — Settings service
- `SettingsService.{GetSettings,UpdateSettings}` implemented.
- Retention enforcer wired (consumes `Settings.crash_retention`).
- **Done when**: `settings-roundtrip` integration test green.

#### Phase 8 — Electron migration (split into 8a / 8b / 8c)

The phase 8 cutover is split into three stacked PRs to keep each PR reviewable. The "big-bang" rule from chapter 08 §1 applies to **the shipped app** (no coexisting IPC + Connect code paths in v0.3 release): 8a's parallel paths are pre-cutover scaffolding, fully removed by 8c. Coordinate with [08](./08-electron-client-migration.md) F6 feature-flag rollback story — 8b ships the new path behind `CCSM_USE_CONNECT=1` (default off); 8c flips the default and removes the flag.

##### Phase 8a — Proto-client wiring + transport bridge + descriptor reader
- Add generated Connect clients (consumed from `@ccsm/proto`, produced in phase 1).
- Add transport bridge module (renderer ↔ main descriptor passing per [08](./08-electron-client-migration.md) §5 sub-steps a-d).
- Add descriptor reader on renderer side.
- **No behavior change**: existing IPC paths remain wired; new Connect paths exist but are gated by `CCSM_USE_CONNECT` (default off).
- **Done when**: existing Electron smoke tests still green (no regression); new `transport-bridge.spec.ts` unit test green.
- LOC budget: < 1500 (additive).

##### Phase 8b — Big-bang IPC removal cutover
- Replace each `ipcMain.handle` / `ipcRenderer.invoke` call site with the corresponding Connect client call (chapter 08 §5 sub-steps e-h).
- All Electron components ported to React Query + generated Connect clients.
- Feature flag `CCSM_USE_CONNECT` selects between old IPC path and new Connect path (default still off; flag enables the new code).
- **Done when**: full Electron app smoke-launch on each OS with `CCSM_USE_CONNECT=1` shows full UX functional; smoke-launch with flag off (legacy IPC path) still works (rollback proven).
- LOC budget: explicitly unbounded (this is the cutover); requires ≥ 2 reviewers + author sign-off.

##### Phase 8c — Cleanup + lint gate
- Flip `CCSM_USE_CONNECT` default to on; delete the legacy IPC code paths and the flag itself.
- Delete dead files (chapter 08 §5 sub-step i).
- Wire CI `lint:no-ipc` gate (ESLint + grep per [12](./12-testing-strategy.md) §4.1).
- **Done when**: ship-gate (a) `lint:no-ipc` green AND smoke-launch on each OS shows full UX functional with no `ipcMain.handle` / `contextBridge` calls in the codebase.
- LOC budget: < 1000 (mostly deletions).
- **P0 milestone**: ship-gate (a). M2 fires when 8c lands.

#### Phase 9.5 — Build/notarization spikes
- Resolve `[sea-on-22-three-os]`, `[macos-notarization-sea]`, `[msi-tooling-pick]` from [14](./14-risks-and-spikes.md).
- Output: per-OS build/sign/notarize recipe appended to chapter 10 §5.
- **Done when**: spike harnesses under `tools/spike-harness/build/` green on all 3 OSes; chapter 10 §5 recipes committed.

#### Phase 9 — OS service registration glue
- Daemon entrypoint detects "running as service" vs "running as cli" (env var or argv flag).
- Service-mode emits `READY=1` (linux), starts `WATCHDOG=1` keepalive (linux), respects platform stop signals.
- **Done when**: a manual `sc create` (win) / `launchctl bootstrap` (mac) / `systemctl start` (linux) end-to-end works locally.

#### Phase 10 — Installer
- WiX MSI / pkg / deb + rpm builds per [10](./10-build-package-installer.md) §5.
- Code signing + notarization in CI (uses encrypted secrets).
- **Done when**: `package` CI job green on all 3 OSes; install + uninstall manual smoke clean.
- Depends on: phase 9 (service glue) AND phase 0 (CI matrix).

#### Phase 11 — Ship-gate verification harnesses
- (a) `lint:no-ipc`: implemented in phase 8c; here we just ensure it stays green.
- (b) `sigkill-reattach.spec.ts` per [12](./12-testing-strategy.md) §4.2.
- (c) `pty-soak-1h` per [12](./12-testing-strategy.md) §4.3.
- (d) `installer-roundtrip.ps1` per [12](./12-testing-strategy.md) §4.4.
- **Procedure for "all four green on the same commit"**: gates (c) and (d) are nightly / scheduled, not per-PR. Tagging a release candidate uses `tools/release-candidate.sh <SHA>` which: (1) verifies (a)+(b) already green on the SHA via `gh run list --commit=<SHA>`; (2) dispatches `workflow_dispatch` runs for soak (c) and installer (d) pinned to `<SHA>`; (3) polls until both finish; (4) emits a summary report and, if all four green, prints the suggested `git tag` command. No tag is applied automatically.
- **Done when**: all four green on the candidate release tag, witnessed by `tools/release-candidate.sh` report.

#### Phase 12 — Soak + dogfood + ship
- Engineer eats own dogfood for ≥ 1 week of real `claude` CLI usage.
- Daily crash log review; bug fixes flow as additive PRs (NO architectural changes — those are zero-rework violations and bounce back to spec).
- **"No architectural regression PRs" measurement**: in the 7-day window, a PR is an "architectural regression" iff it carries the `architecture-regression` GitHub label OR it modifies any file under the v0.3 forever-stable list (chapter 15 §3 forbidden-patterns: `packages/proto/**/*.proto` semantic edits, `packages/daemon/src/listener/**`, `packages/daemon/src/principal/**`, `packages/daemon/src/db/migrations/001_initial.sql`). The `tools/dogfood-window-check.sh <since-SHA>` script greps merged PRs in the window via `gh pr list --state=merged --search="merged:>=<date>"`, asserts label absence, and asserts no diff touches the forbidden file list. Any hit fails phase 12.
- Ship.

### 3. Dependency DAG (seed for stage 6)

Edges = "must merge before". Most phases parallelize after phase 2.

```
0 ──► 0.5 ──► 1 ──┬──► 2 ──► 3 ──► 4 ──► 4.5 ──► 5
                  │                                │
                  │                                ├──► 6 (uses crash hooks from session manager)
                  │                                └──► 7
                  │
                  │                  2 ──► 9 ──► 9.5 ──► 10
                  │
                  └──► 8a ──► 8b ──► 8c
                       (8a needs 1 for proto stubs; can start in parallel
                        with 4-7. 8b cannot merge until 4,5,6,7 are merged
                        on the daemon side; 8c stacks on 8b.)

{4, 5, 8c} ──► 11(b)
5            ──► 11(c)
8c           ──► 11(a)
10           ──► 11(d)
9            ──► 11(b) (service-installed nightly variant)
11(a,b,c,d)  ──► 12
```

Specifically:
- Phase 0.5 (transport spikes) gates phase 1 codegen choices and phase 2 listener wiring.
- Phase 1 unblocks phase 2 (server stubs) and phase 8a (client stubs) simultaneously.
- Phase 2 unblocks phase 3 (DB depends on daemon process boot) AND phase 9 (service registration does not need internals 3-8).
- Phase 3 unblocks phases 4 and 6 and 7.
- Phase 4 unblocks phase 4.5 (PTY spike needs the session subprocess shape).
- Phase 4.5 unblocks phase 5.
- **Daemon-side merge ordering** (P0): phase 4 → 5 → 6 → 7 land **sequentially** in the working branch (each builds on the previous; sequential ordering avoids rebase churn for phase 8b).
- **Phase 8 stacking** (P0): 8a may start in parallel with 4-7 (additive only); 8b must rebase on a working branch that contains merged 4, 5, 6, 7; 8c stacks on 8b. Phase 8 is **the last** big block to land before phase 11.
- Phase 9.5 (build/notarization spikes) gates phase 10.
- Phase 10 (installer) needs phase 9 (service registration glue) but does NOT need internals (4-8); the installer just installs whatever `ccsm-daemon` binary is built.
- **Phase 11(b) deps** (P0 pin): 11(b) depends on phases **4, 5, 8c, 9** — Electron present (8c, post-cutover) + daemon process (4) + PTY for "reattach" (5) + service registration for service-installed nightly variant (9). NOT 6 or 7.
- Phase 11(a) ← 8c. Phase 11(c) ← 5. Phase 11(d) ← 10.

### 4. Branching and merge discipline

- Trunk-based: all PRs into the working branch (`spec/2026-05-03-v03-daemon-split` for spec; for impl, the v0.3 release branch named separately by stage 6).
- Each phase opens with a parent tracking issue; child PRs reference it.
- Each PR: one phase OR one self-contained chunk inside a phase.
- Phase 8b (big-bang IPC removal cutover) is the only large PR by design (LOC budget unbounded; ≥ 2 reviewers + author sign-off required); 8a and 8c follow the < 600 LOC target. Everything else is < 600 LOC diff target.
- All PRs require: green CI on all OSes; one human review; no `--no-verify`.

### 5. P0 milestones (gate the v0.3 ship)

In the order they fall:

1. **M0 (Phase 2 done)**: daemon talks to a Connect client over Listener A. Unblocks all parallel work.
2. **M1 (Phase 5 done)**: PTY attach/reattach works in integration tests. Unblocks dogfood feasibility check.
3. **M2 (Phase 8c merged)**: ship-gate (a) green; Electron is no longer touching `ipcMain`; legacy IPC code paths and `CCSM_USE_CONNECT` flag deleted. Unblocks phase 11(b) running against a real Electron.
4. **M3 (Phase 10 done)**: installable on all 3 OSes. Unblocks phase 11(d) and engineer dogfood at scale.
5. **M4 (all of Phase 11 green)**: ship-gate (a)+(b)+(c)+(d) all green on the same commit. Tag candidate.
6. **M5 (Phase 12)**: ≥ 7 days of dogfood with no architectural regression PRs (measured per phase 12 done-criteria via `tools/dogfood-window-check.sh`). Tag v0.3 release.

### 6. v0.4 delta

- **Add** v0.4 phases stacked on top: Listener B + JWT, cloudflared lifecycle, web package, iOS package, web/iOS ship-gates.
- **Unchanged**: every v0.3 phase's outputs, the v0.3 ship-gate harnesses (still gate v0.4 ship), trunk-based branching discipline, the merge-precedence rules.
