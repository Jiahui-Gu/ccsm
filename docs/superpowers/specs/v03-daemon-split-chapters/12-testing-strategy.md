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
  - `pty/replay-invariant.property.spec.ts` — property-based test (fast-check) for the replay invariant: for any deterministic VT byte sequence S fed into a fresh xterm-headless `Terminal` X, `encode(snapshot(X))` equals `encode(snapshot(Y))` where Y is built by encoding a snapshot of X' (a checkpoint mid-stream of S) and replaying the post-checkpoint deltas of S into a fresh Terminal initialized from that snapshot. Shrinker catches edge-case VT byte sequences that the canned soak workload (§4.3) misses.
  - `crash/capture.spec.ts` — every source's mock fires once and writes one row
  - `listeners/peer-cred.spec.ts` — mocked syscall outputs map to expected principals

- `@ccsm/electron` unit:
  - `rpc/clients.spec.ts` — descriptor → transport factory (mocked transports per kind)
  - `rpc/queries.spec.ts` — React Query hook adapters (mock RPC, assert state transitions)
  - `ui/*.spec.tsx` — component-level (React Testing Library)

- `@ccsm/proto` unit:
  - `lock.spec.ts` — every `.proto` file's SHA256 vs a checked-in lockfile (forever-stable enforcement; not a buf-breaking replacement, complements it)
  - `proto/request-meta-validation.spec.ts` — `RequestMeta` field-presence + value-shape validation truth table (chapter [04](./04-proto-and-rpc-surface.md) §3)
  - `proto/open-string-tolerance.spec.ts` — daemon tolerates open-set string values (`client_kind="web"`, `client_kind="rust-cli"`, etc.) without rejection (chapter [04](./04-proto-and-rpc-surface.md) §3 / §7.1)
  - `proto/proto-min-version-truth-table.spec.ts` — proto min-version negotiation matrix (`HelloRequest.proto_min_version` × daemon supported set → accept/reject) (chapter [04](./04-proto-and-rpc-surface.md) §3)
  - `proto/error-detail-roundtrip.spec.ts` — `ErrorDetail` proto round-trips structured `code` / `retryable` fields byte-for-byte (chapter [04](./04-proto-and-rpc-surface.md) §2)
  - `buf-lint` runs in CI

### 3. Integration tests (daemon ↔ Electron over Listener A)

Live in `packages/daemon/test/integration/` and `packages/electron/test/integration/`. Daemon runs in-process (not service-installed) on an ephemeral port / temp UDS path; Electron-side tests use the same Connect client a real renderer uses but driven by Vitest. **All integration test files use the `.spec.ts` extension** (no `.test.ts` — picked once, applied uniformly across chapter 12, chapter 06 §8, and CI invocations in chapter [11](./11-monorepo-layout.md) §6).

Per-RPC coverage criterion (see §6): every RPC declared in chapter [04](./04-proto-and-rpc-surface.md) MUST have at least one happy-path and one error-path integration test. The list below enumerates each:

- `connect-roundtrip.spec.ts` — SessionService happy paths: Hello, ListSessions, CreateSession, GetSession, DestroySession, WatchSessions stream events fire correctly on create/destroy.
- `pty-attach-stream.spec.ts` — PtyService.Attach happy path: create session with a deterministic test claude (`claude-sim --simulate-workload` short variant); Attach with `since_seq=0`; assert receive snapshot then deltas; replay and compare to daemon-side terminal state.
- `pty-reattach.spec.ts` — PtyService.Attach reattach path: record N deltas, disconnect, reattach with `since_seq=N`; assert deltas N+1..M arrive, no duplicates, no gaps.
- `pty-too-far-behind.spec.ts` — PtyService.Attach error path: simulate falling outside retention window, assert daemon falls back to snapshot.
- `pty-sendinput.spec.ts` — PtyService.SendInput happy path (typed bytes echo back as deltas); error path (SendInput on a destroyed session returns `FailedPrecondition`).
- `pty-resize.spec.ts` — PtyService.Resize happy path (resize 80×24 → 120×40 is observed as a Resize delta + snapshot triggered per chapter 06 §4); error path (resize on a destroyed session returns `FailedPrecondition`).
- `peer-cred-rejection.spec.ts` — pins the **two** peer-cred failure scenarios from chapter 03 §5 and chapter 05 §4:
  - **(a) peer-cred resolution failure**: middleware cannot resolve the calling pid → `Unauthenticated`.
  - **(b) peer-cred resolves but owner mismatch**: caller's `principalKey` differs from the session's `owner_id` → `PermissionDenied`.
  - Platform requirement: the OS-syscall path (real second uid binding) requires two real users; runner constraints — runs only on `matrix.os == 'ubuntu-22.04'` self-hosted runner with a pre-provisioned second account (`ccsm-test-other`) created via `useradd` in postinst; on `macos-*` and `windows-*` matrix legs, the test runs against the **mocked peer-cred middleware** (validates the auth chain but not the OS syscall) and is marked `requiresRealPeerCred=false`.
