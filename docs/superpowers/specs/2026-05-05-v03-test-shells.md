# v0.3 test shells (skip-first ship-gate)

**Date**: 2026-05-05
**Status**: planning artifact for v0.3 test rebuild after PR #1092 wipe
**Predecessor**: `2026-05-03-v03-daemon-split-design.md` (defines ship-gate (a)/(b)/(c)/(d) + dogfood)
**Workflow**: write all shells as `it.skip("...")` first → per implementation step a dev unskips its slice + makes it pass → all green = ship-gate met → enter dogfood

## How to read this file

Each row pins ONE skipped test. Columns:
- **File** — repo-relative path. Use existing dirs where present (`packages/daemon/test/integration/`, `packages/electron/test/e2e/`); create new files here.
- **`it("...")`** — canonical name. Verbatim. Dev must not rename when unskipping.
- **Shape** — one line: input → assertion. No optional behavior.
- **Covers** — which v0.3 ship-gate clause / dogfood metric / RPC method this shell verifies. Ground-truth in `2026-05-03-v03-daemon-split-design.md`.

Rules:
- All shells start as `it.skip(...)`. Empty body OR `expect.fail("not implemented")`. Both are vitest-zero-execution.
- No `describe.skip(...)` umbrellas. Skip MUST be at `it`-level so per-step unskip is one-line.
- No fixture files yet. Each shell row says what fixture is needed; the implementing step creates it.
- Do NOT add a shell unless it maps to a ship-gate clause OR to a dogfood metric below. We are shipping v0.3, not retrofitting v0.2 coverage.

## Ship-gate / dogfood reference (frozen here for traceability)

From `2026-05-03-v03-daemon-split-design.md` and the v0.3 ship intent memo:

- **(a)** `packages/electron/src/` has zero `contextBridge` / `ipcMain` / `ipcRenderer` references; all IPC goes through Connect-RPC against Listener A.
- **(b)** Daemon SIGKILL + restart mid-session → reattach → byte-identical xterm state.
- **(c)** 1-hour `claude` workload + 3 Electron SIGKILLs (t=10m/25m/40m) → byte-identical replay; ≤ 250 MB / 60 min wire budget.
- **(d)** Clean MSI install → run → uninstall leaves no service, no `%ProgramData%\ccsm`, no orphan PTY processes.

Dogfood:
- **Set A** (CI gate, Windows runner): cold-boot to first prompt ≤ 5s; SIGKILL-reattach byte-equality; MSI install/uninstall round-trip.
- **Set B** (informational bench, not CI gate): 1h soak metrics (RSS, wire bytes, snapshot delta sizes). Reported, not asserted as pass/fail.

---

## 1. Boot e2e

Goal: real `_electron.launch` brings up the renderer + connects to a real daemon over Listener A. No mocked transport.

| File | `it("...")` | Shape | Covers |
|---|---|---|---|
| `packages/electron/test/e2e/boot.spec.ts` | `boots renderer and reaches "ready" within 5s` | launch electron → wait for `data-boot-state="ready"` in renderer DOM → assert wall-clock ≤ 5s | dogfood Set A cold-boot |
| `packages/electron/test/e2e/boot.spec.ts` | `Hello round-trip succeeds against real daemon listener A` | launch → renderer fires `Hello` → assert response carries `daemon_version`, `proto_version`, non-empty `principal`, non-empty `listener_id` | ship-gate (a) — Electron talks to daemon only over Connect |
| `packages/electron/test/e2e/boot.spec.ts` | `daemon-not-running modal renders when daemon absent` | stop daemon before launch → renderer shows `data-modal="daemon-not-running"` within 3s; no crash | ship-gate (a) renderer error path |
| `packages/electron/test/e2e/boot.spec.ts` | `version negotiation rejects too-old daemon with structured error` | spawn daemon stub returning `proto_version` < renderer's baseline → renderer shows version-mismatch UI; no silent retry loop | ch04 §3 version negotiation |

Fixture needed: `packages/electron/test/e2e/helpers/launch.ts` (real `_electron.launch` + cleanup) and `helpers/fake-daemon.ts` (stub that responds with controllable `Hello`). Created by step that unskips first row.

## 2. RPC full chain (SendInput / Resize / CheckClaudeAvailable)

Goal for each RPC: (i) handler unit test, (ii) Connect-roundtrip integration test (real h2c loopback / UDS), (iii) renderer-side hook test against real client. All three layers must pass to call the RPC "v0.3 done".

