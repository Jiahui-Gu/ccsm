# 13 — Release Slicing

v0.3 is shipped as a sequence of merges into the working branch with explicit ordering: foundation → wire → daemon internals → cutover → installer → ship-gate verification. This chapter pins the phase ordering, the merge-precedence rules, the P0 milestones each tied to a brief §11 ship-gate, and the seed for the stage-6 task DAG extraction.

### 1. Phases (high-level ordering)

```
Phase 0  — Repo + tooling foundation
Phase 1  — Proto + codegen
Phase 2  — Daemon skeleton + Listener A + Supervisor UDS
Phase 3  — SQLite + migrations + principal model
Phase 4  — Session manager + claude CLI subprocess control
Phase 5  — PTY host (xterm-headless + node-pty + snapshot/delta)
Phase 6  — Crash collector
Phase 7  — Settings service
Phase 8  — Electron migration (big-bang cutover PR)
Phase 9  — Per-OS service registration + Supervisor lifecycle
Phase 10 — Per-OS installer + signing/notarization
Phase 11 — Ship-gate verification harnesses (a)/(b)/(c)/(d)
Phase 12 — Soak + dogfood + ship
```

Phases are NOT serial — they have explicit dependencies that allow parallelism (see §3). A phase is "done" when every PR in it is merged AND all its acceptance criteria are green.

### 2. Phase contents and acceptance criteria

#### Phase 0 — Foundation
- Set up monorepo layout per [11](./11-monorepo-layout.md) §2.
- pnpm + Turborepo wired; CI install + cache works.
- `tsconfig.base.json`, ESLint, Prettier, Changesets configured.
- ESLint `no-restricted-imports` enforces inter-package boundaries.
- **Done when**: `pnpm install && pnpm run build && pnpm run lint && pnpm run test` runs in CI in < 10 min on a clean cache; > 0% in cached re-run.

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
- All MUST-SPIKE items in [03](./03-listeners-and-transport.md) resolved (one transport pick per OS).
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

#### Phase 5 — PTY host
- `worker_threads` per session; node-pty + xterm-headless wired.
- `PtyService.{Attach,SendInput,Resize}` implemented.
- Snapshot encoder per [06](./06-pty-snapshot-delta.md) §2; delta segmenter per §3; cadence per §4; reconnect tree per §5.
- All MUST-SPIKE items in [06](./06-pty-snapshot-delta.md) resolved.
- **Done when**: `pty-attach-stream` + `pty-reattach` + `pty-too-far-behind` integration tests green.
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

#### Phase 8 — Electron migration (big-bang)
- Single PR per [08](./08-electron-client-migration.md) §5.
- ESLint + grep gate `lint:no-ipc` green.
- All Electron components ported to React Query + generated Connect clients.
- **Done when**: ship-gate (a) green AND smoke-launch on each OS shows full UX functional.
- **P0 milestone**: ship-gate (a).

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
- (a) `lint:no-ipc`: implemented in phase 8; here we just ensure it stays green.
- (b) `sigkill-reattach.spec.ts` per [12](./12-testing-strategy.md) §4.2.
- (c) `pty-soak-1h` per [12](./12-testing-strategy.md) §4.3.
- (d) `installer-roundtrip.ps1` per [12](./12-testing-strategy.md) §4.4.
- **Done when**: all four green on the candidate release tag.

#### Phase 12 — Soak + dogfood + ship
- Engineer eats own dogfood for ≥ 1 week of real `claude` CLI usage.
- Daily crash log review; bug fixes flow as additive PRs (NO architectural changes — those are zero-rework violations and bounce back to spec).
- Ship.

### 3. Dependency DAG (seed for stage 6)

Edges = "must merge before". Most phases parallelize after phase 2.

```
0 ──► 1 ──► 2 ──► 3 ──► 4 ──► 5
              │            └► 6 (uses crash hooks from session manager)
              │            └► 7
              ├──► 9 (does not need 3-8; gates 10)
              │
              └► 8 (needs 1 for proto stubs; can start in parallel with 4-7
                     but cannot merge until 4-7 land — runtime depends on them)
              
9 ──► 10
{4,5,6,7,8} ──► 11{a,b,c,d}
10 ──► 11{d}
11 ──► 12
```

Specifically:
- Phase 1 unblocks phase 2 (server stubs) and phase 8 (client stubs) simultaneously.
- Phase 2 unblocks phase 3 (DB depends on daemon process boot).
- Phase 3 unblocks phases 4 and 6 and 7.
- Phase 4 unblocks phase 5 (PTY needs sessions).
- Phase 8 (Electron) can be worked in parallel from phase 1 onward but cannot merge until phases 4-7 are merged on the daemon side (otherwise the cutover PR would have nothing to call).
- Phase 10 (installer) needs phase 9 (service registration glue) but does NOT need internals (4-8); the installer just installs whatever `ccsm-daemon` binary is built.
- Phase 11 ship-gates need their corresponding source phases done (a→8, b→4+5+9, c→5, d→10).

### 4. Branching and merge discipline

- Trunk-based: all PRs into the working branch (`spec/2026-05-03-v03-daemon-split` for spec; for impl, the v0.3 release branch named separately by stage 6).
- Each phase opens with a parent tracking issue; child PRs reference it.
- Each PR: one phase OR one self-contained chunk inside a phase.
- Phase 8 (big-bang Electron) is the only large PR by design; everything else is < 600 LOC diff target.
- All PRs require: green CI on all OSes; one human review; no `--no-verify`.

### 5. P0 milestones (gate the v0.3 ship)

In the order they fall:

1. **M0 (Phase 2 done)**: daemon talks to a Connect client over Listener A. Unblocks all parallel work.
2. **M1 (Phase 5 done)**: PTY attach/reattach works in integration tests. Unblocks dogfood feasibility check.
3. **M2 (Phase 8 merged)**: ship-gate (a) green; Electron is no longer touching `ipcMain`. Unblocks phase 11(b) running against a real Electron.
4. **M3 (Phase 10 done)**: installable on all 3 OSes. Unblocks phase 11(d) and engineer dogfood at scale.
5. **M4 (all of Phase 11 green)**: ship-gate (a)+(b)+(c)+(d) all green on the same commit. Tag candidate.
6. **M5 (Phase 12)**: ≥ 7 days of dogfood with no architectural regression PRs. Tag v0.3 release.

### 6. v0.4 delta

- **Add** v0.4 phases stacked on top: Listener B + JWT, cloudflared lifecycle, web package, iOS package, web/iOS ship-gates.
- **Unchanged**: every v0.3 phase's outputs, the v0.3 ship-gate harnesses (still gate v0.4 ship), trunk-based branching discipline, the merge-precedence rules.
