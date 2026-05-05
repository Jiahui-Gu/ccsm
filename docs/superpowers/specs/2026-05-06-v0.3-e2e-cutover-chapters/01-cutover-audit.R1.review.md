# R1 review of 01-cutover-audit — feature-preservation

Reviewer: R1 (feature-preservation)
Round: 1

## Findings

### P1 — HP-4 R1 "TerminalPane host 无条件渲染" 没确认 v0.2 行为
**Location**: `01-cutover-audit.md` §HP-4 "R1: host never mounts → TerminalPane render gated on `claudeAvailable` is stuck"
**Issue**: HP-4 R1 把"host gated on `claudeAvailable`"判定为 bug 并要求 FIX, 但没引用 v0.2 (pre-cutover) 的实际行为。如果 v0.2 的 TerminalPane 就是 `claudeAvailable === false` 时不渲染 host (而显示一个独立的"Claude not found"页面), 那么这条 FIX 就是把 "无 claude → 不展示终端区域" 改成 "无 claude → 终端区域有但 disabled", **改了用户可见 UI**。chapter 03 §1 把这条变成 MUST 但没拉 v0.2 git blame 证明。
**Why blocker**: P1 — refactor spec 不能在没有 v0.2 base 对比的情况下改 UX gating 规则。一旦下游 fixer 实施, 就是用户看到"以前没有的空终端容器", 即使是小变化也是 feature drift。
**Suggested fix**: HP-4 R1 增加一个前置 audit step: "fixer MUST `git show 35b08d15^:src/components/TerminalPane.tsx` 验证 v0.2 渲染行为; 如果 v0.2 已是无条件 host, 维持; 如果 v0.2 是 conditional, 走 minimum-blast-radius 路线 (例如保持 conditional 但提供另一个 harness-only 的 stable selector)。"

### P1 — HP-8 sigkill-reattach "v0.3 mandatory" 但 v0.2 行为未知
**Location**: `01-cutover-audit.md` §HP-8 ("Verdict: FIX (mandatory v0.3 per iron rule §3.4)")
**Issue**: 章节自己写 "latent — only one harness case (`attach-replay-from-headless-buffer`) covers this and it currently errors out at the daemon-port boundary (S2). Once HP-3 is fixed, whether this path actually works end-to-end is an unknown." 然后立刻 verdict = FIX-mandatory。"unknown 是否曾工作" + "mandatory v0.3" 在 R1 角度下等于:**spec 把 v0.2 可能从未交付过的 feature 升级为 v0.3 ship 标准**。chapter 03 §4 进一步引入 "60s TTL"、"cwd mismatch 弃 snapshot" 等 v0.2 没有规定过的语义。
**Why blocker**: P1 — feature-preservation 的反面 = "preservation of features v0.2 never had"。要么先证明 v0.2 这条路径有效 (然后 FIX 是恢复), 要么把 sigkill 的"行为标准"明确标 NEW 并请 user 签字。
**Suggested fix**: HP-8 verdict 拆为两半: (a) "恢复 daemon-port 通后 v0.2 已有行为" = v0.3 必修; (b) "新增 snapshot TTL / cwd 语义 / sigkill-reattach 作为 release gate (G10)" = defer v0.4 或要求 user 显式批准。

### P2 — HP-3 Option C 改了"窗口出现"用户可见时序但未量化
**Location**: `01-cutover-audit.md` §HP-3 "Verdict: FIX (extend boundary, change contract, OR move the wait off the per-RPC critical path)"
**Issue**: HP-3 的 verdict 把"design choice"丢给 chapter 03 §3, 而 chapter 03 §3 选了 Option C (await spawnDaemon before BrowserWindow), 这**直接改变冷启动用户可见的"点击图标 → 窗口出现"延迟**。chapter 05 §7 Risk-1 承认 ">500ms 退化要回退", 但 audit 这里没把"用户可见时序"列为 R1 风险面。
**Why blocker**: P2 — 实际上 chapter 05 已 risk-track, 但 audit 应在源头标注 "HP-3 任何 fix 必须保留 v0.2 启动延迟预算 (±X ms)"。
**Suggested fix**: HP-3 段加一行 "Constraint: any fix MUST preserve v0.2 cold-launch latency within the budget defined in chapter 05 §7 Risk-1 (≤500ms regression)。"

### P2 — Q3 "requiresClaudeBin 应 fail 还是 skip-on-absent" 是 user/product 决策
**Location**: `01-cutover-audit.md` §"Open audit questions" Q3
**Issue**: Q3 "should they FAIL when the binary is missing locally, or remain skip-on-absent" — 这是直接的 product 决策, 不是 reviewer 能裁决的:
- 改成 FAIL 等于改了 dev-loop 体验 (没装 claude 就不能跑测试)
- 保留 skip-on-absent 等于和 iron rule §3.1 "zero e2e skip" 字面冲突
**Why blocker**: P2 — chapter 04 §1 把这条转给 R5 reviewer, 但 R1 角度下:无论裁决方向, 都会改用户/dev 可观察行为, 应升级到 user 签字而非 reviewer 投票。
**Suggested fix**: Q3 末尾追加 "Resolution requires user/product approval (changes dev-loop behavior); reviewers MUST NOT decide unilaterally."
