# 12 — Testing Strategy — R4 (Testability + Ship-Gate Coverage)

Angle: every brief §11 ship-gate must have a mechanical, automatable check; every component must have named unit/integration/E2E scopes; every MUST-SPIKE must have repro + kill criterion; performance and property tests must be pinned. This chapter is the focal point for R4 — most P0/P1 findings live here.

## P0 — Ship-gate (a) grep is mis-specified; will produce false negatives AND lacks an exclusion mechanism

§4.1 ships `tools/lint-no-ipc.sh` with grep pattern `'contextBridge|ipcMain|ipcRenderer'`. Three concrete failures:

1. **No word boundary**. Pattern matches inside identifiers, comments, strings — fine for over-match. But also matches `ipcMainHandler` in a license header / changelog / a TS comment quoting "ipcMain" in a deprecation notice. Spec says (brief §11(a) and chapter 08 §5h) "or only in dead-code paths flagged for removal", but `tools/lint-no-ipc.sh` has **no exclusion list mechanism**. The script is `grep || true; if non-empty fail`. There is no way to ship a comment like `// migrated away from ipcMain in #PR-xxx` without breaking CI. Either:
   - Spec MUST pin a `.no-ipc-allowlist` file (path + line-range or substring) and have the script subtract those, OR
   - Spec MUST forbid the substrings entirely in source (no allowlist) — but then chapter 08 §5h's "git rm" promise must be airtight and the migration PR cannot leave any reference even in comments.
2. **`grep -r`** without `--include='*.ts' --include='*.tsx'` will scan `node_modules` (the `--exclude-dir=node_modules` is present, good) but ALSO `.json`, `.md`, `.yml`, `package-lock.json`. The `package.json` will contain `"electron": "..."` — fine — but if anyone mentions ipcMain in a README or CHANGELOG inside `packages/electron/src` (unlikely but possible), gate breaks for non-load-bearing reasons. Pin file extensions.
3. **No ESLint backstop**. Brief asks for `eslint-no-restricted-imports` for electron's ipc surface. Chapter 12 mentions ESLint forbidden-imports for inter-package boundaries (§5 of 11) but does NOT specify a `no-restricted-imports` rule blocking `import { ipcMain } from 'electron'` and `import { contextBridge } from 'electron'` and `import { ipcRenderer } from 'electron'` in `packages/electron/src/renderer/` and `packages/electron/src/main/`. A grep-only gate misses imports under aliases (`import * as e from 'electron'; e.ipcMain.handle(...)` → grep matches `ipcMain.handle` substring? Only because the call site contains `ipcMain` literal; if someone does `const im = e.ipcMain; im.handle(...)` the grep MISSES). ESLint's `no-restricted-syntax` / `no-restricted-properties` is the only sound check.

P0 because gate (a) is the single static gate the brief enumerates; if the gate is unsound, "0 IPC residue" is unprovable.

## P0 — Ship-gate (b) harness asserts daemon survives but does NOT assert "no data loss"

§4.2 / chapter 08 §7 spell the harness:

> 6. For each session, attach with the recorded last applied seq; assert receive deltas with `seq > recorded` immediately, no `snapshot` frame (still within retention window), no gaps.

Brief §11(b) says: "sessions list intact, **terminals reconnect to same PTY snapshots, no data loss**." The harness currently checks (a) sessions list, (b) PTY children alive, (c) deltas continue without gap. It does NOT compare the post-reattach client-side terminal state against the daemon-side terminal state. A delta stream can have monotonic seq with no gap and still be byte-corrupt (e.g., a buffer was double-written; a snapshot was cleared mid-flight). The harness needs an explicit byte-equality assertion at the end:
- daemon-side: serialize current xterm-headless terminal state via SnapshotV1 encoder
- client-side: replay all received frames into a fresh xterm-headless on the test side, serialize via SnapshotV1
- `Buffer.compare(daemon.snap, client.snap) === 0`

This is the same comparator gate (c) needs (see next finding) — gate (b) can reuse it cheaply in a 30-second variant. Without this, "no data loss" is not actually verified by gate (b).

## P0 — Ship-gate (c) comparator algorithm is hand-waved

§4.3 delegates to chapter 06 §8. Chapter 06 §8 says "Assert SnapshotV1 byte-equality" but that depends on:

