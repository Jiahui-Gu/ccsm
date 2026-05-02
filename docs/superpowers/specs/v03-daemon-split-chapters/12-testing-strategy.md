# 12 — Testing Strategy

v0.3 testing has four layers: unit (fast, per-package, per-PR), integration (daemon ↔ Electron over Listener A, per-PR on supported runners), E2E (per-OS package + service-installed, scheduled + on-demand), and the four ship-gate harnesses tied directly to brief §11 acceptance criteria. This chapter pins each layer's scope, the framework choice, the ship-gate harnesses, and the CI orchestration.

### 1. Frameworks

| Layer | Framework | Why |
| --- | --- | --- |
| Unit (TS daemon + electron renderer) | **Vitest** | fast, ESM-native, parallel; same config for both packages |
| Integration | Vitest + a daemon-in-process bootstrap | spawns daemon code in-process (no native service install needed) |
| Electron E2E | **Playwright for Electron** | first-class Electron driver; works with the renderer's React app |
| Installer / service E2E | per-OS scripts (PowerShell on win, bash on mac/linux) | service install/uninstall is OS-shaped; using a single test runner is more harm than help |

### 2. Unit tests

Per-package, fully isolated.

- `@ccsm/daemon` unit:
  - `principal.spec.ts` — `principalKey` format, derivation edge cases
  - `auth.spec.ts` — `assertOwnership` truth table
  - `db/migrations.spec.ts` — apply 001 to a `:memory:` DB, assert schema
  - `db/coalescer.spec.ts` — write batching ordering and atomicity
  - `pty/snapshot-codec.spec.ts` — round-trip property tests for SnapshotV1 (per [06](./06-pty-snapshot-delta.md) §2)
  - `pty/delta-segmenter.spec.ts` — 16ms/16KiB cut policy
  - `crash/capture.spec.ts` — every source's mock fires once and writes one row
  - `listeners/peer-cred.spec.ts` — mocked syscall outputs map to expected principals
  - `listeners/listener-b.spec.ts` — `makeListenerB` throws (v0.3 stub assertion — prevents accidental wiring)

- `@ccsm/electron` unit:
  - `rpc/clients.spec.ts` — descriptor → transport factory (mocked transports per kind)
  - `rpc/queries.spec.ts` — React Query hook adapters (mock RPC, assert state transitions)
  - `ui/*.spec.tsx` — component-level (React Testing Library)

- `@ccsm/proto` unit:
  - `lock.spec.ts` — every `.proto` file's SHA256 vs a checked-in lockfile (forever-stable enforcement; not a buf-breaking replacement, complements it)
  - `buf-lint` runs in CI

### 3. Integration tests (daemon ↔ Electron over Listener A)

Live in `packages/daemon/test/integration/` and `packages/electron/test/integration/`. Daemon runs in-process (not service-installed) on an ephemeral port / temp UDS path; Electron-side tests use the same Connect client a real renderer uses but driven by Vitest.

- `connect-roundtrip.spec.ts` — Hello, ListSessions, CreateSession, GetSession, DestroySession, WatchSessions stream events fire correctly on create/destroy.
- `pty-attach-stream.spec.ts` — Create session with a deterministic test claude (`claude --simulate-workload` short variant); Attach with `since_seq=0`; assert receive snapshot then deltas; replay and compare to daemon-side terminal state.
- `pty-reattach.spec.ts` — Attach, record N deltas, disconnect, reattach with `since_seq=N`; assert deltas N+1..M arrive, no duplicates, no gaps.
- `pty-too-far-behind.spec.ts` — Attach, simulate falling outside retention window, assert daemon falls back to snapshot.
- `peer-cred-rejection.spec.ts` — connect with a synthesized non-owning peer-cred; assert `Unauthenticated`.
- `version-mismatch.spec.ts` — Hello with `proto_min_version` higher than daemon's; assert `FailedPrecondition` with structured detail.
- `crash-stream.spec.ts` — trigger every capture source via test hooks; assert `WatchCrashLog` emits each.
- `settings-roundtrip.spec.ts` — Update + Get equal.

CI runs integration tests on `{ubuntu, macos, windows}` matrix per PR.

### 4. The four ship-gate harnesses (brief §11)

#### 4.1 Ship-gate (a): no-IPC grep

`tools/lint-no-ipc.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
hits=$(grep -rEn 'contextBridge|ipcMain|ipcRenderer' packages/electron/src \
       --exclude-dir=node_modules --exclude-dir=dist || true)
if [ -n "$hits" ]; then
  echo "FAIL: IPC residue:"; echo "$hits"; exit 1
fi
echo "PASS: zero IPC residue"
```

Wired into `electron-test` job (per [11](./11-monorepo-layout.md) §6); blocks merge.

#### 4.2 Ship-gate (b): daemon survives Electron SIGKILL

`packages/electron/test/e2e/sigkill-reattach.spec.ts` (Playwright for Electron + per-OS kill helper):

