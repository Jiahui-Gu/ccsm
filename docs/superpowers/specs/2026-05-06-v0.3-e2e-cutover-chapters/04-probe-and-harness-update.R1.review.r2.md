# R1 review of 04-probe-and-harness-update — feature-preservation (round 2)

Reviewer: R1 (feature-preservation)
Round: 2

## Round-1 closures

- **[P1 §4 NEW harness case `sigkill-reattach` 实际是 feature gate, 不是 refactor 验收]** — **CLOSED** by CF-3 (commit `1cdba493`) per manager round-1 拍板 #1. §4 sigkill-reattach row Asserts now reads "v0.3 scope = v0.2 already-shipping attach-replay assertions pass (basic resume after SIGKILL on the daemon-port substrate). **NO new behaviour assertion in v0.3** (no TTL / cap / cwd-mismatch / eviction assertions — those are v0.4 per [03-ptyhost-wiring](./03-ptyhost-wiring.md) §7). v0.4 candidate for Set A promotion." Set column moved to "**Set B (informational, v0.3)**" with budget cell reading "n/a in v0.3 (Set B informational; no budget pinned per CF-3 — the v0.4 promotion PR pins budget when the case becomes a release-blocker)".
- **[P1 §3 Set A 加 `sigkill-reattach (NEW — author proposes adding)`]** — **CLOSED** by CF-3. §3 candidate Set A table no longer lists sigkill-reattach; instead a new "Set A scope (R1 strict, manager decision round 1)" paragraph reads "v0.3 Set A contains only cases that were already green at the v0.2 baseline (`35b08d15^`) plus the cases needed to verify wave-2 cutover did not regress them. The NEW `sigkill-reattach` harness case (chapter 04 §4 below) is **Set B informational in v0.3**; promotion into Set A is a v0.4 candidate per [03-ptyhost-wiring](./03-ptyhost-wiring.md) §7 F-4." The "Set assignment" subsection (CF-7-added) carries a "Sigkill-reattach pin (CF-3 manager decision)" reminder so the §3 assignment pass cannot re-litigate.
- **[P2 §4 `daemon-port-ready-before-render` 锁住 chapter 03 §3 Decision 可逆性]** — partially addressed by CF-7 (assertion now structured around `__ccsmDaemonPortLoadIterations === 0` debug counter, which still locks Option C contract literally — but ch03 §3 + ch05 §7 Risk-1 now explicitly auto-fallback to Option B on >500ms regression, so the lock-in concern is bounded). Not raised as P0/P1; P2 status unchanged.
- **[P2 §2 "Replace `'aside'` selector with `[data-testid="app-shell-ready"]`" 引入新 DOM affordance]** — partially addressed by CF-7 §2.0 ready-signal contract (event-based `ccsm:app-shell-ready` rather than a new DOM testid attribute; the production-side surface is a `dispatchEvent` not a DOM mutation). Net: no new DOM node, only an event emit. P2 status unchanged.
- **[P2 §3 "Set A 候选列表" 隐含确认 v0.2 已绿]** — not actioned (P2 deferred per fix-plan); §3 still does not annotate per-case v0.2 baseline status. Status unchanged.

## Round-2 findings

(none)

## Verdict

CLEAN. ch04 round-1 fixes close 2 × R1 P1 (sigkill scope in §3 + §4). CF-7's NEW production-event emits (`ccsm:app-shell-ready`, `ccsm:terminal-host-mounted`, `ccsm:term-attached`) are testability signals, not user-visible behaviour — they ship as `dispatchEvent` listeners with no DOM-shape change, no new toast, no new error path. Not within R1 scope.