### 2.1 SendInput

| File | `it("...")` | Shape | Covers |
|---|---|---|---|
| `packages/daemon/src/rpc/__tests__/pty-sendinput-handler.spec.ts` | `forwards utf-8 bytes to pty-host writer in order` | construct handler with fake pty-host → call with 3 chunks → assert pty-host `write()` saw exact concatenation in call order | RPC handler correctness |
| `packages/daemon/src/rpc/__tests__/pty-sendinput-handler.spec.ts` | `rejects with NOT_FOUND when sid is unknown` | call with sid not in registry → assert ConnectError code = `NOT_FOUND`, no write | error contract |
| `packages/daemon/src/rpc/__tests__/pty-sendinput-handler.spec.ts` | `rejects with PERMISSION_DENIED when principal mismatch` | call with sid owned by other principal → assert PERMISSION_DENIED | ch03 auth |
| `packages/daemon/test/integration/rpc/pty-sendinput.spec.ts` | `Connect roundtrip writes bytes to live pty-host and is read back via Attach stream` | spawn real daemon over loopback → start session → SendInput "echo hi\n" → Attach stream observes "echo hi" then "hi" within 2s | end-to-end Connect-RPC |
| `packages/electron/src/renderer/connection/__tests__/use-send-input.spec.ts` | `useSendInput dispatches against real Connect client and resolves` | mount hook with real ConnectionProvider pointing at fake daemon → call `sendInput("x")` → assert promise resolves and request count = 1 | ship-gate (a) renderer hook |

### 2.2 Resize

| File | `it("...")` | Shape | Covers |
|---|---|---|---|
| `packages/daemon/src/rpc/__tests__/pty-resize-handler.spec.ts` | `forwards (cols, rows) to pty-host resize()` | call with (cols=120, rows=40) → assert pty-host `resize(120, 40)` called once | handler |
| `packages/daemon/src/rpc/__tests__/pty-resize-handler.spec.ts` | `rejects with INVALID_ARGUMENT when cols/rows ≤ 0` | call (0, 24) and (80, -1) → both ConnectError INVALID_ARGUMENT, no resize | input validation |
| `packages/daemon/src/rpc/__tests__/pty-resize-handler.spec.ts` | `rejects with NOT_FOUND when sid is unknown` | unknown sid → NOT_FOUND | error contract |
| `packages/daemon/test/integration/rpc/pty-resize.spec.ts` | `Connect roundtrip resizes live pty and SIGWINCH reaches child` | start session running `tput cols`-like probe → Resize(100, 30) → assert next prompt reflects new size | end-to-end |
| `packages/electron/src/renderer/connection/__tests__/use-resize.spec.ts` | `useResize debounces rapid resizes and sends final dimensions only` | drive 5 resize events in 50ms → assert exactly 1 RPC sent with last (cols, rows) | renderer hook + debounce contract |

### 2.3 CheckClaudeAvailable

| File | `it("...")` | Shape | Covers |
|---|---|---|---|
| `packages/daemon/src/rpc/__tests__/check-claude-available-handler.spec.ts` | `returns available=true with version when claude on PATH` | stub resolver returning `/usr/local/bin/claude` + version `1.2.3` → response `{available: true, path, version: "1.2.3"}` | handler happy path |
| `packages/daemon/src/rpc/__tests__/check-claude-available-handler.spec.ts` | `returns available=false with reason when binary missing` | stub resolver returning null → response `{available: false, reason: "not_on_path"}`, no throw | handler not-found path |
| `packages/daemon/src/rpc/__tests__/check-claude-available-handler.spec.ts` | `returns available=false with reason when version probe times out` | stub resolver that hangs → handler enforces 2s timeout → response `{available: false, reason: "probe_timeout"}` | handler timeout path |
| `packages/daemon/test/integration/rpc/check-claude-available.spec.ts` | `Connect roundtrip reports real claude binary status on this host` | spawn real daemon → call once → assert response shape (booleans + strings); does not assert the boolean value (host-dependent) | end-to-end shape |
| `packages/electron/src/renderer/connection/__tests__/use-check-claude-available.spec.ts` | `hook surfaces unavailable state and renders ClaudeMissingModal` | mock client returning `available: false` → render component using hook → assert modal mounts within 1 tick | ship-gate (a) renderer UX |