1. Boot daemon (in-process for CI per-PR; service-installed for nightly).
2. Launch Electron via Playwright; create 3 sessions; wait for `RUNNING`; for each, attach and read 100 deltas; record last applied seq per session.
3. Kill the Electron main PID with `taskkill /F` (win) / `kill -9` (mac/linux).
4. Verify `curl <supervisor>/healthz` returns 200; verify `claude` PIDs still alive (`tasklist` / `ps`).
5. Relaunch Electron via Playwright; wait for `Hello`; verify the 3 sessions appear in `ListSessions`.
6. For each session, attach with the recorded last applied seq; assert receive deltas with `seq > recorded` immediately, no `snapshot` frame (still within retention window), no gaps.

Pass criterion: all assertions hold. CI: per-PR (in-process daemon) + nightly (service-installed).

#### 4.3 Ship-gate (c): 1-hour PTY zero-loss soak

Specified in [06](./06-pty-snapshot-delta.md) §8. Test name `pty-soak-1h`.

CI: nightly schedule + opt-in via `[soak]` in commit message. Self-hosted runner with 1-hour budget. Non-blocking for PRs (regressions caught the next morning); blocking for release tags.

#### 4.4 Ship-gate (d): clean installer round-trip on Win 11 25H2

`test/installer-roundtrip.ps1` runs on a self-hosted Win 11 25H2 VM (snapshotted to a clean state before each run):

```powershell
# pseudo-flow
Invoke-Snapshot-Restore "win11-25h2-clean"
Copy-Item ".\artifacts\ccsm-setup-*.msi" "C:\install\"
Start-Process -Wait msiexec -ArgumentList "/i C:\install\ccsm-setup.msi /qn /l*v C:\install\install.log"
# verify service
$svc = Get-Service ccsm-daemon
if ($svc.Status -ne 'Running') { throw "service not running" }
# verify supervisor
$ok = Invoke-WebRequest -UseBasicParsing http://localhost:.../healthz   # or named pipe
# launch electron, smoke-create a session, smoke-destroy
# uninstall
Start-Process -Wait msiexec -ArgumentList "/x C:\install\ccsm-setup.msi /qn /l*v C:\install\uninstall.log"
# verify residue
$violations = @()
if (Test-Path "$env:ProgramFiles\ccsm") { $violations += "ProgramFiles\ccsm exists" }
if (Get-Service ccsm-daemon -ErrorAction SilentlyContinue) { $violations += "service still registered" }
if (Test-Path "HKLM:\SYSTEM\CurrentControlSet\Services\ccsm-daemon") { $violations += "service registry key" }
if (Get-ScheduledTask -TaskName "ccsm*" -ErrorAction SilentlyContinue) { $violations += "scheduled tasks" }
if ($violations.Count -gt 0) { throw "Uninstall residue: $($violations -join '; ')" }
```

CI: nightly schedule + on-tag. Mac/linux equivalents (`installer-roundtrip.sh`) written in parallel but ship-gate (d) is specifically Win per brief §11(d).

### 5. Test data: deterministic claude CLI

For PTY tests we cannot use the real `claude` (network, model nondeterminism). We ship a test build `claude-sim` in `packages/daemon/test/fixtures/claude-sim/`:

- Reads a script file (path via `--simulate-workload-script`) of `(delay_ms, hex_bytes)` pairs.
- Writes the bytes to stdout with the specified delays.
- Honors a `--simulate-workload 60m` shortcut that runs a canned 60-minute script (UTF-8/CJK/256-color/alt-screen/bursts mix) used by ship-gate (c).
- Produces stable byte-by-byte identical output across runs.

The test build is a tiny Go or Rust binary cross-compiled in CI alongside the daemon; small enough to vendor in the test fixtures dir.

### 6. Coverage target

- Unit: 80% line coverage on `@ccsm/daemon/src` (excluding `dist/`, `gen/`, `test/`).
- Integration: not measured by line coverage; measured by RPC coverage — every RPC in [04](./04-proto-and-rpc-surface.md) MUST have at least one integration test exercising the happy path and at least one exercising an error path.
- Electron renderer: 60% line coverage on `src/renderer/`. UI-shell code (windowing, tray) is untested.

### 7. Performance budgets (regressions = test failures)

| Metric | Budget | Enforced by |
| --- | --- | --- |
| Daemon cold start to Listener A bind | < 500 ms (no sessions) / < 2 s (50 sessions to restore) | `bench/cold-start.spec.ts` |
| `Hello` RPC RTT over Listener A | < 5 ms p99 (loopback) | `bench/hello-rtt.spec.ts` |
| `SendInput` RTT | < 5 ms p99 | `bench/sendinput-rtt.spec.ts` |
| Snapshot encode (80×24 + 10k scrollback) | < 50 ms | `bench/snapshot-encode.spec.ts` |
| Daemon RSS at idle (5 sessions) | < 200 MB | nightly `bench/rss.spec.ts` |

Benchmarks run nightly; failures open an issue tagged `perf-regression` (do NOT block PRs — too noisy in CI; manual triage gates ship).

### 8. v0.4 delta

- **Add** integration tests for Listener B JWT path with mock cf-access tokens.
- **Add** web/iOS package test suites (their own runners; do not change daemon tests).
- **Add** ship-gate (e): "v0.4 web client connects through CF Tunnel and survives daemon restart" — additive harness.
- **Unchanged**: Vitest + Playwright choice, the four v0.3 ship-gate harnesses (still gate v0.4 ships too — additivity), test data `claude-sim`, coverage targets, performance budgets.
