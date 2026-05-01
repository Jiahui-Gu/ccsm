# Review of chapter 03: Bridge swap

Reviewer: R5 (Testability)
Round: 1

## Findings

### P0-1 (BLOCKER): Adapter parity tests have no defined input/output corpus
**Where**: chapter 03 §7 item 2 — "Adapter parity test (deleted after M2)"
**Issue**: the parity test asserts "Connect response and the corresponding v0.3 envelope response on the same input produce equivalent JS values". But there's no spec for: (a) where the input corpus comes from (recorded fixtures? hand-written? property-based?), (b) what "equivalent" means for fields that are intentionally typed differently (e.g. v0.3 returns `unknown` per chapter 03 §4, v0.4 returns a typed `ListPtyResponse`), (c) how to handle non-determinism (timestamps, ULIDs, PID-like fields). Without this, every bridge-swap PR will invent its own parity test and the migration safety net is non-uniform — exactly the worst time to skimp on rigor.
**Why this is P0**: the parity test is the load-bearing safety net during M2 (the most dangerous milestone — 12 PRs touching the wire surface). If tests are inconsistent across bridges, regressions will slip through silently, and the "deleted after M2" cleanup will erase the only signal we had.
**Suggested fix**: §7 specifies a parity-test framework: shared helpers (`assertParity(envelopeResp, connectResp, { ignoreFields: [...] })`); recorded golden fixtures in `daemon/__tests__/parity-corpus/<rpc>.json`; explicit ignore-list per RPC for known-divergent fields; framework enforces "every RPC in the swap PR has a parity test entry" via codegen-driven scaffold.

### P1-1 (must-fix): `pty:input` 5ms coalescing window is testable but not specified as such
**Where**: chapter 03 §1 + chapter 06 §3 (cross-ref)
**Issue**: chapter 06 §3 says input is batched with a 5ms coalescing window. The test plan (chapter 08) doesn't cover the coalescer at all — neither as a unit test on the bridge wrapper nor as an e2e measurement. Coalescing-window bugs (e.g. window grows under load, never flushes) are the kind of thing that's invisible until a user pastes 50 KB and gets character-by-character delivery.
**Why P1**: regression here would be a real UX bug (paste latency, dropped keystrokes) and is fully testable in isolation with a fake RAF clock.
**Suggested fix**: chapter 03 §7 adds "Input coalescer unit test: simulate N keystrokes within window W; assert ≤K RPCs emitted; assert no keystroke lost; assert max-buffer cap (256 KiB per chapter 06 §3) is enforced."

### P1-2 (must-fix): Bridge-swap PRs need a specified e2e-only filter convention
**Where**: chapter 03 §7 item 3 — "E2E probe on the bridge function"
**Issue**: per `feedback_local_e2e_only`, worker should run `--only=<case>` for the bridge under test, not the full suite. The spec doesn't define a naming convention (e.g. `bridge-swap:ccsmCore:getVersion`) so each worker invents one and the trust-CI-mode reviewer can't quickly verify "did the worker actually run the right e2e?". This compounds with M2's 12-PR throughput.
**Why P1**: without naming convention, the discipline isn't enforceable; reviewer either trusts blindly or runs the suite themselves (defeating trust-CI-mode).
**Suggested fix**: §7 defines `bridge-swap-<bridge>-<rpc>` naming; chapter 08 §9 lists the convention and the `npm run e2e:bridge -- --only=<id>` invocation.

### P1-3 (must-fix): Reconnect on transport tear-down has no flake-resistant test
**Where**: chapter 03 §3 — "Reconnect: if the underlying socket errors (`ECONNRESET`, `EPIPE`)..."
**Issue**: chapter 06 §6 covers the seq-replay reconnect but chapter 03 §3 describes a separate transport-level reconnect with its own backoff (5s / 6 attempts / 30s) for the local socket. No specified test. Killing a Unix socket / named pipe mid-RPC and asserting the bridge surfaces `daemon.unreachable` after exhaustion is testable hermetically but fragile (race between socket close and timer); needs an injectable backoff clock to be deterministic.
**Why P1**: this surface fires on every daemon respawn. If the backoff/abandon logic regresses, users see infinite spinners or premature fail.
**Suggested fix**: §3 specifies an injectable backoff clock; chapter 08 §3 contract tests cover the four boundary cases (success on attempt N<6; abandon on N=6; ECONNRESET vs EPIPE both trigger; in-flight RPCs reject with the documented error type).

### P2-1 (nice-to-have): No e2e for the no-op bridge surface in the web build
**Where**: chapter 03 §2 — updater no-op'd in web build
**Issue**: web build returns `{ kind: 'idle' }` for `updatesStatus()`; UI hides updater rows when `VITE_TARGET === 'web'`. Easy to regress (someone deletes the conditional, web shows broken updater UI). Could be caught by a single Playwright assertion "in web build, no element matching [data-testid=updater-section] exists".
**Why P2**: cosmetic regression, not data loss.
**Suggested fix**: chapter 08 §5 adds `web-no-updater-ui` case to the web e2e list.

## Cross-file findings

- **Parity-test framework** (P0-1) cross-cuts chapters 03 §7 + chapter 08 §3 — needs one author. Without a shared framework, M2 PRs produce inconsistent safety nets.
- **`--only=` naming convention** (P1-2) touches chapters 03 §7 + 08 §9 — same fixer.
