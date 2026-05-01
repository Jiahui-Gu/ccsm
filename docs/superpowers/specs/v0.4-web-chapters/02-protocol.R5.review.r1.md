# Review of chapter 02: Protocol (Connect + Protobuf + buf)

Reviewer: R5 (Testability)
Round: 1

## Findings

### P1-1 (must-fix): `buf breaking` baseline ambiguity blocks reproducible CI
**Where**: chapter 02, §4 "CI gates" + §7
**Issue**: §4 says `buf breaking --against '.git#branch=main,subdir=proto'` "must pass against the merge target's `main` branch tip", but the spec branches feature → `working` → `main`. PRs target `working`, not `main`. Comparing against `main` while merging to `working` produces drift — a wire-breaking change merged to `working` and not yet promoted to `main` will silently re-break for the next PR's `buf breaking` baseline (or, more confusingly, pass when it shouldn't).
**Why this is P1**: makes the gate non-deterministic for the actual branch flow. Either the comparison ref needs to match `working` (the merge target) and a separate tag-time check covers `main`, or the spec needs to spell out the two-tier check. As written it's testable but produces false confidence.
**Suggested fix**: change `--against '.git#branch=working,subdir=proto'` for PR gate; add a release-tag job that runs `--against` the previous `v*` tag. Document both in §4.

### P1-2 (must-fix): Migration-gate Connect interceptor lacks a hermetic test plan
**Where**: chapter 02 §8 carryover table — "Migration-gate interceptor (block RPCs while SQLite migration in flight) → Re-implemented as Connect interceptor on the data socket"
**Issue**: chapter 08 §3 lists "interceptor wiring mistakes (e.g. forgot to register the migration-gate interceptor on a new route)" as the contract-test motivator, but neither chapter specifies HOW to deterministically put the daemon into `isMigrationGated() === true` from a unit/contract test. A real migration is non-deterministic (depends on DB state), so the test needs an injectable predicate or a fault-injection hook.
**Why this is P1**: without an injection seam, the gate is only verified at integration time, where reproducing "migration in flight" is racy → tests get marked flaky → real bugs land. v0.3 supposedly has the same problem; v0.4 inherits it without resolving.
**Suggested fix**: chapter 02 §8 (or chapter 08 §3) specifies an injectable `isMigrationGated()` hook in test mode (e.g. `__setMigrationGateForTest(boolean)` exposed only when `process.env.NODE_ENV === 'test'`). Contract test forces it to true, calls a gated RPC, asserts `MIGRATION_PENDING` Connect error.

### P1-3 (must-fix): JWT bypass via `localTransportKey` is a security-critical contract with no specified test
**Where**: chapter 02 §8 cross-ref + chapter 05 §4 + §5
**Issue**: chapter 02 §8 drops HMAC for the local socket and chapter 05 §4 makes JWT bypass conditional on a `localTransportKey` context value tagged at the listener. This is THE local trust boundary in v0.4. There's no spec-level requirement for a test that proves: (a) requests on the remote TCP listener that DON'T carry the tag are rejected without JWT, (b) requests on the local socket that DO carry the tag are accepted without JWT, (c) a forged `Cf-Access-Jwt-Assertion` header on the local socket doesn't get spuriously validated against a mock JWKS.
**Why this is P1**: the entire remote security model rests on this tag's correctness. A regression that accidentally tags remote requests as local would be silent and catastrophic. Must have an explicit contract-test entry, not just be implied by chapter 08's "interceptor wiring" line.
**Suggested fix**: chapter 02 §8 (or chapter 08 §3) lists a contract test "JWT bypass tag isolation" with the three sub-cases above. Chapter 08 §5 already has `web-auth-bypass-blocked` for the remote-no-JWT case; add the local-socket-cannot-be-tricked-via-header case explicitly.

### P2-1 (nice-to-have): `gen/` drift check semantics under codegen tool upgrades
**Where**: chapter 02 §4 — `git diff --exit-code gen/`
**Issue**: when `protoc-gen-es` or `protoc-gen-connect-es` is upgraded, the generated output may legitimately change (whitespace, comment header, helper). The CI gate would then fail every PR that doesn't bump the codegen even when the developer's `.proto` is correct. R10 (bundle bloat) covers a related issue but the codegen-version drift specifically lacks a process note.
**Why P2**: routine maintenance pain, not a correctness risk.
**Suggested fix**: §4 adds a one-liner: "When bumping codegen plugins, regenerate `gen/` in the same PR; CI compares against the bumped baseline."

## Cross-file findings

- **JWT bypass test contract** (P1-3) spans chapters 02, 05, 08 — single fixer should align all three so the contract reads consistently.
- **`buf breaking` baseline branch** (P1-1) spans chapters 02 §4 + 08 §2 — same fix applies to both.