(i) the **decoder** working — there is no decoder spec! Chapter 06 §2 gives the encoder layout but never says "and a decoder reads bytes back into an xterm-headless `Terminal` instance." The 1-hour soak gate compares two SnapshotV1 byte strings, but if either side's `Terminal` was driven by raw VT bytes (deltas), neither side is ever **encoded → decoded → re-encoded**; both are just **encoded once**. So the comparator is `encode(daemon.terminal) vs encode(client.terminal)`. That is meaningful but ONLY IF the encoder is **deterministic given equal Terminal state**. The encoder reads `attrs_palette` — palette ordering is not pinned (a hash-set iteration order would break determinism). Spec MUST pin: "palette entries appended in order of first appearance during a stable left-to-right top-to-bottom scan of cells," or equivalent. Otherwise byte-equality fails for non-load-bearing reasons.

(ii) `claude-sim` workload class enumeration is in §5 ("UTF-8/CJK/256-color/alt-screen/bursts mix") and chapter 06 §8 step 2 enumerates "mixed-language code blocks (UTF-8, CJK, RTL); 256-color sequences and SGR resets; cursor positioning (CUP, CUU, CUD); alt-screen enter/exit cycles (vim simulator phase); bursts (1 MB in 50 ms) and idles." Missing classes that real `claude` produces and break naive snapshot diffing:
   - **OSC sequences** (window title, hyperlink — OSC 8). xterm-headless tracks title; SnapshotV1 has no `title` field. Either include + add field, or document explicit non-coverage (kills "binary-identical to truth" claim).
   - **DECSTBM** scroll regions (used by less/more, vim). Snapshot has cursor + viewport but no scroll region state.
   - **Mouse mode toggles** (DEC private modes 1000/1002/1003/1006). `modes_bitmap` claims to track these — bit positions never enumerated. Pin them.
   - **Resize during burst** — snapshot cadence §4 says explicit Resize triggers a snapshot, but the soak harness §8 doesn't include a resize phase. Real Electron users resize.
   - **Kitty graphics protocol / sixel** if `claude` ever emits images. Probably out of scope; document.

Pin the workload-class table explicitly. P0 because "binary-identical" without a pinned encoder + workload set means the gate either (a) flakes on real workloads or (b) passes vacuously on toy workloads.

## P0 — Ship-gate (d) "verify residue" is incomplete; missing mechanical baseline

§4.4 PowerShell pseudo-flow checks ProgramFiles, registry key, scheduled tasks, service. Missing:

1. **No file-tree diff** — there is no `Get-ChildItem -Recurse` of `%ProgramData%`, `%LOCALAPPDATA%`, `%TEMP%`, user profile, before/after. The script tests a fixed list of expected leftover locations. If the daemon writes `%TEMP%\ccsm-*.tmp` for spool files (likely — coalescer might) the test passes but residue exists. The chapter 10 §5.1 list is what "should" be removed; the test should verify nothing UNexpected exists, not just that a known list is gone. Recipe: snapshot file tree pre-install (registry export + filesystem listing), snapshot post-uninstall, diff allowing only items on a documented allowlist (system Windows updates that fired during the test window).
2. **No registry diff** — only checks `HKLM\SYSTEM\CurrentControlSet\Services\ccsm-daemon`. WiX `<ServiceInstall>` may write to other registry roots (Firewall rules, Event Log sources, EventLog source registration for ETW). Need `reg export HKLM` before/after with a diff.
3. **No mac/linux equivalent specified** — §4.4 says "Mac/linux equivalents (`installer-roundtrip.sh`) written in parallel but ship-gate (d) is specifically Win per brief §11(d)." Brief §11(d) is indeed Win-specific, so this is acceptable per brief. But the spec needs to also state explicitly: **mac and linux do not have a ship-gate (d) equivalent in v0.3** (so ship-gate set is asymmetric across OSes). State that one-liner so reviewers don't waste time looking for it. Currently the chapter says equivalents are "written in parallel" — implies they're gating, but they're not.
4. **No "service was actually serving" assertion** — script checks `Get-Service ... -ne 'Running'`, but does NOT verify Listener A actually accepts a `Hello` from a test client. A daemon could be Running but stuck in startup step 4 (still respawning sessions) — Service Manager reports Running, Supervisor `/healthz` returns 503. Step "verify supervisor" comment uses placeholder `http://localhost:.../healthz` — actual address comes from listener-a.json in `%PROGRAMDATA%\ccsm`, but on a fresh VM with no prior install nothing wrote it; the script needs to read the file daemon wrote, not hardcode. Pin the read step.
5. **VM source** — "self-hosted Win 11 25H2 VM (snapshotted to a clean state before each run)". Where does the snapshot come from? Who maintains it? Chapter 11 §6 has `e2e-installer-win` runs on `runs-on: self-hosted-win11-25h2-vm` — which means a manually-provisioned runner must exist before phase 10 done can be claimed. **GitHub-hosted `windows-latest` is NOT 25H2** (currently Server 2022). This is a non-trivial hosting/ops dependency that could block ship; spec should call it out as a precondition for phase 11(d) and pin who provisions.