- `version-mismatch.spec.ts` — SessionService.Hello error path: `proto_min_version` higher than daemon's; assert `FailedPrecondition` with structured detail.
- `crash-stream.spec.ts` — CrashService.WatchCrashLog happy path: trigger every capture source via test hooks; assert each emitted.
- `crash-getlog.spec.ts` — CrashService.GetCrashLog happy path (returns latest N rows); error path (`NotFound` for unknown id).
- `settings-roundtrip.spec.ts` — SettingsService.Update + Get happy path: round-trip equal.
- `settings-error.spec.ts` — SettingsService error paths: Update with invalid schema returns `InvalidArgument`; Get on unknown key returns `NotFound`.
- `rpc/clients-transport-matrix.spec.ts` — parameterized over `transport ∈ {h2c-uds, h2c-loopback, h2-tls-loopback, h2-named-pipe}`; for each transport kind in the descriptor enum, construct a Connect transport from a synthesized descriptor and run `Hello`. Guards the MUST-SPIKE fallback paths (chapter [14](./14-risks-and-spikes.md)) so flipping the transport pick after a spike outcome doesn't ship an untested transport.
- `bundle/no-jwt-in-v03.spec.ts` — asserts the built sea bundle does NOT contain the string `jwtValidator` and `import('./jwt-validator')` rejects (file does not exist). Prevents accidental landing of v0.4 JWT middleware in v0.3 bundles (brief §1 mandate); also stands in for the absent `listener-b.ts` (chapter [03](./03-listeners-and-transport.md) §6 — v0.3 ships no listener-b file).

CI runs integration tests on `{ubuntu, macos, windows}` matrix per PR. Integration tests use a **temp file-based** SQLite DB (per-test tmpdir, deleted on teardown); unit tests use `:memory:` (see §2 `db/migrations.spec.ts`).

### 4. The four ship-gate harnesses (brief §11)

#### 4.1 Ship-gate (a): no-IPC grep + ESLint backstop

The grep is the cheap fast layer; the ESLint rule is the sound layer. Both run in CI; either failing blocks merge. The grep catches stray string literals and template-stringy IPC channel names; the ESLint `no-restricted-imports` catches cases where the symbol is renamed or destructured (e.g., `import { ipcMain as M } from "electron"`).

`tools/lint-no-ipc.sh` (canonical script — referenced by chapter [08](./08-electron-client-migration.md) §5h, chapter [11](./11-monorepo-layout.md) §6, and this section; do NOT inline-duplicate the script anywhere else):

```bash
#!/usr/bin/env bash
set -euo pipefail
hits=$(grep -rEn 'contextBridge|ipcMain|ipcRenderer' packages/electron/src \
       --exclude-dir=node_modules --exclude-dir=dist || true)
# F3: optional descriptor-preload allowlist if F2 picks the contextBridge whitelist path.
# When `.no-ipc-allowlist` exists, each line is exactly a path (no line ranges).
# Allowlisted files MUST be < 100 lines so accidental growth is reviewed in PRs.
# Empty / missing file = no allowlist (the gate is unconditional).
if [ -f tools/.no-ipc-allowlist ]; then
  hits=$(echo "$hits" | grep -vFf tools/.no-ipc-allowlist || true)
fi
if [ -n "$hits" ]; then
  echo "FAIL: IPC residue:"; echo "$hits"; exit 1
fi
echo "PASS: zero IPC residue"
```