## 3. UI thin-client e2e

Goal: with a real daemon + real renderer, drive the app like a user and assert the visible result. No transport mocks.

| File | `it("...")` | Shape | Covers |
|---|---|---|---|
| `packages/electron/test/e2e/thin-client.spec.ts` | `creates new session and shows prompt within 3s` | launch → click "New session" → assert xterm canvas shows non-empty content within 3s | ship-gate (a) end-to-end |
| `packages/electron/test/e2e/thin-client.spec.ts` | `typed input renders on screen via real PTY echo` | launch → new session → type "echo hello" + Enter → assert "hello" appears in xterm within 2s | SendInput + Attach roundtrip |
| `packages/electron/test/e2e/thin-client.spec.ts` | `window resize triggers Resize RPC and reflows xterm` | launch → resize BrowserWindow 800×600 → 1200×800 → assert pty cols/rows match new viewport within 500ms | Resize wired |
| `packages/electron/test/e2e/thin-client.spec.ts` | `closing window terminates pty subprocesses on this host` | launch → start session → close window → wait 2s → assert no `claude` process owned by us survives | ship-gate (d) cleanup hint |

Note: this file replaces the v0.4-deferred `pty-soak-reconnect.spec.ts` for v0.3 user-visible coverage. Soak goes in §6 Set B.

## 4. Installer (MSI install / uninstall)

Goal: a real MSI is built, installed, the daemon service starts, the app works, uninstall leaves no residue. Windows-only; gated on `process.platform === "win32"`.

| File | `it("...")` | Shape | Covers |
|---|---|---|---|
| `packages/daemon/build/__tests__/msi-install.spec.ts` | `msiexec /i installs ccsm-daemon service and starts it` | run `msiexec /i ccsm-*.msi /qn /l*v install.log` → assert exit 0 → `sc query ccsm-daemon` shows STATE = RUNNING within 30s | ship-gate (d) install |
| `packages/daemon/build/__tests__/msi-install.spec.ts` | `installed daemon answers Hello over Listener A within 5s of service start` | post-install: read `%ProgramData%\ccsm\listener-a.json` → connect → Hello → assert success | ship-gate (a) post-install |
| `packages/daemon/build/__tests__/msi-uninstall.spec.ts` | `msiexec /x removes service and %ProgramData%\\ccsm tree` | uninstall → assert `sc query` returns 1060 (service does not exist) → assert `%ProgramData%\ccsm` does not exist | ship-gate (d) uninstall |
| `packages/daemon/build/__tests__/msi-uninstall.spec.ts` | `uninstall reaps orphan claude pty subprocesses` | install → start session running `claude` → uninstall → assert no `claude.exe` owned by SYSTEM survives within 10s | ship-gate (d) cleanup |

Fixture needed: a freshly-built MSI in `packages/daemon/build/dist/`. Step that unskips first row wires CI to build before running.

## 5. Sigkill-reattach (v0.3 must-fix)

