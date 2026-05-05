# R1 review of 03-ptyhost-wiring — feature-preservation (round 2)

Reviewer: R1 (feature-preservation)
Round: 2

## Round-1 closures

- **[P0 §1 "host 无条件渲染 + 错误状态 child 在 host 内部" 改了 UI 结构]** — **CLOSED** by CF-4 (commit `55195a8c`). §1 host subsection now leads with "R1 baseline-cite (MUST, before any code change): fixer / PR author MUST first run `git show 35b08d15^:src/components/TerminalPane.tsx` to record v0.2's claude-missing branch … Diverging from v0.2 DOM topology requires explicit user/product approval recorded in the PR; absent approval, preserve v0.2 shape and only expose a stable `data-testid` on whichever element actually mounts (harness selector adapts, not UI)." The "Required gate change" clause was rewritten to be **conditional on baseline above**: "if v0.2 already renders the host unconditionally with an inline error child, there MUST NOT be a 'claudeAvailable === true' conditional render … If v0.2 swaps host for an independent error screen, preserve that and add a stable `data-testid` on the error screen instead — do NOT collapse it into host." The CF-7 NEW UT in §1 likewise carries the cite-baseline escape hatch.
- **[P0 §4 "snapshot 60s TTL + cwd mismatch 弃 snapshot" 是 v0.3 新引入产品规则]** — **CLOSED** by CF-3 (commit `1cdba493`) per manager round-1 拍板 #1. §4 rewritten with explicit "v0.3 scope (R1 strict, manager decision round 1)" header: "v0.3 = restore the v0.2 daemon-port already-shipping attach-replay path to green; nothing more. … no new TTL / cap / eviction / cwd semantics are introduced in v0.3." All NEW semantics moved to §7 "sigkill-reattach v0.4 follow-up (defer list)" table (F-1..F-6). Implementation responsibilities reduced to "Verify (do not modify) that `daemon/ptyHost/lifecycle.ts` retains the pre-kill buffer using the v0.2 mechanism. If wave-2 cutover changed the retention behaviour, restore the v0.2 behaviour; do NOT introduce a new TTL / cap / eviction policy."
- **[P1 §5 "input RPC error-typed response" 可能改静默丢弃 → 用户可见错误]** — **CLOSED** by CF-4 (commit `55195a8c`). §5 input now carries explicit "MUST (R1 baseline-cite): fixer MUST first verify v0.2 behavior via `git show 35b08d15^:` on the pre-cutover IPC handler for `pty:input`. If v0.2 already silently drops writes to an unknown sid (200 OK + no-op), v0.3 MUST preserve silent-drop semantics — promotion to a typed error … is a v0.4 candidate that requires user/product approval, not a v0.3 refactor freebie." Closed-set error-token enum table at §5 footer also defers to the silent-drop guard ("silent-drop semantics per R1 baseline-cite above take precedence over `no_such_sid` if v0.2 dropped silently").
- **[P1 §5 "resize cols/rows 验证 → 400" 是新的输入验证]** — **CLOSED** by CF-4 (commit `55195a8c`). §5 resize MUST rewritten: "MUST (R1 baseline-cite): fixer MUST first verify v0.2 behavior via `git show 35b08d15^:` … Default is to **clamp** invalid `cols`/`rows` (≤0, non-integer) to a safe minimum (e.g. 1) and proceed — NOT reject with 400. Promotion to `400 bad_request` is allowed ONLY if v0.2 already rejected the same inputs (cite the baseline line); otherwise preserve the v0.2 acceptance envelope and add a UT proving the clamp behavior matches v0.2."
- **[P1 §3 Option C 改窗口启动时序但没量化预算]** — **CLOSED** by CF-2 (commit `52f6276e`). §3 now contains a dedicated "Cold-spawn budget (measured)" subsection with explicit ≤500ms p95 budget vs `35b08d15`, per-platform `<TBD by PR-3>` table, and "automatic, NOT a manager judgement call" rollback to Option B per ch05 §7 Risk-1. Decision section explicitly conditional ("MUST adopt Option C, conditional on the measured cold-spawn budget above").
- **[P2 §6 "renderer MAY display error token raw"]** — not actioned (P2 deferred per fix-plan); status unchanged. The CF-6 closed-token enum at §5 indirectly bounds blast radius (no surprise tokens), but the "MAY display raw" wording remains.
- **[P2 §2 G-2 "subscribe AFTER pty has produced data MUST be served via attach"]** — not actioned (P2 deferred per fix-plan); status unchanged.

## Round-2 findings

(none)

Notes on NEW v0.3 behaviour added by CF-6 (commit `71da1f8b`) that intersect R1's purview:

1. **§2 G-5 reconnect dedup contract** (NEW seq numbering on `pty:data`, NEW renderer-side 64 KiB queue with overflow → `daemon_unavailable`). This is a NEW contract not present in v0.2 (v0.2 used IPC, not SSE — no reconnect/dedup question existed). However: SSE itself is wave-2-B substrate that ch00 §4 enumerates as in-scope ("This spec stacks on top"); defining dedup behaviour for an in-scope new transport is necessary for correctness, not feature drift. The 64 KiB queue cap + `daemon_unavailable` overflow are the cheapest way to honour iron rule §3.6 "no transport regression" while preventing silent input loss — both alternatives (silent truncation, unbounded buffer) are strictly worse R1 outcomes. Not raised as P0/P1.

2. **§5 closed error-token enum + per-RPC subset table**. NEW token registry. R1 risk would be "renderer surfaces a new token to user" — but §6 "MAY display raw" caveat already existed pre-fix (P2, unchanged), and the per-RPC subset narrows what each RPC can emit. The R1 baseline-cite override on `pty:input` (silent-drop preserved if v0.2 dropped) keeps the user-visible behaviour pinned to v0.2 wherever it mattered. Not raised as P0/P1.

3. **§6 daemon stderr structured format**. NEW format (`[ccsmd] <ISO> <level> <category>: ...`). v0.3-internal observability surface, not user-visible. Not within R1 scope.

## Verdict

CLEAN. ch03 round-1 fixes close 2 × P0 + 3 × P1 from R1. The R1 baseline-cite escape hatch is now the load-bearing mechanism: every "MUST" that prescribes a behaviour different from raw v0.2 is gated by a "verify v0.2 first; preserve unless user/product approval" clause. CF-3 + CF-4 + CF-2 are mutually consistent.