**v0.3 `tools/.no-ipc-allowlist` contents** are exactly: `packages/electron/src/preload/preload-descriptor.ts` (one line). Any addition is a chapter [15](./15-zero-rework-audit.md) forever-stable touch and requires R4 sign-off.

ESLint backstop in `packages/electron/eslint.config.js` (flat-config v9, matching chapter [11](./11-monorepo-layout.md) §5; enforced in `electron-test` job per chapter [11](./11-monorepo-layout.md) §6):

```js
// F3: closes R4 P0 ch 12 ship-gate (a) — substring grep is unsound for renamed
// imports (e.g., `import { ipcMain as M } from "electron"`); pair the grep
// with a structural rule that catches the import itself, not the usage.
export default [
  {
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{
          name: "electron",
          importNames: ["ipcMain", "ipcRenderer", "contextBridge"],
          message: "v0.3 forbids ipcMain / ipcRenderer / contextBridge — see chapter 08 §5; sanctioned exceptions go through tools/.no-ipc-allowlist (descriptor preload only).",
        }],
      }],
    },
  },
];
```

Wired into `electron-test` job (per [11](./11-monorepo-layout.md) §6) as TWO sequential steps (grep then ESLint rule); both must pass; either failing blocks merge.

#### 4.2 Ship-gate (b): daemon survives Electron SIGKILL

Canonical test file: `packages/electron/test/e2e/sigkill-reattach.spec.ts` (Playwright for Electron + per-OS kill helper). Chapter [08](./08-electron-client-migration.md) §7 references this file path; chapter [13](./13-release-slicing.md) phase 11 also references it. This is the single source of truth for ship-gate (b)'s test name and path.

1. Boot daemon. **Per-PR variant**: spawn the daemon as a real OS subprocess in its own process group (`spawn(process.execPath, ['-e', "require('@ccsm/daemon').main()"], { detached: true, stdio: 'pipe' })` on POSIX; `spawn(... , { windowsHide: true, detached: true })` + `CREATE_NEW_PROCESS_GROUP` on Windows). The in-process Worker variant is forbidden because `taskkill /F /IM electron.exe` (and `kill -9` of the Electron PID group on POSIX) can reap a fused daemon Worker, masking the failure mode the gate is meant to catch. **Nightly variant**: service-installed daemon (separate process tree by definition).
2. Launch Electron via Playwright; create 3 sessions; wait for `RUNNING`; for each, attach and read 100 deltas; record (a) last applied seq per session and (b) a snapshot of each client-side xterm-headless terminal after applying the 100 deltas (kept in memory for the byte-equality assertion in step 7).
3. Kill the Electron main PID with `taskkill /F` (win) / `kill -9` (mac/linux). On POSIX the Electron PID is killed; the daemon, in a separate process group from step 1, is unaffected.
4. Verify `curl <supervisor>/healthz` returns 200; verify `claude` PIDs still alive (`tasklist` / `ps`).
5. Relaunch Electron via Playwright; wait for `Hello`; verify the 3 sessions appear in `ListSessions`.
6. For each session, attach with the recorded last applied seq; assert receive deltas with `seq > recorded` immediately, no gaps. If the gap delta count `< DELTA_RETENTION_SEQS` (currently 4096), reattach receives those deltas without a `snapshot` frame; if `>= DELTA_RETENTION_SEQS`, a `snapshot` frame is expected. Step 7's byte-equality assertion is the load-bearing gate regardless of which path is taken.
7. **Byte-equality "no data loss" assertion** (closes brief §11(b) "no data loss" — gate (b) without this passes vacuously when seq is monotonic but bytes are corrupt):
   - On the daemon side: serialize the current xterm-headless terminal state for each session via the SnapshotV1 encoder (encoder determinism pinned in chapter [06](./06-pty-snapshot-delta.md) §2; see §4.3 below).
   - On the client side: replay all received frames (the recorded snapshot from step 2 + every delta received in steps 2 and 6) into a fresh xterm-headless `Terminal` instance, then serialize via the same SnapshotV1 encoder.
   - Assert `Buffer.compare(daemon.snap, client.snap) === 0` for every session. This is the same comparator gate (c) uses; gate (b) reuses it as a 30-second variant.

