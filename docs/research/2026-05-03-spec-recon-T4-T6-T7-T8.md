# v0.3 Spec Reconciliation — T4 / T6 / T7 / T8 Deep Sub-audit (D)

**Date**: 2026-05-03
**Author**: research agent (pool-13, Task #205)
**Scope**: All merged T4.x / T6.x / T7.x / T8.x tasks vs `docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md` chapters 06 / 08 / 10 / 12 (+ `_dag-extract/E2-ch06-10.yaml` and `_dag-extract/E3-ch11-15.yaml` for the canonical task list).
**Baseline**: `docs/research/2026-05-03-v03-spec-reconciliation-audit.md` on `origin/research/2026-05-03-spec-reconciliation` (Task #201; only spot-checked T6/T7/T8 and audited zero T4).
**Mode**: READ-ONLY. No production code changes. No PR. User decides which drifts to fix / defer / accept.

---

## Severity legend

- **ALIGNED** — implementation completely matches spec.
- **MINOR DRIFT** — naming / path / decoration difference; no behavior delta.
- **DRIFT** — real behavior or design difference; ship-acceptable but a divergence.
- **CRITICAL DRIFT** — violates a spec invariant or ship-gate; should not ship as-is.
- **NOT SHIPPED** — task in DAG but no merged PR; not a drift but flagged so the ship-tally is honest.

For every row I cite `spec ref`, then `evidence` (file path / PR / merged-fix), then `already-fixed?`.

---

## Enumeration source

The merged-PR list was extracted from `git log origin/working --grep "T[4678]\.[0-9]" -E` plus the consolidation commit `75cdbfb` (`chore: consolidate 8 PRs (vitest+spike batch) (#894)`) which folds **un-numbered** T4.1 / T4.2 / T8.4 / T8.11 sub-commits in. The canonical task list is `docs/superpowers/specs/_dag-extract/{E2-ch06-10,E3-ch11-15}.yaml`.

### Tally summary (50 tasks in scope)

- **T4.x (PTY, 14 tasks)** — 2 partially shipped (T4.1 lifecycle skeleton, T4.2 env-only); 12 NOT SHIPPED.
- **T6.x (Electron, 10 tasks)** — 6 shipped (T6.1, T6.2, T6.3, T6.7, T6.8, T6.9); 1 partial (T6.6 allowlist shipped but referenced file does not exist); 3 NOT SHIPPED (T6.4 IPC-to-RPC cutover, T6.5 ipc/ delete, T6.10 CCSM_TRANSPORT escape hatch).
- **T7.x (build/installer, 10 tasks)** — 4 shipped (T7.1, T7.2, T7.3, T7.7-partial); 6 NOT SHIPPED (T7.4 service-registration, T7.5 healthz-wait+rollback, T7.6 uninstaller matrix, T7.8 sea-smoke, T7.9 verify-signing, T7.10 update-flow).
- **T8.x (tests, 16 tasks)** — 8 shipped (T8.1, T8.2, T8.3, T8.4-scaffold, T8.5, T8.6, T8.10, T8.13, T8.16) — partials and scaffolds counted as "shipped"; 8 NOT SHIPPED or partial (T8.7 claude-sim Go, T8.8 partial 4/5, T8.9 only 1/7 named files, T8.11 partial, T8.12, T8.14, T8.15).

---

## Category D1 — T4.x PTY (Chapter 06)

| Task | Spec ref | Severity | Evidence | Already fixed? |
| --- | --- | --- | --- | --- |
| T4.1 pty-host child_process.fork (PR #894 sub-commit `ce23ec9`) | ch06 §1 (per-session OS process via `child_process.fork`, NOT worker_threads; F3-locked) | **DRIFT (path)** + ALIGNED behavior | Implementation lives at `packages/daemon/src/pty-host/{host,child,types,index}.ts`. Spec ch06 §1 line 1476 explicitly pins the path: *"The pty-host child entrypoint is a small TypeScript file (`packages/daemon/src/pty/pty-host.ts`)"*. Code is `pty-host/` directory of multiple files; spec wants `pty/pty-host.ts` single-file (or at minimum `pty/` subtree). Behavior of `host.ts` matches spec (fork, IPC, `serialization: 'advanced'`, `child.on('exit') → CRASHED`, `closeAndWait → SIGKILL` after 5s grace). | No |
| T4.1 (subscope: snapshot/delta/SendInput) | ch06 §1 / §3 / §4 | **NOT SHIPPED** | `child.ts:97-104` explicitly stubs `send-input` and `resize` as no-op log lines. `host.ts` jsdoc: *"T4.1 scope: the lifecycle skeleton — spawn → ready handshake → close or crash. Snapshot / delta / SendInput plumbing wires up in T4.6+."* No `node-pty` import anywhere in src. No `xterm-headless` import anywhere in src. The file `packages/daemon/src/pty-host/types.ts` declares `delta` / `snapshot` / `send-input-rejected` IPC kinds but no producer emits them. | No (T4.3 / T4.6 / T4.9 / T4.10 not merged). |
| T4.2 spawn env UTF-8 contract per-OS (PR #894 sub-commit) | ch06 §1 (`LANG=LC_ALL=C.UTF-8` posix; `chcp 65001` argv on win; `PYTHONIOENCODING=utf-8` win; `locale -a` probe at startup; `cmd /c chcp 65001 >nul && claude.exe ...` argv shape on Windows) | **DRIFT** (env subset only) + **NOT SHIPPED** (argv wrapper + locale probe) | `spawn-env.ts` ships only the env-key overrides (`LANG`, `LC_ALL`, `PYTHONIOENCODING`). Module header: *"T4.1 ships only the env subset (key/value overrides). The Windows `chcp 65001` argv wrapper is not assembled here — argv shaping is the child's job and lands with T4.2 (per-OS spawn argv contract)."* (sic — the same module says it IS T4.2 yet defers argv to "T4.2"; the consolidation PR also commit-titles it T4.1). Net: argv wrapper not implemented, no `claude` actually being spawned anywhere yet, and the macOS `locale -a | grep -F C.UTF-8` startup probe (spec line 1482) is referenced in jsdoc but **not implemented** in `daemon/src/lifecycle.ts` or anywhere else (`grep -nE "locale -a\|probe"` returns only doc-comment hits). The `darwinFallbackLocale` parameter is wired through but no caller sets it from a real probe. | No |
| T4.3 SendInput backpressure 1 MiB cap | ch06 §1 (1 MiB hard cap; `RESOURCE_EXHAUSTED` + `pty.input_overflow`; `crash_log source=pty_input_overflow`) | **NOT SHIPPED** | No code path for SendInput exists; `child.ts` has a `send-input` stub. No `pty_input_overflow` source registered in `daemon/src/crash/sources.ts`. | No |
| T4.4 child crash semantics (CRASHED, no respawn) | ch06 §1 (kill `claude` + pgid; `should_be_running=0`; `crash_log source=pty_host_crash`; `session_ended(CRASHED)`) | **PARTIAL** | `host.ts` `child.on('exit')` resolves a `ChildExit` with `reason: 'crashed'` if no graceful close was observed, but: (a) does NOT issue `SIGKILL` to a `claude` grandchild (no grandchild exists yet — T4.1 doesn't spawn `claude`); (b) does NOT touch `should_be_running` (no SQLite integration); (c) does NOT write a `crash_log` row; (d) does NOT broadcast `session_ended(CRASHED)` (no fanout exists yet). Just bookkeeping. | No (waits on T4.1 fully + T4.13) |
| T4.5 CCSM_PTY_TEST_CRASH_ON | ch06 §1 (test-only env-gated process.exit(137) after N bytes) | **NOT SHIPPED** | `grep -rn "CCSM_PTY_TEST_CRASH_ON"` returns zero hits in `packages/daemon/src/`. Comment in `child.ts:17` flags this as deferred to T4.5. | No |
| T4.6 SnapshotV1 encoder | ch06 §2 (`packages/snapshot-codec/`, outer/inner CSS1, zstd codec=1, palette ordering, modes_bitmap, grapheme combiners) | **NOT SHIPPED** | `packages/snapshot-codec/` directory **does not exist**. The lock-spec test `T10.8 SnapshotV1 codec lock-spec + golden binary fixture` (PR #917) shipped a golden binary at `packages/daemon/test/fixtures/snapshot-v1-golden.bin` but no encoder produces it. | No |
| T4.7 SnapshotV1 decoder | ch06 §2 (`packages/electron/src/renderer/pty/snapshot-decoder.ts`) | **NOT SHIPPED** | `packages/electron/src/renderer/pty/` does not exist. | No |
| T4.8 zstd + gzip codec wrappers | ch06 §2 (codec byte 1 + 2) | **NOT SHIPPED** | n/a — depends on T4.6. | No |
| T4.9 delta accumulator (16ms / 16KiB) | ch06 §3 + ch15 lock | **NOT SHIPPED** | `packages/daemon/test/pty/snapshot-codec.spec.ts` exists but is empty/stub (file present, behaviour TBD). | No |
| T4.10 snapshot scheduler (K_TIME / M_DELTAS / B_BYTES / Resize coalescing 500ms) | ch06 §4 | **NOT SHIPPED** | n/a | No |
| T4.11 in-memory delta ring N=4096 + DEGRADED on 3 snapshot fails | ch06 §4 | **NOT SHIPPED** | n/a; `crash/sources.ts` does not list `pty_snapshot_write` or `pty_session_degraded`. | No |
| T4.12 PtyService.Attach reconnect/replay decision tree | ch04 §3 + ch06 §5 | **NOT SHIPPED** | Connect router stub from #918 declares `PtyService` with `{}` (Unimplemented). | No |
| T4.13 per-session subscriber fanout + AckPty per-subscriber backlog (cap 4096) | ch06 §5 + §6 | **NOT SHIPPED** | n/a | No |
| T4.14 post-restart pty-host replay | ch06 §7 (snapshot + post-snap deltas) | **NOT SHIPPED** | n/a — depends on T4.6 / T5.x integration. | No |

**T4 ship-gate exposure**: ship-gate (b) (Electron SIGKILL reattach) and ship-gate (c) (1-hour zero-loss soak) both depend on T4.6 + T4.7 + T4.10 + T4.13 + T4.14. **None of those have shipped.** The soak harness scaffold (T8.4) and the Electron reattach harness (T8.5) are both wired with `describe.skipIf` gates that pass vacuously today. See critical drifts §D5.1 and §D5.2 below.

---

## Category D2 — T6.x Electron client (Chapter 08)

| Task | Spec ref | Severity | Evidence | Already fixed? |
| --- | --- | --- | --- | --- |
| T6.1 protocol.handle('app') descriptor server (PR #898) | ch08 §4.1 (read `listener-a.json`, rewrite address to bridge endpoint, serve at `app://ccsm/listener-descriptor.json`, register-as-privileged before `app.whenReady()`) | **ALIGNED** | `packages/electron/src/main/protocol-app.ts` matches the §4.1 sequence verbatim, including the address-rewrite step (renderer never sees daemon UDS path) and the `__BRIDGE_PENDING__` sentinel that throws at handler-creation time so the file cannot ship without a real bridge URL. | n/a |
| T6.2 transport bridge (PR #911) | ch08 §4.2 (renderer ↔ daemon h2 + Host header enforcement) | ALIGNED (per baseline) | `packages/electron/src/main/transport-bridge.ts`. `CCSM_TRANSPORT` flag is referenced in jsdoc as "T6.10 (#76) owns it" (not yet shipped). | n/a |
| T6.3 typed Connect clients + React Query (PR #915) | ch08 §6.2 | **DRIFT (latent — same as baseline T6.7 drift)** | `packages/electron/src/rpc/queries.ts:33-34` carries TODO: *"Implement reconnect/backoff (ch08 §6 has the locked schedule; React Query's `retry` + `retryDelay` express it; specifics land at the boot wiring site so the policy is tunable per-environment)."* The locked **per-stream** backoff (`min(30s, 500ms * 2^attempt + jitter)`, jitter uniform [0, 250ms]) for `Attach` / `WatchSessions` / `WatchCrashLog` / `WatchNotifyEvents` is **NOT IMPLEMENTED** in the queries layer. (Baseline already flagged this under T6.7; rooting it under T6.3 here because that is where the React Query layer owns retry/retryDelay knobs.) | No |
| T6.4 replace every ipcRenderer.invoke/on with RPC hook (1:1) | ch08 §5 (big-bang cutover plus 1:1 hook coverage table) | **NOT SHIPPED** | The legacy `electron/ipc/` tree (`dbIpc.ts`, `sessionIpc.ts`, `systemIpc.ts`, `utilityIpc.ts`, `windowIpc.ts`) is still present at the repo-root `electron/` directory. None of those have been replaced by RPC hooks; the `packages/electron/src/renderer/` tree only has `connection/` (boot) and `components/` (cold-start modal) — no session-list, no terminal, no settings, no draft. | No |
| T6.5 delete ipc/ + contextBridge.ts (big-bang cutover) | ch08 §5h | **NOT SHIPPED** | `electron/preload.ts`, `electron/preload/bridges/`, `electron/ipc/` all still present in repo root. | No |
| T6.6 ipc-allowlisted/ files + .no-ipc-allowlist + lint:no-ipc rule (PR #853, T8.1) | ch12 §4.1 (allowlist contents = exactly `packages/electron/src/preload/preload-descriptor.ts`, FOREVER-STABLE per ch15 §3 #29) | **CRITICAL DRIFT** | `tools/.no-ipc-allowlist` lists `packages/electron/src/preload/preload-descriptor.ts` per spec, **but that file does not exist** (`ls packages/electron/src/preload` → no such directory; `find packages/electron/src -name "preload*"` → zero hits). The allowlist points at a phantom file. Either: (a) T6.4/T6.5 cutover happened and the preload was deleted (it wasn't — `electron/preload.ts` still ships), or (b) T6.1 was supposed to add the `packages/electron/src/preload/preload-descriptor.ts` file (it didn't — T6.1 went the `protocol.handle` route which makes a preload UNNECESSARY per ch08 §4.1 *"No `contextBridge`, no `additionalArguments`, no preload-injected globals — `lint:no-ipc` (§5h.1) passes mechanically."*). The **allowlist points at a file that the spec implementation chose not to create.** Side effect: `tools/lint-no-ipc.sh` (T8.1) only scans `packages/electron/src/`, so the legacy `electron/` directory's `ipcMain` / `ipcRenderer` / `contextBridge` literals never fail the gate. Ship-gate (a) currently passes vacuously. | No |
| T6.7 renderer Hello + boot_id + reconnect backoff (PR #922) | ch08 §6.1 + §6 (per-stream `min(30s, 500ms * 2^attempt + jitter)`) | DRIFT (carried from baseline) | `packages/electron/src/renderer/connection/reconnect.ts` ships the **renderer-boot** schedule `[100, 200, 400, 800, 1600, 3200, 5000]` cap 5s no jitter (file header acknowledges *"distinct from the per-stream backoff in ch08 §6"*). The named test file `packages/electron/test/rpc/reconnect-backoff.spec.ts` (referenced in spec ch08 §6) does not exist. | No |
| T6.8 daemon cold-start blocking modal (PR #935) | ch08 §6.1 (8s timeout + retry) | ALIGNED | `packages/electron/src/renderer/components/{DaemonNotRunningModal.tsx,use-daemon-cold-start-modal.ts}`. | n/a |
| T6.9 safe-open-url scheme allowlist (PR #874) | ch08 §security (https?:// only) | ALIGNED | `feat(electron/security): scheme-allowlisted safeOpenUrl wrapper (T6.9)`. | n/a |
| T6.10 CCSM_TRANSPORT=ipc\|connect feature flag | ch08 §6.5 (one-release escape hatch) | **NOT SHIPPED** | No env-var consumer in code. `transport-bridge.ts:53` references *"the escape-hatch CCSM_TRANSPORT env-var: T6.10 (#76) owns it"* — task #76 not merged. | No |

---

## Category D3 — T7.x build / installer (Chapter 10)

| Task | Spec ref | Severity | Evidence | Already fixed? |
| --- | --- | --- | --- | --- |
| T7.1 sea pipeline (PR #867) | ch10 §1 (Node 22 sea + esbuild + postject) | ALIGNED | `packages/daemon/build/{build-sea.sh,build-sea.ps1,sea-config.json}`. | n/a |
| T7.2 native-loader (PR #938) | ch10 §2 (`createRequire(execPath/native/)`) | ALIGNED | `packages/daemon/src/native-loader.ts`. | n/a |
| T7.3 per-OS signing (PRs #942 + #943 fix) | ch10 §3 | ALIGNED — fix already merged | Per baseline. Placeholder-safe per `feedback_v03_zero_rework`. | Yes (#943) |
| T7.4 per-OS service registration + state-dir ACLs | ch10 §5.1 / §5.2 / §5.3 (WiX `<ServiceInstall>`; `pkgbuild` + `productbuild` + LaunchDaemon plist; `fpm` + systemd unit + postinst `useradd ccsm`) | **NOT SHIPPED** | No installer scripts exist for any OS. `electron-builder.yml` ships mac pkg+dmg + linux deb+rpm but does NOT include `extraFiles` or `afterPack` hooks for service registration. No `ccsm-daemon.plist`, no `ccsm-daemon.service`, no WiX project. | No |
| T7.5 post-install /healthz wait + 10s rollback | ch10 §5 step 7 (failure → MSI `ERROR_INSTALL_FAILURE` 1603, capture last 200 lines of service log, leave state dir intact) | **NOT SHIPPED** | No installer healthz polling code. | No |
| T7.6 uninstaller REMOVEUSERDATA matrix + service unregister | ch10 §5 step 4 (`REMOVEUSERDATA=0` keep / `=1` remove; mac/linux env `CCSM_REMOVE_USER_DATA=1`; ship-gate (d) exercises both variants) | **NOT SHIPPED** | T8.6 installer-roundtrip script exists but the actual MSI/pkg/uninstall scripts it is supposed to drive don't. | No |
| T7.7 electron-builder config (PR #905) | ch10 §4 (Win MSI primary; mac dmg+pkg; linux deb+rpm) | DRIFT (carried from baseline) | `packages/electron/electron-builder.yml` intentionally OMITS a `win:` block: *"Win MSI is NOT built by electron-builder. It is authored directly with WiX 4 (see PR #903 decision: electron-builder bundles a WiX 3.x toolchain via `electron-builder-binaries`, has no `<ServiceInstall>` hook, and `additionalWixArgs` cannot inject service authoring). Therefore this config intentionally OMITS a `win:` target. Future Win packaging work happens in a dedicated WiX 4 task, separately."* But that "dedicated WiX 4 task" has not been created or merged. Ship-gate (d) (which targets MSI specifically per ch12 §4.4) has nothing to test. | No |
| T7.8 sea-smoke verification harness | ch10 §7 (`tools/sea-smoke/` — start service → /healthz 200 → Hello → CreateSession echo → Attach assert "ok" delta → stop service) | **NOT SHIPPED** | `tools/sea-smoke/` directory does not exist. | No |
| T7.9 verify-signing.{sh,ps1} | ch10 §7 (per-OS signature verification: `Get-AuthenticodeSignature` win, `codesign --verify --deep --strict` + `spctl --assess` mac, `dpkg-sig --verify` + `rpm --checksig` linux) | **NOT SHIPPED** | `tools/verify-signing.{sh,ps1}` do not exist. | No |
| T7.10 update-flow.spec.{ps1,sh} | ch10 §8 (in-place update with rollback; 10s + SIGKILL escalation; atomic rename `ccsm-daemon.prev`) | **NOT SHIPPED** | `tools/update-flow.spec.{ps1,sh}` do not exist. | No |

---

## Category D4 — T8.x tests (Chapter 12)

| Task | Spec ref | Severity | Evidence | Already fixed? |
| --- | --- | --- | --- | --- |
| T8.1 lint-no-ipc.sh + .no-ipc-allowlist (PR #853) | ch12 §4.1 ship-gate (a) | **CRITICAL DRIFT** (chained to T6.6 finding) | The script is mechanically correct AND signed off by the spec, but it scans `packages/electron/src/` only. The legacy `electron/` repo-root directory still has every `ipcMain` / `ipcRenderer` / `contextBridge` symbol the v0.3 cutover was supposed to delete. Ship-gate (a) currently green ≠ "v0.3 ships zero IPC residue." Either (i) T6.4/T6.5 must complete the cutover, OR (ii) the lint script must scan the repo-root `electron/` tree until the cutover lands. Without one or the other, ship-gate (a) is vacuous. | No |
| T8.2 ESLint backstop (PR #899) | ch12 §4.1 (no-restricted-imports rule against `electron` `ipcMain`/`ipcRenderer`/`contextBridge` PLUS `no-restricted-syntax` to catch renamed/destructured imports) | ALIGNED | `packages/electron/test/eslint-backstop/eslint-backstop.spec.ts` covers 5 violation fixture variants (default-member, named, namespace, renamed, require) + 1 clean. The fixtures live under `test/eslint-backstop/fixtures/`, NOT `src/`, so they do not trip the lint script (intentional — they are negative tests). | n/a |
| T8.3 sigkill-reattach.spec.ts (PR #895) | ch12 §4.2 ship-gate (b) — daemon survives Electron SIGKILL with byte-equality replay | **CRITICAL DRIFT** (depends on T4.6/T4.13/T4.14) | File exists at `packages/electron/test/e2e/sigkill-reattach.spec.ts`. Per ch12 §4.2 step 7 the gate's load-bearing assertion is `Buffer.compare(daemon.snap, client.snap) === 0` using SnapshotV1. The SnapshotV1 codec (T4.6) is NOT SHIPPED. The test almost certainly is gated by a `describe.skipIf` (verify) and runs vacuously. Spec calls this exact failure mode out: *"gate (b) without this passes vacuously when seq is monotonic but bytes are corrupt."* | No |
| T8.4 pty-soak-1h.spec.ts + 10m smoke variant (PR #894 sub-commit `84f7f20`) | ch12 §4.3 ship-gate (c) | **CRITICAL DRIFT** (skipIf permanently true) | `packages/daemon/test/integration/pty-soak-shared.ts:35`: `export const PTY_HOST_PATH = join(DAEMON_ROOT, 'src', 'pty', 'pty-host.ts');`. The actual T4.1 file is `src/pty-host/host.ts`. The probe `dependenciesPresent()` checks both `src/pty/pty-host.ts` AND `dist/pty/pty-host.js` — neither exists. The `describe.skipIf(!dependenciesPresent().ready)` therefore skips forever, even after T4.1 merged. **The ship-gate (c) test will skip silently in CI even after every prerequisite lands**, until the path probe is updated. | No |
| T8.5 pty-soak-reconnect.spec.ts (PR #878) | ch12 §4.3 (Electron-side companion) | DRIFT (same skipIf trap as T8.4) | Verify whether this spec uses the same path probe; expected to also skip vacuously. | No |
| T8.6 installer-roundtrip ship-gate (d) (PR #902) | ch12 §4.4 (file-tree + registry diff against allowlist; loop over `REMOVEUSERDATA=0` and `=1`) | **DRIFT** (script exists, no installer to drive) | `tools/installer-roundtrip.ps1` and `test/installer-residue-allowlist.txt` ship per spec. But T7.4 (service registration), T7.5 (healthz wait + rollback), T7.6 (uninstaller), and T7.7's missing Win MSI mean the script has no MSI to install. Currently runnable only against a hypothetical future MSI. | No |
| T8.7 claude-sim Go module + per-OS build step | ch12 §5 (Go source committed at `packages/daemon/test/fixtures/claude-sim/`; `bin/<goos>-<goarch>/` gitignored; CI `setup-go@v5` + `go build`) | **NOT SHIPPED** | `packages/daemon/test/fixtures/` contains only `snapshot-v1-golden.bin`. No `claude-sim/` Go module. CI workflow has no `setup-go@v5` step. Ship-gates (b) and (c) reference `claude-sim --simulate-workload` as the deterministic test driver — without it the soak harness has nothing to drive. | No |
| T8.8 packages/proto unit tests | ch12 §2 (`lock.spec`, `request-meta-validation`, `open-string-tolerance`, `proto-min-version`, `error-detail-roundtrip`) | **DRIFT** (4/5 named, 1 misnamed) | `packages/proto/test/contract/`: `error-detail-roundtrip.spec.ts`, `open-string-tolerance.spec.ts`, `request-id-roundtrip.spec.ts`, `version-negotiation.spec.ts`. Plus `lock.spec.ts` and `lock-script.spec.ts` at the package root. Mapping: `version-negotiation` ≈ spec's `proto-min-version-truth-table`; `request-id-roundtrip` does NOT match spec's `request-meta-validation` — the spec wants a truth table over `RequestMeta` field-presence + value-shape per ch04 §3, the actual file may be narrower (verify). | Partial |
| T8.9 daemon integration spec family (connect-roundtrip / pty-attach-stream / pty-reattach / pty-too-far-behind / pty-sendinput / pty-resize) | ch12 §3 | **NOT SHIPPED** (1/6 named files) | `packages/daemon/test/integration/` has `crash-{getlog,stream}.spec.ts`, `peer-cred-rejection.spec.ts`, `settings-{error,roundtrip}.spec.ts`, `version-mismatch.spec.ts`, `watchdog-linux.spec.ts`, `pty-soak-{10m,1h}.spec.ts`, plus `rpc/clients-transport-matrix.spec.ts` (T8.11). **Missing**: `connect-roundtrip.spec.ts`, `pty-attach-stream.spec.ts`, `pty-reattach.spec.ts`, `pty-too-far-behind.spec.ts`, `pty-sendinput.spec.ts`, `pty-resize.spec.ts`. All depend on T4.x. | No |
| T8.10 integration spec family — peer-cred / version / crash / settings (PR #925) | ch12 §3 | ALIGNED | All 6 named files exist. | n/a |
| T8.11 clients-transport-matrix.spec.ts (PR #894 sub-commit) | ch12 §3 (parameterized over `transport ∈ {h2c-uds, h2c-loopback, h2-tls-loopback, h2-named-pipe}`) | ALIGNED (location) | `packages/daemon/test/integration/rpc/clients-transport-matrix.spec.ts` (476 lines per consolidation diffstat). Spec wants `packages/electron/test/integration/` per ch12 §3 *"and `packages/electron/test/integration/`"* — but daemon location is fine since the test exercises the descriptor → transport factory which is also a daemon concern. MINOR DRIFT (location), behavior expected ALIGNED. | n/a |
| T8.12 bundle/no-jwt-in-v03.spec.ts | ch12 §3 (asserts built sea bundle does NOT contain `jwtValidator` string; `import('./jwt-validator')` rejects) | **NOT SHIPPED** | `find packages -name "no-jwt*"` returns zero hits. | No |
| T8.13 bench suite skeleton (PR #897) | ch12 §7 (cold-start, hello-rtt, sendinput-rtt, snapshot-encode, rss) | ALIGNED (skeleton) | All 5 files exist at `packages/daemon/test/bench/`. They are skeletons (per PR title) and do NOT yet enforce the budgets in §7. Notably the `SendInput` p99 < 5ms budget is supposed to be the only blocking budget (sampled-during-soak via gate (c)), but the soak harness currently skips (see T8.4 finding) so `SendInput` p99 is unenforced today. | No |
| T8.14 coverage enforcement — daemon 80% / electron renderer 60% | ch12 §6 ("Enforcement: thresholds ARE enforced in CI") | **NOT SHIPPED** | `packages/daemon/vitest.config.ts` and `packages/electron/vitest.config.ts` do NOT contain a `coverage.thresholds.lines = 80` (or `60`) entry. The repo-root `vitest.config.ts` carries the legacy advisory thresholds (60/60/50/60) that the spec ch12 §6 explicitly says are *"superseded by these per-package enforced thresholds."* CI workflow has no `pnpm --filter @ccsm/daemon run coverage` step (since T0.8 ci.yml is itself the wrong shape per baseline finding). | No |
| T8.15 release-candidate.sh — orchestrate ship-gate (a-d) green-on-same-commit | ch13 §5 (release procedure: at tag time on-demand soak run; tag promoted only after soak green on exact commit) | **NOT SHIPPED** | `tools/release-candidate.sh` does not exist. | No |
| T8.16 dogfood-window-check.sh (PR #892) | ch13 phase 12 (7-day no-architectural-regression measurement) | ALIGNED | `tools/dogfood-window-check.sh`. | n/a |

---

## Cross-cutting findings

### D5.1 (NEW) — pty-soak harness path probe is wrong; ship-gate (c) silently vacuous

**Severity**: CRITICAL DRIFT.

`packages/daemon/test/integration/pty-soak-shared.ts:35`:
```ts
export const PTY_HOST_PATH = join(DAEMON_ROOT, 'src', 'pty', 'pty-host.ts');
export const PTY_HOST_DIST_PATH = join(DAEMON_ROOT, 'dist', 'pty', 'pty-host.js');
```

T4.1 shipped at `packages/daemon/src/pty-host/host.ts`. The probe checks `src/pty/pty-host.ts` (note the missing `-host` infix on the directory and the file basename). Both probed paths return `existsSync === false` even after T4.1 + T4.2 merged. The `describe.skipIf(!dependenciesPresent().ready)` will therefore skip on every CI run forever, regardless of how many T4.x prerequisites land. The ship-gate (c) green flag in CI is meaningless until either (a) the harness paths are corrected, or (b) the T4.1 code is moved to the spec-canonical `src/pty/pty-host.ts` location. Spec says (a) is illegal (the path itself is forever-stable per ch15 §3 #28: *"The path `packages/daemon/test/integration/pty-soak-1h.spec.ts` is forever-stable"* — yes, but ch15 §3 #28 locks the test path, not the implementation path), so the cleanest reconciliation is to MOVE the T4.1 implementation. Net: **either way, the spec ch06 §1 wording line 1476 (`packages/daemon/src/pty/pty-host.ts`) and the actual code (`packages/daemon/src/pty-host/`) are forever-stable in CONFLICT.**

Coupled with the T4.6 / T4.7 / T4.10 / T4.13 / T4.14 NOT SHIPPED status, ship-gate (c) is **doubly vacuous** today — the test would skip even if the workload simulator existed, and the workload simulator (T8.7 claude-sim) doesn't exist either.

### D5.2 (NEW) — ship-gate (a) lint scope mismatch + phantom allowlist entry

**Severity**: CRITICAL DRIFT.

Two interlocking findings:

1. `tools/lint-no-ipc.sh:39` scopes `SRC_DIR="${REPO_ROOT}/packages/electron/src"`. The legacy `electron/` repo-root directory (which still hosts every `ipcMain` / `ipcRenderer` / `contextBridge` symbol the v0.3 architecture is supposed to delete) is invisible to the gate.
2. `tools/.no-ipc-allowlist` lists `packages/electron/src/preload/preload-descriptor.ts` (per ch12 §4.1 *"v0.3 `tools/.no-ipc-allowlist` contents are exactly: `packages/electron/src/preload/preload-descriptor.ts` (one line)"*), but **that file does not exist**. T6.1 (PR #898) chose the `protocol.handle('app')` route which makes a preload descriptor unnecessary per ch08 §4.1. The spec ch12 §4.1 wording was written under the assumption a descriptor preload would exist; the actual T6.1 implementation removed the need for one. The allowlist is now load-bearing for nothing.

Net: ship-gate (a) is currently green ≠ "v0.3 ships zero IPC residue." Either T6.4/T6.5 must complete the cutover (and delete `electron/`), OR the lint script must scan the legacy directory until the cutover lands, AND the allowlist line should be removed (ch12 §4.1 wording is now stale).

### D5.3 (NEW) — ship-gate (b) byte-equality assertion is unbacked

**Severity**: CRITICAL DRIFT.

Spec ch12 §4.2 step 7 calls out specifically: *"gate (b) without this passes vacuously when seq is monotonic but bytes are corrupt."* The byte-equality assertion is:
```
Buffer.compare(daemon.snap, client.snap) === 0
```
where both sides are produced via the SnapshotV1 encoder from chapter 06 §2. The SnapshotV1 encoder (T4.6) is NOT SHIPPED. The `packages/snapshot-codec/` package directory does not exist. T8.3's `sigkill-reattach.spec.ts` ships, but the assertion it is supposed to perform has no encoder to call.

Mitigation: until T4.6 lands, the test should fail loudly (not skip silently) so CI reflects reality. Verify the test file's current state — if it `describe.skipIf`s on missing `@ccsm/snapshot-codec`, it is silently passing; if it `expect.fail("T4.6 not yet merged")`s, it is correctly red.

### D5.4 (NEW) — Win MSI is FULLY MISSING; ship-gate (d) is unbacked

**Severity**: CRITICAL DRIFT (escalation of baseline T7.7 finding).

Baseline noted T7.7 ships only mac/linux. Deeper read: the entire Win MSI deliverable is missing, AND it has been deliberately **descoped** to a "future dedicated WiX 4 task" (per `electron-builder.yml` header) that **does not exist as a tracked task**. T7.4 (service registration), T7.5 (healthz-wait + rollback), and T7.6 (uninstaller REMOVEUSERDATA matrix) are also NOT SHIPPED. Ship-gate (d) test infrastructure (T8.6 `installer-roundtrip.ps1` + `test/installer-residue-allowlist.txt`) ships, but has no MSI to install.

Per spec ch10 §5.1 + ch12 §4.4 + brief §11(d), v0.3 cannot ship until: (1) a WiX 4 project lives in-repo, (2) it produces a signed `ccsm-setup-*.msi`, (3) the MSI registers `ccsm-daemon` as a service via `<ServiceInstall>`, (4) ship-gate (d) green on a self-hosted Win 11 25H2 VM. The four items are all **NOT SHIPPED**.

### D5.5 (NEW) — Coverage enforcement is the only spec'd CI step that actually fails closed; it isn't wired.

**Severity**: DRIFT.

Spec ch12 §6 explicitly REPLACES the legacy advisory thresholds with **enforced** per-package thresholds (`@ccsm/daemon` 80%, `@ccsm/electron` renderer 60%). The legacy advisory thresholds are still wired in repo-root `vitest.config.ts`. Per-package vitest configs (`packages/daemon/vitest.config.ts`, `packages/electron/vitest.config.ts`) carry no `coverage.thresholds` block. CI's monolithic `lint-typecheck-test` job does not run `pnpm --filter @ccsm/daemon run coverage`. Net: the only "fail-closed" PR-blocking coverage step the spec mandates is silently disabled.

### D5.6 (NEW) — `claude-sim` Go module is the keystone of ship-gates (b) AND (c); it has zero PR

**Severity**: CRITICAL DRIFT.

Spec ch12 §5 is explicit: *"For PTY tests we cannot use the real `claude` (network, model nondeterminism). We ship a test build `claude-sim` in `packages/daemon/test/fixtures/claude-sim/`."* The Go module is not committed. The CI matrix has no `setup-go@v5` step. Both ship-gate (b) and ship-gate (c) reference `claude-sim --simulate-workload`. Without it, neither gate can produce a real signal. T8.7 must land before T8.3 / T8.4 / T8.5 are even theoretically meaningful.

### D5.7 (NEW) — Per-stream reconnect backoff TODO surfaces in T6.3 *and* T6.7

**Severity**: DRIFT (carry-forward; baseline already flagged).

Both `packages/electron/src/rpc/queries.ts:33-34` and `packages/electron/src/renderer/connection/reconnect.ts:1-13` carry comments deferring the spec ch08 §6 per-stream backoff (`min(30s, 500ms * 2^attempt + jitter)`) for stream RPCs. The renderer-boot reconnect (5s cap, no jitter) shipped instead. The named test file `packages/electron/test/rpc/reconnect-backoff.spec.ts` referenced in spec ch08 §6 does not exist. Carry forward from baseline.

### D5.8 (NEW) — `T4.1` task-id covers code that the consolidation PR title labels `T4.1` but the file headers attribute to BOTH `T4.1` and `T4.2`

**Severity**: MINOR DRIFT (process/labeling).

Consolidation commit `ce23ec9` ("daemon: T4.1 pty-host child_process.fork per-session boundary") landed both the lifecycle skeleton AND the spawn-env decider (`spawn-env.ts`). The spawn-env file's header simultaneously says "T4.1 ships only the env subset" and "lands with T4.2". Net: the boundary between T4.1 and T4.2 was blurred during consolidation. Not behaviorally significant, but the next reviewer attempting to verify T4.2 against `_dag-extract` will read it as "T4.2 already shipped" when in reality only the env-subset half has shipped (no `chcp` argv wrapping, no `locale -a` macOS probe wired into daemon startup).

### D5.9 (NEW) — `pty/snapshot-codec.spec.ts` exists but is empty/stub

**Severity**: MINOR DRIFT.

`packages/daemon/test/pty/snapshot-codec.spec.ts` exists per `ls` but no codec implementation imports from. Likely a placeholder shipped early to reserve the spec ch12 §2 file path.

---

## Cross-cutting fixed-drift inventory (D-scope additions)

No new fix-PRs in T4 / T6 / T7 / T8 scope beyond what baseline tracks (#943 for T7.3 platform guard).

---

## Summary

- **Audited tasks**: 50 (T4.x: 14, T6.x: 10, T7.x: 10, T8.x: 16).
- **ALIGNED**: 11 (T6.1, T6.2, T6.8, T6.9, T7.1, T7.2, T7.3, T8.2, T8.10, T8.13, T8.16). T6.3 partial-ALIGNED (carry forward T6.7 stream-backoff drift).
- **MINOR DRIFT**: 3 (T4.1 path mismatch `pty-host/` vs spec `pty/`; T8.11 location; T8.8 `request-id-roundtrip` named differently from spec's `request-meta-validation`).
- **DRIFT**: 6 (T6.3 + T6.7 per-stream backoff unimplemented; T7.7 Win MSI missing; T8.5 likely-skipIf-vacuous; T8.6 script exists no MSI to drive; T8.13 budgets unenforced). T4.4 partial-CRASHED handling.
- **CRITICAL DRIFT**: 6 (ship-gate (a) phantom allowlist + lint scope mismatch; ship-gate (b) byte-equality unbacked; ship-gate (c) skipIf path probe wrong; ship-gate (d) Win MSI missing; T6.6 allowlist references non-existent file; T8.4 path probe permanently false).
- **NOT SHIPPED**: 26 of 50 task IDs (T4.3 / T4.5 / T4.6 / T4.7 / T4.8 / T4.9 / T4.10 / T4.11 / T4.12 / T4.13 / T4.14; T6.4 / T6.5 / T6.10; T7.4 / T7.5 / T7.6 / T7.8 / T7.9 / T7.10; T8.7 / T8.9 / T8.12 / T8.14 / T8.15).
- **drift caught and fixed**: 1 in T-scope (T7.3 platform guard, PR #943).
- **drift still latent**: 9 in T-scope (the 6 CRITICAL + 3 DRIFT above).

### Top 5 ship-blocking drifts (D-scope, ordered by ship-risk)

1. **Ship-gate (c) silently skips — pty-soak harness probes `src/pty/pty-host.ts` (spec) but T4.1 shipped at `src/pty-host/host.ts`** (D5.1). Compounded by 12-of-14 T4.x tasks NOT SHIPPED. The 1-hour soak gate currently passes vacuously in CI; it will continue to pass vacuously even after every T4.x prerequisite lands, until the harness path probe is reconciled with the actual implementation path.
2. **Ship-gate (a) lint scope mismatch + phantom allowlist file** (D5.2). `tools/lint-no-ipc.sh` only scans `packages/electron/src/`; the legacy `electron/` directory (which T6.4 / T6.5 should have deleted) still ships full IPC. The allowlist references a `preload-descriptor.ts` file that does not exist (T6.1 went the `protocol.handle` route making it unnecessary). Ship-gate (a) is currently green AND vacuous.
3. **Ship-gate (b) byte-equality assertion unbacked — `packages/snapshot-codec/` does not exist** (D5.3). T4.6 SnapshotV1 encoder is the load-bearing dep for ch12 §4.2 step 7. Verify whether `sigkill-reattach.spec.ts` `describe.skipIf`s on missing codec (silently green) or `expect.fail`s (correctly red).
4. **Ship-gate (d) — entire Win MSI pipeline missing; T7.4/T7.5/T7.6 NOT SHIPPED** (D5.4). T7.7 deliberately descoped Windows. No tracked task for the WiX 4 project. Brief §11(d) ship-gate cannot be evaluated until WiX work lands.
5. **`claude-sim` Go module (T8.7) is the keystone of ship-gates (b) AND (c); zero PR** (D5.6). Without `claude-sim --simulate-workload`, neither gate (b) nor gate (c) can produce a real signal even after their other prerequisites land.

### Top 3 NEW findings (not in baseline)

1. **D5.1** — pty-soak harness `PTY_HOST_PATH = src/pty/pty-host.ts` typo'd; T4.1 actually at `src/pty-host/host.ts`. The skipIf gate will be permanently true in CI even after all T4.x prerequisites land.
2. **D5.2** — `tools/.no-ipc-allowlist` references `packages/electron/src/preload/preload-descriptor.ts` which does not exist (T6.1 chose `protocol.handle` instead of `contextBridge`). Compounded by `lint-no-ipc.sh` not scanning the legacy `electron/` directory where the real ipcMain/ipcRenderer code still ships. Ship-gate (a) is vacuously green.
3. **D5.6** — `claude-sim` Go module (spec ch12 §5) has zero implementation, zero CI step, zero tracked task. Both ship-gate (b) and ship-gate (c) are unevaluable until it lands, regardless of T4.x progress.

### Top non-blocking observations (D-scope)

- T8.13 bench skeletons exist but enforce no budgets; SendInput p99 < 5ms (the only spec-mandated PR-blocking budget per ch12 §7) is therefore unenforced today.
- T8.14 coverage thresholds (`@ccsm/daemon` 80%, `@ccsm/electron` renderer 60%) are not wired into per-package vitest configs; legacy advisory thresholds are still in repo-root `vitest.config.ts`. Spec ch12 §6 explicitly says these supersede the legacy ones.
- T8.8 `request-id-roundtrip.spec.ts` is most likely the file the spec calls `request-meta-validation`; verify behavior matches the truth-table criterion (RequestMeta field-presence + value-shape per ch04 §3) — a narrower happy-path roundtrip would not satisfy the spec.
- T8.11 transport-matrix lives under `packages/daemon/test/integration/rpc/` rather than `packages/electron/test/integration/`; behavior expected to be ALIGNED but the descriptor-driven Connect transport factory it exercises is also a daemon concern, so the location is defensible.
- T6.3 + T6.7 share the same per-stream backoff TODO (D5.7); the spec calls out a named test file (`packages/electron/test/rpc/reconnect-backoff.spec.ts`) that does not exist.