P0 because gate (d) without a real residue diff is theatre; "no leftover files in ProgramData / Registry / Scheduled Tasks" (brief §11(d)) requires looking everywhere, not at a fixed list of expected places.

## P1 — Ship-gate (c) is "non-blocking for PRs"; soak failure is detected the next morning

§4.3: "Non-blocking for PRs (regressions caught the next morning); blocking for release tags." This is a reasonable PR-velocity tradeoff but means M4 (per chapter 13 §5: "all of Phase 11 green on the same commit") may never actually hold simultaneously — soak runs nightly, the morning after merging anything; "same commit" in practice means tagging then waiting 24h then maybe re-tagging. Spec should specify the actual release procedure: "tag candidate; trigger on-demand soak run; if green, promote tag." Currently the procedure is implicit and may collide with the dogfood phase 12 timeline.

## P1 — Ship-gate harness for (b) and (c) bridge: only one P0-class environment is tested

§4.2 says PR runs in-process daemon, nightly runs service-installed. §4.3 says soak runs nightly only. The CRITICAL data-loss-on-SIGKILL property the brief calls out (§11(b)) only fires correctly when the daemon is in a **separate process group** from Electron (otherwise SIGKILL Electron may take down its child daemon-in-process spawn). In-process daemon as a Node Worker shares the process; `taskkill /F /IM electron.exe` of a fused electron-test process may kill the in-process daemon test harness too. Spec needs to either:
- Have the per-PR variant spawn the daemon as a real subprocess (`spawn process.execPath -e require('@ccsm/daemon').main`) so SIGKILL Electron doesn't reap it; OR
- State explicitly the per-PR variant validates a different property (just "Electron survives reattach with deltas continuing" — not "daemon survives kill") and gate (b) is only checked nightly via service-installed run.

The current spec says "in-process for CI per-PR" without addressing process-group semantics. P1 because gate (b)'s per-PR variant may pass for the wrong reason.

## P1 — Property-based test mentioned only for snapshot codec; PTY delta replay is a second obvious target

§2 lists `pty/snapshot-codec.spec.ts` as "round-trip property tests for SnapshotV1." Good. But the snapshot+delta replay invariant is the entire point of the design: **for any deterministic VT byte sequence S fed into Terminal X, snapshot(X) + replay(deltas)(snapshot, deltas_after_snapshot) produces a Terminal Y where snapshot(Y) == snapshot(X)**. There is no test named that explicitly. `pty-attach-stream.spec.ts` (§3) tests one workload; `pty-soak-1h` (§4.3) tests one 60-min workload. A property-based test with shrinking would catch a class of edge-case bugs that the soak workload may miss. Add `pty/replay-invariant.property.spec.ts` to §2.

## P1 — `claude-sim` is committed source but its build path is undocumented

§5: "tiny Go or Rust binary cross-compiled in CI alongside the daemon; small enough to vendor in the test fixtures dir." Lives in `packages/daemon/test/fixtures/claude-sim/`. Open questions:
- Source language not picked. Spec should pick (e.g., Go for cross-platform-cross-arch ease) so the team can start.
- "vendored in fixtures" means binary committed to git. Per chapter 11 §2 there is no `.gitattributes` LFS line for binary fixtures; large committed binaries pollute clones. Either commit source + build-on-CI (no vendored binary) or vendor with LFS — pin one.
- The script file format `(delay_ms, hex_bytes)` is mentioned for fixture authoring but no schema, no example. Authors of new soak workloads (e.g., a tester adding an OSC-8 case) need a defined format. Pin the file format.