Pass criterion: all assertions hold (sessions intact + PTY children alive + delta continuation + byte-equality). CI: per-PR (subprocess daemon) + nightly (service-installed).

#### 4.3 Ship-gate (c): 1-hour PTY zero-loss soak

Specified in [06](./06-pty-snapshot-delta.md) §8. **Canonical test name `pty-soak-1h`** at canonical path `packages/daemon/test/integration/pty-soak-1h.spec.ts` (single source of truth — chapter 06 §8 and chapter 11 §6's `pnpm run test:pty-soak` invocation MUST resolve to this file). Electron-side reattach companion: `packages/electron/test/e2e/pty-soak-reconnect.spec.ts`.

**Comparator algorithm**: at the end of the 1-hour run, encode the daemon-side xterm-headless terminal state via SnapshotV1 and the client-side replayed terminal state via SnapshotV1; assert `Buffer.compare === 0`. This requires SnapshotV1 encoder determinism — pinned in chapter [06](./06-pty-snapshot-delta.md) §2 (palette entries appended in order of first appearance during a stable left-to-right top-to-bottom cell scan; modes_bitmap bit positions enumerated; field ordering fixed). If chapter 06 §2 ever loosens determinism, this gate becomes meaningless — chapter [15](./15-zero-rework-audit.md) audit MUST flag.

**Workload class enumeration** (the canned 60-minute script `claude-sim --simulate-workload 60m` MUST exercise every class below; missing a class makes the gate pass vacuously on toy workloads):

| Class | Concrete sequences | Why required |
| --- | --- | --- |
| UTF-8 / CJK / mixed-script | 3-byte and 4-byte UTF-8; CJK wide cells; combining marks; RTL bidi | wide-char and grapheme handling are top sources of snapshot drift |
| 256-color + truecolor + SGR | SGR 38;5;n / 38;2;r;g;b; SGR resets; bold/italic/underline | exercises `attrs_palette` ordering determinism |
| Cursor positioning | CUP, CUU, CUD, CUF, CUB; save/restore | exercises cursor field |
| Alt-screen toggles | DECSET 1049 enter / exit (vim simulator phase) | exercises alt-screen + scrollback partition |
| Bursts and idles | 1 MB in 50 ms burst; 30 s idle gap; mixed cadence | exercises delta segmenter (chapter 06 §3) under both pressure and starvation |
| **OSC sequences** | OSC 0/2 (window title), OSC 8 (hyperlink) | xterm-headless tracks title; if SnapshotV1 doesn't encode title the gate's "binary-identical to truth" claim is bounded — coverage of these MUST either round-trip equal or be explicitly listed in chapter 06 §2 as out-of-snapshot non-coverage |
| **DECSTBM scroll regions** | CSI Pt;Pb r (used by less / more / vim) | scroll region state must be in snapshot or the comparator fails after a `less` phase |
| **Mouse mode toggles** | DEC private modes 1000, 1002, 1003, 1006 | `modes_bitmap` claims to track these — chapter 06 §2 enumerates bit positions; soak MUST toggle each |
| **Resize during burst** | SIGWINCH mid-burst + a Resize RPC mid-burst | snapshot-on-resize cadence (chapter 06 §4); real Electron users resize, this is not a synthetic concern |
| Out-of-scope (documented) | Kitty graphics protocol, sixel | `claude` does not currently emit images; explicitly non-covered |

**SendInput p99 sampling** (closes "perf budgets do NOT block PRs" gap from §7): the soak harness samples `SendInput` RTT once per second over the 1-hour window and asserts `p99 < 5 ms`. SendInput typing-latency regressions therefore block ship via gate (c) rather than waiting for the next morning's nightly perf bench. Other §7 budgets (Hello RTT, cold start, snapshot encode, RSS) remain advisory.

**Self-hosted runner constraint**: 1-hour budget; soak runs on a self-hosted runner labeled `self-hosted-soak-linux` (and Windows / macOS equivalents per chapter 11 §6). Sole occupancy required for the run window so background CPU contention doesn't introduce timing flakes.

**CI orchestration**: nightly schedule + opt-in via `[soak]` token in commit message. **Non-blocking for PRs** (regressions caught the next morning); **blocking for release tags** via the explicit release procedure pinned in chapter [13](./13-release-slicing.md) §5 — at tag time, an on-demand soak run is triggered; the tag is promoted only after the soak run on that exact commit is green. This removes the "same commit never simultaneously green" race noted in R4.

**macOS hang-detection note**: on macOS, no kernel watchdog reaps a hung daemon (per chapter [09](./09-crash-collector.md) §6 — macOS watchdog deferred to v0.4 hardening). A stalled stream observed during the 1h soak is interpreted as a daemon hang and fails the gate; the operator MUST `ps -p` + `sample` the daemon before the next attempt.

#### 4.4 Ship-gate (d): clean installer round-trip on Win 11 25H2

`test/installer-roundtrip.ps1` runs on a self-hosted Win 11 25H2 VM (snapshotted to a clean state before each run). The VM image is provisioned and maintained per chapter [13](./13-release-slicing.md) phase 11(d) precondition; **GitHub-hosted `windows-latest` is NOT 25H2** (currently Server 2022) so the VM is a hard prerequisite, not optional. Runner label: `self-hosted-win11-25h2-vm`.

The check is a **file-tree + registry diff** (snapshot before install, snapshot after uninstall, diff against a documented allowlist) — not a fixed list of expected leftover locations. Fixed-list checks pass when residue lands in an unexpected location; diff-based checks fail closed.

```powershell
# pseudo-flow — chapter 10 §5 step 4 promises BOTH REMOVEUSERDATA variants are
# exercised under ship-gate (d); loop over both, restoring the snapshot between
# variants so each begins from a clean baseline.
$variants = @('=0', '=1')
foreach ($removeUserData in $variants) {
Invoke-Snapshot-Restore "win11-25h2-clean"

# 1. Pre-install baseline: full file-tree + registry export
Get-ChildItem -Recurse -Force `
  "$env:ProgramFiles","$env:ProgramData","$env:LOCALAPPDATA","$env:APPDATA","$env:TEMP" `
  | Select-Object FullName | Out-File C:\install\fs-pre.txt
reg export HKLM C:\install\hklm-pre.reg /y
reg export HKCU C:\install\hkcu-pre.reg /y
Get-ScheduledTask | Select-Object TaskName,TaskPath | Out-File C:\install\tasks-pre.txt

# 2. Install
Copy-Item ".\artifacts\ccsm-setup-*.msi" "C:\install\"
Start-Process -Wait msiexec -ArgumentList "/i C:\install\ccsm-setup.msi /qn /l*v C:\install\install.log"

# 3. Verify the service is actually serving (Service Manager 'Running' is necessary but not sufficient)
$svc = Get-Service ccsm-daemon
if ($svc.Status -ne 'Running') { throw "service not running" }
# Read Listener A address from the file the daemon writes (do NOT hardcode — fresh VM has no prior state)
$listenerA = Get-Content "$env:ProgramData\ccsm\listener-a.json" | ConvertFrom-Json
$ok = Invoke-WebRequest -UseBasicParsing $listenerA.healthzUrl
if ($ok.StatusCode -ne 200) { throw "supervisor /healthz not 200" }
# Optional: smoke a Hello RPC against Listener A using a built test client
& C:\install\ccsm-test-client.exe hello

# 4. Launch electron, smoke-create a session, smoke-destroy
& "$env:ProgramFiles\ccsm\ccsm.exe" --test-mode --smoke

# 5. Uninstall — variant-specific REMOVEUSERDATA value drives chapter 10 §5 step 4 matrix
Start-Process -Wait msiexec -ArgumentList "/x C:\install\ccsm-setup.msi REMOVEUSERDATA$removeUserData /qn /l*v C:\install\uninstall.log"

# 6. Post-uninstall snapshot + diff
Get-ChildItem -Recurse -Force `
  "$env:ProgramFiles","$env:ProgramData","$env:LOCALAPPDATA","$env:APPDATA","$env:TEMP" `
  | Select-Object FullName | Out-File C:\install\fs-post.txt
reg export HKLM C:\install\hklm-post.reg /y
reg export HKCU C:\install\hkcu-post.reg /y
Get-ScheduledTask | Select-Object TaskName,TaskPath | Out-File C:\install\tasks-post.txt

# 7. Diff: only items on `test/installer-residue-allowlist.txt` may differ.
#    The allowlist enumerates OS-induced churn during the test window
#    (e.g., Windows Update tracking files, ETW session logs, Defender scan history).
$fsDiff    = Compare-Object (Get-Content C:\install\fs-pre.txt)    (Get-Content C:\install\fs-post.txt)    | Where-Object SideIndicator -eq '=>'
$hklmDiff  = Compare-Object (Get-Content C:\install\hklm-pre.reg)  (Get-Content C:\install\hklm-post.reg)  | Where-Object SideIndicator -eq '=>'
$hkcuDiff  = Compare-Object (Get-Content C:\install\hkcu-pre.reg)  (Get-Content C:\install\hkcu-post.reg)  | Where-Object SideIndicator -eq '=>'
$taskDiff  = Compare-Object (Get-Content C:\install\tasks-pre.txt) (Get-Content C:\install\tasks-post.txt) | Where-Object SideIndicator -eq '=>'
$allowlist = Get-Content "test\installer-residue-allowlist.txt"

$residue = @($fsDiff,$hklmDiff,$hkcuDiff,$taskDiff) | ForEach-Object { $_.InputObject } `
           | Where-Object { $entry = $_; -not ($allowlist | Where-Object { $entry -match $_ }) }

if ($residue.Count -gt 0) {
  throw "Uninstall residue (REMOVEUSERDATA$removeUserData, not on allowlist):`n$($residue -join "`n")"
}
}
```

CI: nightly schedule + on-tag.

**Mac and linux do NOT have a ship-gate (d) equivalent in v0.3.** Brief §11(d) is Windows-specific; mac/linux installers are tested manually before release per brief §11(d) clarification (results posted to release notes). An `installer-roundtrip.sh` script may be drafted in parallel for future use, but it is NOT a v0.3 ship-gate — the ship-gate set is intentionally asymmetric across OSes.

### 5. Test data: deterministic claude CLI

For PTY tests we cannot use the real `claude` (network, model nondeterminism). We ship a test build `claude-sim` in `packages/daemon/test/fixtures/claude-sim/`:

- Reads a script file (path via `--simulate-workload-script`) of `(delay_ms, hex_bytes)` pairs.
- Writes the bytes to stdout with the specified delays.
- Honors a `--simulate-workload 60m` shortcut that runs a canned 60-minute script (covering every workload class enumerated in §4.3) used by ship-gate (c).
- Produces stable byte-by-byte identical output across runs.

**Source language: Go** (picked over Rust for cross-platform-cross-arch ease — `GOOS`/`GOARCH` matrix is trivial; Rust would need `cross` or per-target runners and adds toolchain cost). Source lives in `packages/daemon/test/fixtures/claude-sim/` (Go module rooted there). **Vendoring policy**: source is committed; binary is **NOT** committed — it is built in CI as a step of the daemon test job (`go build -o claude-sim[.exe] ./...` for each `{linux,darwin,windows} × {amd64,arm64}`) and the resulting binary is placed in `packages/daemon/test/fixtures/claude-sim/bin/<goos>-<goarch>/`. This avoids polluting clones with multi-arch binaries (no need for git-LFS) and avoids the chapter [11](./11-monorepo-layout.md) §2 `.gitattributes` LFS question entirely.

> Coordination note for chapter [11](./11-monorepo-layout.md) §2 (owned by F9): chapter 11 §2's directory layout MUST list `packages/daemon/test/fixtures/claude-sim/` as a Go module sub-tree (committed source) with a `.gitignore` entry for `bin/` (build artifacts not committed). chapter 11 §6 CI matrix MUST include the `go build` step before the daemon test job (Go toolchain `1.22+` on all three runner OSes — `setup-go@v5`).

**Script file format** (for authors adding new soak workloads, e.g., an OSC-8 case): the `--simulate-workload-script <path>` file is **JSON Lines** (`.jsonl`); each line is `{"delay_ms": <integer>, "hex": "<lowercase-hex>"}`. Comments allowed via lines starting with `#`. Example:

```jsonl
# OSC 0 set window title to "build"
{"delay_ms": 0, "hex": "1b5d303b6275696c641b5c"}
# 200 ms idle, then SGR red + "ERR" + reset
{"delay_ms": 200, "hex": "1b5b33316d4552521b5b306d"}
```

Workload class coverage MUST be cross-checked against §4.3's table (file-tree review on PRs that touch `claude-sim` fixtures includes a manual class-coverage check; a missing class in the canned 60-minute script is a P0 ship-gate (c) bug).

### 6. Coverage target

- Unit: 80% line coverage on `@ccsm/daemon/src` (excluding `dist/`, `gen/`, `test/`).
- Integration: not measured by line coverage; measured by RPC coverage — every RPC in [04](./04-proto-and-rpc-surface.md) MUST have at least one integration test exercising the happy path and at least one exercising an error path. The §3 integration test list above enumerates each (Resize, GetCrashLog, SettingsService error-paths included).
- Electron renderer: 60% line coverage on `src/renderer/`. UI-shell code (windowing, tray) is untested.

**Enforcement**: thresholds **ARE enforced in CI**. The `pnpm --filter @ccsm/daemon run coverage` step fails the PR if line coverage on `@ccsm/daemon/src` falls below 80%; the `pnpm --filter @ccsm/electron run coverage` step fails the PR if line coverage on `src/renderer/` falls below 60%. Vitest config exclusion of `dist/`, `gen/`, `test/` is wired in `packages/daemon/vitest.config.ts` (`coverage.exclude`); chapter [11](./11-monorepo-layout.md) §6's `daemon-test` and `electron-test` jobs include the coverage step. The repo-root `vitest.config.ts`'s legacy advisory thresholds (60/60/50/60, "NOT enforced in CI yet") are superseded by these per-package enforced thresholds.

### 7. Performance budgets (regressions = test failures)

| Metric | Budget | Enforced by |
| --- | --- | --- |
| Daemon cold start to Listener A bind | < 500 ms (no sessions) / < 2 s (50 sessions to restore) | `bench/cold-start.spec.ts` |
| `Hello` RPC RTT over Listener A | < 5 ms p99 (loopback) | `bench/hello-rtt.spec.ts` |
| `SendInput` RTT | < 5 ms p99 | `bench/sendinput-rtt.spec.ts` (advisory) **AND** sampled-during-soak in `pty-soak-1h.spec.ts` (blocking via gate (c) — see §4.3) |
| Snapshot encode (80×24 + 10k scrollback) | < 50 ms | `bench/snapshot-encode.spec.ts` |
| Daemon RSS at idle (5 sessions) | < 200 MB | nightly `bench/rss.spec.ts` |

Bench files live in `packages/daemon/test/bench/` (added to chapter [11](./11-monorepo-layout.md) §2 directory layout).

Benchmarks run nightly; **budgets do NOT block PRs by themselves** (too noisy in CI; manual triage gates ship) **EXCEPT** the `SendInput` p99 budget, which gates ship via gate (c) sampled-during-soak (see §4.3) so typing-latency regressions cannot ship unnoticed. Other budget regressions open an issue tagged `perf-regression` for manual triage before tagging.

### 8. v0.4 delta

- **Add** integration tests for Listener B JWT path with mock cf-access tokens.
- **Add** web/iOS package test suites (their own runners; do not change daemon tests).
- **Add** ship-gate (e): "v0.4 web client connects through CF Tunnel and survives daemon restart" — additive harness.
- **Unchanged**: Vitest + Playwright choice, the four v0.3 ship-gate harnesses (still gate v0.4 ships too — additivity), test data `claude-sim`, coverage targets, performance budgets.
