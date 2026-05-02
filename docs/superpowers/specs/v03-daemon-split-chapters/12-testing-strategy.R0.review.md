# R0 (zero-rework) review of 12-testing-strategy.md

## P1 findings (must-fix-before-merge; ambiguity / soft-rework risk)

### P1.1 Ship-gate (a) `lint:no-ipc` grep does not whitelist the descriptor-injection preload — collides with chapter 08 §4

**Location**: `12-testing-strategy.md` §4.1
**Issue**: The grep is `grep -rEn 'contextBridge|ipcMain|ipcRenderer' packages/electron/src ...`. As discussed in `08-electron-client-migration.R0.review.md` P0.2, the chapter 08 bootstrap mechanism either (a) needs a `contextBridge` for the descriptor injection (then the grep fails) OR (b) uses an alternative that isn't documented. Whichever path v0.3 picks, the grep needs an explicit whitelist mechanism to allow EXACTLY ONE descriptor-injection use of `contextBridge` if path (b) is taken.
**Why P1**: Coordination gap with chapter 08; no v0.4 rework impact, but the v0.3 ship gate as written may fail on day one.
**Suggested fix**: Once chapter 08 §4 picks the bootstrap mechanism, update §4.1's grep to either (a) be unchanged (chapter 08 picks no-contextBridge) OR (b) whitelist the single allowed file: `grep ... | grep -v 'preload-descriptor.ts'`. Lock the file path in both chapters.

### P1.2 Ship-gate (c) 1-hour soak runs only on loopback — does not exercise v0.4-relevant high-latency conditions

**Location**: `12-testing-strategy.md` §4.3
**Issue**: The soak validates byte-equality after Electron SIGKILL on loopback. Doesn't validate the v0.3 wire format under network-jitter conditions that v0.4 web/iOS will face. v0.4 ADDS a CF Tunnel variant (per chapter 15 audit row [12 §4]) — additive, fine — BUT if the v0.3 wire format has a latent bug only visible under jitter (e.g., HTTP/2 stream-window deadlock when delta bursts overflow flow-control), v0.4 discovers it AFTER v0.3 freeze. Fixing it means changing the wire format = forever-stable violation.
**Why P1**: Validation gap; v0.3 cannot be confident the wire format is truly forever-stable without exercising the conditions v0.4 will hit.
**Suggested fix**: Add a v0.3 soak variant `pty-soak-1h-jittered` that injects 200ms +/- 100ms latency between client and daemon (using `tc qdisc` linux / `clumsy` win / `dnctl` mac). Run nightly. Failure = wire format needs revision **inside v0.3** — not "v0.4 problem".

### P1.3 Performance budget for `SendInput RTT < 5ms p99` is loopback-only — sets a v0.3 bar that v0.4 cannot meet

**Location**: `12-testing-strategy.md` §7
**Issue**: The 5ms p99 budget is loopback-relevant. v0.4 web client over CF Tunnel has typical 50-300ms RTT for unary RPCs. The unchanged budget will break v0.4 tests OR force v0.4 to add a parallel "remote SendInput" budget — implicitly admitting that `SendInput` unary is wrong for v0.4 (see also `04-proto-and-rpc-surface.R0.review.md` discussion of unary SendInput).
**Why P1**: Cross-version budget contract should be set now.
**Suggested fix**: Re-state the budget as "`SendInput RTT < 5ms p99 over loopback Listener A`". Document in chapter 15 §3 that v0.4 sets its own budget for Listener B; the v0.3 budget is forever-stable for Listener A only.

### P1.4 No test for `Hello(client_kind="web")` against v0.3 daemon — v0.4 may discover the daemon rejects unknown kinds

**Location**: `12-testing-strategy.md` §3 (`version-mismatch.spec.ts`)
**Issue**: The version-mismatch test exercises `proto_min_version` — but not `client_kind`. v0.4 introduces new client_kind values; if v0.3 daemon does any switching on this string (it shouldn't, but nothing tests it doesn't), v0.4 hits a regression.
**Why P1**: Validation gap. See also `08-electron-client-migration.R0.review.md` P1.3.
**Suggested fix**: Add `client-kind-forward-compat.spec.ts` to `packages/daemon/test/integration/`: assert `Hello(client_kind="electron")`, `Hello(client_kind="web")`, `Hello(client_kind="ios")`, `Hello(client_kind="future-unknown")` all return success against the v0.3 daemon. Lock as forever-stable test.

### P1.5 Ship-gate (b) sigkill-reattach asserts "no `snapshot` frame (still within retention window)" — couples test to chosen retention values

**Location**: `12-testing-strategy.md` §4.2 step 6
**Issue**: The test asserts that after Electron SIGKILL+relaunch, the daemon does NOT send a snapshot (confirming the retention window covered the gap). This couples to `DELTA_RETENTION_SEQS = 4096`. If v0.4 tunes retention to something smaller for memory reasons, this v0.3 test fails for non-architectural reasons.
**Why P1**: Test brittleness across versions.
**Suggested fix**: Restate the assertion as "If 100 deltas occurred during the gap (which is < 4096 retention), reattach receives those 100 deltas without a snapshot". Make the assertion derive from the configured retention rather than embedding a "no snapshot ever" claim.
