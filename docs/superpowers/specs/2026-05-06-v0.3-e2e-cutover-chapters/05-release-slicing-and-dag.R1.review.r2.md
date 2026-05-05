# R1 review of 05-release-slicing-and-dag — feature-preservation (round 2)

Reviewer: R1 (feature-preservation)
Round: 2

## Round-1 closures

- **[P0 G10 把 sigkill-reattach 锁为 release gate]** — **CLOSED** by CF-3 (commit `1cdba493`) per manager round-1 拍板 #1. G10 row rewritten: "sigkill-reattach v0.2 baseline maintained green: the v0.2 already-shipping `attach-replay-from-headless-buffer` Set A case stays green (smoke test only). v0.3 does NOT lock the NEW `sigkill-reattach` harness case (Set B informational per chapter 04 §3) or any new reliability semantics (TTL / cap / cwd / eviction) as a release gate — those gates live in v0.4 per [03-ptyhost-wiring](./03-ptyhost-wiring.md) §7 (F-4 / F-6)." Tooling reduced to a single `attach-replay-from-headless-buffer` Set A green check.
- **[P1 PR-4 "TerminalPane host unconditional" 落地了 chapter 03 §1 的 UI DOM 改动]** — **CLOSED** by CF-4 (commit `55195a8c`). PR-4 acceptance now reads "the Retry-state path **preserves v0.2 DOM topology** (cite `git show 35b08d15^:src/components/TerminalPane.tsx` baseline line numbers in PR body). Only stable `data-testid` attributes (e.g. `data-testid='terminal-host'`) may be added to whichever element v0.2 already mounts; harness selector adapts to v0.2 shape, not the reverse. Any new DOM node or any change to the claude-missing branch topology requires explicit user/product approval recorded in the PR." The NEW UT bullet (CF-7) likewise inherits the "cite baseline; mirror v0.2 topology if it differs" escape hatch.
- **[P1 PR-3 "await spawnDaemon" 缺可机械验证的 latency budget 阈值]** — **CLOSED** by CF-2 (commit `52f6276e`). PR-3 acceptance now contains an explicit "Acceptance (cold-launch budget)" bullet: "PR body MUST include a measured `p50`/`p95` cold-launch click-to-window delta vs `35b08d15` for each of Win / macOS / Linux … Any platform showing **>500ms p95 regression** automatically triggers fallback to Option B (pre-resolved port cache); manager does NOT re-deliberate. PR-3 cannot land with an unfilled table or with the >500ms threshold breached on Option C." §7 Risk-1 expanded with the same enforcement language.
- **[P1 PR-6 把 chapter 03 §4 的新 sigkill 语义当 acceptance, 与 G10 互锁]** — **CLOSED** by CF-3. PR-6 acceptance split into "(a) v0.2 baseline restoration" (must-pass, attach-replay-from-headless-buffer green; UTs cover G-1/G-2/G-3/G-4 multi-subscriber correctness only — the wording explicitly notes "these are multi-subscriber correctness, NOT new sigkill semantics") and "(b) NEW `sigkill-reattach` harness case … runs as **Set B informational** in v0.3 — its result MUST NOT block PR-6 merge or v0.3 release." A "v0.4 follow-up (NOT in this PR)" subsection lists F-1..F-6 explicitly with placeholder v0.4 PR indices.
- **[P2 Q3 routing to reviewer]** — not actioned in round 1 (P2 deferred per fix-plan); status unchanged.
- **[P2 §4 Set B "escalate as P1" 后置补救]** — not actioned (P2 deferred); status unchanged.

## Round-2 findings

(none)

Notes on round-1 NEW additions to ch05 that intersect R1's purview:

1. **G11 daemon stderr zero-error gate** (CF-6, commit `71da1f8b`). NEW release gate. v0.3-internal observability, not user-visible behaviour. R1 risk = "stricter merge gate may block ship for unrelated stderr noise" — but ch03 §6 carries a `CCSMD_LOG_LEVEL` env var that lets operators downgrade noisy categories; the gate applies only to `level=error` records, which by §6 are reserved for "uncaught exception" / boot failure / similar. Not within R1 scope.
2. **G9 widening to include daemon HTTP listen-address grep** (CF-8, commit `33dd444a`). NEW gate clause. Loopback-bind invariant is a security/correctness guard, not a user-visible behaviour change — and the `0.0.0.0`/`::` widening it forbids is itself a v0.4 candidate that would require explicit RFC. Not within R1 scope.
3. **§3.0 Symptom-to-PR closure map** (CF-7). Documentation cross-reference; no behaviour change.
4. **PR-2/PR-4/PR-8 production-event emit responsibilities** (CF-7). NEW `ccsm:app-shell-ready` / `ccsm:terminal-host-mounted` / `ccsm:term-attached` `dispatchEvent` calls in production code. R1 risk = "new event emissions are user-observable surface" — but these are window-level CustomEvents with no listener in production code (only tests / probes consume them); there is no DOM change, no new UI affordance, no new error path. The CF-7 fallback rule ("If any emit is rejected during PR review, the corresponding probe falls back to `waitForFunction` and §2.0 above documents the reason") preserves PR-level R1 escape hatch. Not within R1 scope.

## Verdict

CLEAN. ch05 round-1 fixes close P0 + 3 × P1 from R1. The DAG / acceptance / gate machinery is now mutually consistent with the upstream chapter changes (G10 ↔ ch03 §4 ↔ ch04 §4; PR-3 budget ↔ ch03 §3 budget table; PR-4 v0.2 cite ↔ ch03 §1 / ch01 HP-4; PR-6 acceptance split ↔ ch03 §4 + ch04 §4).
