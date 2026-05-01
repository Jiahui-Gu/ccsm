# Review of chapter 08: Testing

Reviewer: R5 (Testability)
Round: 1

## Findings

### P0-1 (BLOCKER): "Codegen step extension to emit per-RPC contract test stubs" is hand-wavy
**Where**: chapter 08 §3 — "Generated test scaffolding from `proto/` (a small codegen step in `buf.gen.yaml` extension) emits the test stub file"
**Issue**: this is a load-bearing claim — "reduces forgot-to-test the new RPC bugs" — but `buf.gen.yaml` doesn't have a stock plugin that emits test stubs. The author would need to either write a custom protoc plugin, add a separate codegen tool, or settle for a script-based scaffold. Without specifying which, the spec promises a guarantee it can't deliver, and the "every RPC has a contract test" property silently degrades.
**Why this is P0**: this is the spec's mechanism for closing testability gaps as new RPCs are added. If it doesn't actually work, contract tests will rot — exactly when the protocol is most active (M2). Author should EITHER specify the codegen mechanism in chapter 02 §5 / chapter 08 §3, OR drop the claim and replace with a manual checklist + reviewer-enforced rule.
**Suggested fix**: chapter 08 §3 picks one: (a) custom protoc plugin script (specify path), (b) post-`buf generate` Node script that walks `gen/ts/*_connect.ts` and emits test stubs into `daemon/src/__tests__/connect-contract/<rpc>.test.ts` if missing, (c) reviewer checklist + lint rule that fails CI when a `.proto` RPC has no matching `<rpc>.test.ts`. Reviewer recommends (b) or (c) — both achievable within v0.4 scope.

### P1-1 (must-fix): Local-only e2e convention not aligned with chapter 03 batch PRs
**Where**: chapter 08 §9 + `feedback_local_e2e_only`
**Issue**: per `feedback_local_e2e_only`, worker runs only the case for their bridge. Chapter 08 §9 lists workflows by file area, but no `npm run e2e --only=<case>` taxonomy is defined. M2's 12 PRs across 5 bridge files need a clear mapping ("which `--only` does the ccsmPty:spawn worker run?"). Without it, workers either run the whole `harness-pty` suite (slow) or guess.
**Why P1**: throughput-critical for M2; reviewer trust-CI requires the worker's PR body to show the right `--only` output.
**Suggested fix**: §9 adds an "E2E case taxonomy" subsection mapping each bridge RPC to its `--only=<id>`. Author worker can generate from chapter 03 §1 inventory.

### P1-2 (must-fix): Cloudflare Pages preview deploy e2e is "1-case smoke" — too thin
**Where**: chapter 08 §5 — "nightly cron runs a 1-case smoke against the latest preview URL"
**Issue**: a 1-case smoke ("does SPA load") catches only the most basic deploy failure. Useful failure modes that won't surface: (a) Pages build succeeds but assets are mis-cached (stale chunks served), (b) `_redirects` SPA fallback broken so deep links 404, (c) Brotli/gzip mis-negotiation makes bundle 4× larger. Per author's open topic, web e2e on PR vs nightly is a real tradeoff but the 1-case smoke is too austere even for nightly.
**Why P1**: cheap to expand to 3-5 cases (load, deep-link, asset-cache-headers, sign-in-prompt, version-banner). Once-per-night already.
**Suggested fix**: §5 expands the Pages preview smoke to: SPA loads + deep-link works + sign-in prompt visible + version banner correct.

### P1-3 (must-fix): "trust-CI mode" + "no skipped e2e" interaction unspecified for migration window
**Where**: chapter 08 §9 — "Migration-window CI tolerance"
**Issue**: §9 says "manager temporarily disables specific workflows for the bridge-swap PRs and relies on local e2e + reviewer + final integration test on M1 close". This collides with `feedback_no_skipped_e2e` and `feedback_trust_ci_mode`. Disabling a workflow is functionally a skip; how does it not violate no-skip? The spec needs a clearer rule (e.g. "workflow `if: false` is allowed only when scoped to a labeled PR set, must be re-enabled at M2 start, post-M2 reviewer block runs the disabled set against final integration").
**Why P1**: ambiguity here will manifest as unaccountable test gaps during M2; reviewer needs an enforceable rule.
**Suggested fix**: §9 spells out the disable-mechanism (workflow gate via a single env var or label), the re-enable trigger (M2 close), and the make-up integration test. Optional: limit disable to specific workflows (allow disabling `web-e2e.yml` during bridge-only PRs but never `daemon-contract.yml`).

### P1-4 (must-fix): Test data plan and fixture management not specified
**Where**: chapter 08 broadly
**Issue**: nothing in chapter 08 specifies test fixtures: where they live (`__fixtures__/`?), how golden files are regenerated, how PTY byte-stream fixtures are anonymized (could contain user paths from author's machine), or how big they're allowed to be. Per past dogfood probe issues (`project_dogfood_probe_store_schema`), tests with hand-rolled assumptions about store shape have caused false positives. Without a test-data discipline section, the same will happen for v0.4 wire fixtures.
**Why P1**: spec is supposed to be the lockable source of truth for testability; missing test-data discipline is a foreseeable gap.
**Suggested fix**: §8 adds "Test data discipline": fixture location, golden-file update mechanism (`UPDATE_FIXTURES=1 npm test`), max fixture size (e.g. 1 MB), anonymization rule (no real user paths, no real session IDs).

### P2-1 (nice-to-have): Updater test on Win acknowledged as risky but not addressed
**Where**: chapter 10 R1 + chapter 08 (no entry)
**Issue**: R1 documents updater-on-Win as the top risk. Chapter 08 has no testing strategy for it (process-replacing-itself with batch script is hard to hermetically test). At least a "manual checklist for updater verification per release" should exist.
**Why P2**: not v0.4-novel (carryover from v0.3); but worth recording the test gap.
**Suggested fix**: §9 adds a "manual release checklist" line covering Win updater smoke.

### P2-2 (nice-to-have): Test pyramid balance not stated
**Where**: chapter 08 §1
**Issue**: layer overview is presented but not as a pyramid (target ratios). Per `feedback_e2e_prefer_harness`, default is harness; but no stated target like "70% unit / 20% contract / 10% e2e by case count". Without a target, additions skew toward e2e (where bugs are most easily reproduced, expensive to maintain).
**Why P2**: prose hint, not a correctness gate.
**Suggested fix**: §1 adds a one-liner ratio target.

## Cross-file findings

- **`--only` taxonomy** (P1-1) cross-refs chapters 03 §1/§7 + 08 §9 — same fixer.
- **Codegen-driven contract-test scaffolding** (P0-1) lives in chapter 08 §3 but depends on chapter 02 §5 / `buf.gen.yaml` — single fixer for both.
- **Migration-window disable rule** (P1-3) cross-refs chapter 09 M1/M2 + 08 §9.