## P1 — Coverage thresholds inconsistent with existing repo + no enforcement story

§6: 80% line coverage on daemon, 60% on Electron renderer. Existing `vitest.config.ts` (root) has thresholds 60/60/50/60 NOT enforced ("Thresholds are NOT enforced in CI yet"). Chapter 12 doesn't say whether the new thresholds ARE enforced in CI. If they aren't, "80% coverage" is aspirational and provides no signal. State explicitly: thresholds enforced in CI on `pnpm --filter @ccsm/daemon run coverage` step → fail PR if below; OR thresholds advisory and reviewer judgment gates merge.

## P1 — Performance budgets §7: "do NOT block PRs" makes them latent regressions

§7 budgets RTT and cold-start. "Benchmarks run nightly; failures open an issue tagged `perf-regression`. Manual triage gates ship." A perf regression on `Hello` RTT from 5ms to 200ms wouldn't fail any ship-gate (none of the four §11 gates measure RPC RTT). Suggest at least the `SendInput` p99 budget gates ship via gate (c) — soak workload should sample SendInput RTT and assert p99 < N — otherwise typing latency regression ships unnoticed.

## P1 — `peer-cred-rejection.spec.ts` cannot test what it claims on most CI

§3: "connect with a synthesized non-owning peer-cred; assert `Unauthenticated`." Synthesizing a non-owning peer-cred requires:
- linux: bind socket as user A, connect as user B — needs CI runner with two real uids and `setuid`. GitHub-hosted ubuntu runners run as one user; `useradd` then `runuser` is possible but spec doesn't say.
- mac: similar
- win: needs two interactive sessions

Spec should pin: which runners support this test; on others, the test runs against a mocked peer-cred middleware (still tests the auth chain but not the OS syscall). Currently §3 lists the test without addressing the platform requirement. Mark as `if: matrix.os == 'ubuntu-22.04'` with a postinst-installed second user, or move to a manually-run integration variant.

## P1 — Listener B stub assertion lacks negative-path test for "JWT validator NOT in bundle"

§2 has `listeners/listener-b.spec.ts — makeListenerB throws (v0.3 stub assertion — prevents accidental wiring)`. Brief §1 ALSO mandates "no JWT middleware code shipped." Need a test asserting `import('./jwt-validator').catch(...)` throws OR the file does not exist OR the bundle output (sea blob) does not contain the string `jwtValidator`. Without it, accidentally landing the JWT module is undetected. Add `bundle/no-jwt-in-v03.spec.ts` running grep on the built sea bundle.

## P1 — No test for the two MUST-SPIKE fallbacks reaching production

If [loopback-h2c-on-25h2] kills and we adopt A4 named pipe (or A3 TLS), the descriptor file format changes (`tlsCertPemBase64` becomes non-null) and Electron's transport factory must construct a TLS Connect transport. There is no integration test enumerating "for each transport kind in the descriptor enum, construct a transport, run Hello." Spec should add `rpc/clients-transport-matrix.spec.ts` parameterized over `transport ∈ {h2c-uds, h2c-loopback, h2-tls-loopback, h2-named-pipe}`. Otherwise after a spike outcome flips, the fallback path may be untested at merge.

## P2 — Test-data fixtures: SQLite

§ does not address SQLite test fixtures. Per chapter 07: tests should use `:memory:` for unit (chapter 12 §2 confirms `db/migrations.spec.ts` uses `:memory:`). For integration tests (§3) a temp file-based DB is the right call — spec should say so explicitly so different authors don't pick differently.

## Summary

P0 count: 4 (gate (a) grep unsound + no allowlist; gate (b) doesn't verify "no data loss"; gate (c) comparator/workload incomplete; gate (d) no real residue diff)
P1 count: 8
P2 count: 1

Most-severe one-liner: **None of the four ship-gates are mechanically sound as specified — gate (a) misses aliased imports, (b) doesn't actually compare terminal state, (c) compares non-deterministic encodings, (d) checks a fixed list instead of diffing residue.**