Goal: ship-gate (b) and (c) — both daemon-restart and electron-restart variants — produce byte-identical xterm state on reattach. This is the single hardest v0.3 requirement and the historical PR (#516 etc.) push-back was about not deferring it.

| File | `it("...")` | Shape | Covers |
|---|---|---|---|
| `packages/electron/test/e2e/sigkill-reattach.spec.ts` | `Electron SIGKILL mid-session reattaches with byte-identical xterm screen state` | launch → start session → drive workload to fill scrollback → SIGKILL Electron → relaunch → reattach → encode SnapshotV1 of new xterm → assert bytes equal pre-kill snapshot | ship-gate (b) electron variant |
| `packages/electron/test/e2e/sigkill-reattach.spec.ts` | `daemon SIGKILL mid-session reattaches with byte-identical xterm screen state` | launch → start session → drive workload → SIGKILL daemon process → wait for service auto-restart → reattach → assert SnapshotV1 byte-equal | ship-gate (b) daemon variant |
| `packages/electron/test/e2e/sigkill-reattach.spec.ts` | `triple Electron SIGKILL at t=10m/25m/40m of 1h workload yields byte-identical replay` | drive 1h `claude` workload → SIGKILL Electron at 10/25/40 min → after each restart re-encode and assert byte-equal to pre-kill checkpoint | ship-gate (c) full scenario (reduced fixture timing OK in CI; full 1h in nightly Set B §6) |
| `packages/daemon/test/integration/pty-daemon-restart-replay.spec.ts` | `daemon restart mid-session replays delta log to byte-identical state` | start session → take SnapshotV1 → restart daemon → on reattach replay deltas from delta log → assert decoded xterm state encodes byte-equal | ship-gate (b) daemon-replay path; pure daemon-side, no electron |

Fixture needed: deterministic workload generator (`packages/electron/test/e2e/helpers/workload.ts`) producing reproducible mixed UTF-8 / CJK / RTL output. Created by the step that unskips the first row.

## 6. Dogfood — Set A (CI gate) + Set B (informational bench)

### 6.1 Set A — CI gate. PASS/FAIL.

| File | `it("...")` | Shape | Covers |
|---|---|---|---|
| `packages/electron/test/e2e/dogfood-set-a.spec.ts` | `cold boot to first prompt ≤ 5000ms on this CI host` | launch from cold start → measure t until renderer shows ready prompt → assert ≤ 5000ms | dogfood A.1 |
| `packages/electron/test/e2e/dogfood-set-a.spec.ts` | `MSI install + run + uninstall round-trip exits clean` | run install spec, run boot spec, run uninstall spec sequentially → assert each step exit 0 | dogfood A.2 |
| `packages/electron/test/e2e/dogfood-set-a.spec.ts` | `SIGKILL-reattach byte-equality holds on this CI host` | run reduced (2-min) workload + 1 SIGKILL → assert byte-equal | dogfood A.3 (CI-feasible subset of §5) |

### 6.2 Set B — informational bench. Report metrics; do not assert pass/fail.

These shells emit metrics to a file and `expect(true).toBe(true)`. The build pipeline reads the file and posts the numbers (no gate).

| File | `it("...")` | Shape | Covers |
|---|---|---|---|
| `packages/daemon/test/bench/dogfood-set-b.spec.ts` | `1h soak: report RSS high-water-mark` | run 1h workload → record `process.memoryUsage().rss` peak → write to `bench-out/rss.json` → no assertion | dogfood B.1 |
| `packages/daemon/test/bench/dogfood-set-b.spec.ts` | `1h soak: report total wire bytes Listener A → renderer` | run 1h workload → instrument Connect transport byte counter → write `bench-out/wire-bytes.json` → no assertion (design budget 250 MB is tracked, not enforced here) | dogfood B.2 |
| `packages/daemon/test/bench/dogfood-set-b.spec.ts` | `1h soak: report SnapshotV1 size distribution (p50/p95/max)` | run 1h workload → on every snapshot record `screen_state` byte length → write `bench-out/snapshot-sizes.json` → no assertion | dogfood B.3 |

Set B runs in nightly job, NOT per-PR.

---

## Skip discipline

- Use `it.skip("name", () => { /* TODO step <N> */ })`. Empty arrow body. No `describe.skip`.
- No `it.todo` — vitest renders it.todo as a separate "todo" line which we do not want polluting the report.
- When a step unskips a row, it MUST also delete any `// TODO step N` comment so the file stays in sync.
- Per-package vitest configs already have `passWithNoTests: true` (PR #1092). Adding `it.skip` shells re-enables collection but counts them as "skipped" — vitest report will show e.g. `Tests  18 skipped`. That is the intended steady-state until step 4 starts unskipping.

## Out of scope for v0.3 (do NOT add shells here)

- Web frontend (v0.4 #215)
- iOS / cf-tunnel transport (v0.4)
- Multi-principal helpers (v0.4)
- Crash-reporting backfill, settings-store contract sweep, eslint-backstop suite — these were deleted by PR #1092 by design (v0.3 ship intent: refactor-only, no feature backfill)

## Step → unskip mapping (filled by step 3 plan, draft)

To be elaborated when the v0.3 ship implementation high-level steps land. Skeleton:
- Step 3.1 (RPC handlers landed) → unskip §2 handler rows
- Step 3.2 (Connect-roundtrip wired) → unskip §2 integration rows + §1 row 2
- Step 3.3 (renderer hooks cut over) → unskip §2 hook rows + §1 row 1, 3, 4
- Step 3.4 (snapshot codec re-locked) → unskip §5 daemon-replay row
- Step 3.5 (electron e2e wired) → unskip §3 + §5 electron rows
- Step 3.6 (MSI build + install scripts) → unskip §4
- Step 3.7 (dogfood harness) → unskip §6.1; arm §6.2 in nightly job
