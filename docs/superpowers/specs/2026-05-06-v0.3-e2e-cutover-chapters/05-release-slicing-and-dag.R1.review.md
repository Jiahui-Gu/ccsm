# R1 review of 05-release-slicing-and-dag — feature-preservation

Reviewer: R1 (feature-preservation)
Round: 1

## Findings

### P0 — G10 把 sigkill-reattach 锁为 release gate, 等同把 NEW feature 升 v0.3 ship 标准
**Location**: `05-release-slicing-and-dag.md` §1 "Top-level v0.3 e2e iron rules" 表格 G10 行
**Issue**: G10 = "sigkill-reattach harness case (NEW per chapter 04 §4) is green"。这条 release-gate 把 chapter 04 §4 标 NEW 的 case 强制绑成 v0.3 ship 标准, 与 chapter 00 §2 "v0.3 是 refactor, 不是 feature change" 直接冲突。R1 角度: refactor 的 ship gate 不应包含 NEW e2e case 作为 hard 阻塞。
**Why blocker**: P0 — 已经从"提议"升到了"merge gate", 是最严重的 feature drift 落地点。一旦此 gate 生效, fixer 必须实现 chapter 03 §4 全部新语义 (60s TTL, cwd 弃 snapshot) 才能 merge。
**Suggested fix**: G10 删除, 或改为 "G10: any v0.2-already-green sigkill-reattach scenario stays green (no new scenarios added)"。同时同步修 chapter 04 §3/§4 (见 chapter 04 review)。

### P1 — PR-4 "TerminalPane host unconditional" 落地了 chapter 03 §1 的 UI DOM 改动
**Location**: `05-release-slicing-and-dag.md` §3 PR-4 "Files touched / Acceptance"
**Issue**: PR-4 acceptance "Retry-state path renders inside the host element, not in lieu of it" — 这等于钉死 v0.3 必须改 v0.2 的"无 claude → 单独错误屏"为"host 内嵌 Retry"。R1 角度同 chapter 03 §1 的 P0:没引用 v0.2 baseline 就锁 UI 形态。
**Why blocker**: P1 — DAG 里 PR-4 一旦执行, UI 已变;必须先在源头 (chapter 03 §1) 收敛后再切片。
**Suggested fix**: PR-4 acceptance 改为 "Retry-state path preserves v0.2 DOM structure, exposes stable `data-testid` on whichever element mounts; harness selector adapts。"

### P1 — PR-3 "await spawnDaemon" 缺可机械验证的 latency budget 阈值
**Location**: `05-release-slicing-and-dag.md` §3 PR-3 "Acceptance" + §7 Risk-1
**Issue**: PR-3 acceptance 仅写 "harness `attach-replay-from-headless-buffer` no longer reports `daemon port unavailable after 5s`; new `daemon-port-ready-before-render` harness case is green。" **没有把 §7 Risk-1 的 "≤500ms regression" 写进 PR-3 acceptance**。fixer 不会自动跑 latency 对比, 也不会自动回退 Option B。
**Why blocker**: P1 — 用户可见冷启动时序退化无 mechanically-checkable gate, 等于"事后看心情"。
**Suggested fix**: PR-3 acceptance 加一条 "MUST measure cold-launch click-to-window latency on Windows primary dev box; regression vs v0.2 baseline ≤500ms (per §7 Risk-1)。如果超, PR 自动转 Option B。"

### P1 — PR-6 把 chapter 03 §4 的新 sigkill 语义当 acceptance, 与 G10 互锁
**Location**: `05-release-slicing-and-dag.md` §3 PR-6 "Acceptance"
**Issue**: PR-6 acceptance "NEW `sigkill-reattach` harness case green; UTs cover guarantees G-1 / G-2 / G-3 / G-4 from chapter 03 §2"。其中 G-2 "subscribe AFTER pty produced data MUST be served via attach, NOT SSE backlog" 和 G-3/G-4 是 chapter 03 §2 显式新引入策略, 不是 v0.2 既有契约。
**Why blocker**: P1 — 与 G10 一起锁住 NEW feature 进 v0.3。
**Suggested fix**: PR-6 acceptance 拆为 (a) v0.2 既有 attach-replay 路径恢复 (必修), (b) G-1..G-4 新策略 = 转 v0.4 follow-up PR。

### P2 — Q3 "requiresClaudeBin 应 fail 还是 skip" 在 §7 列开放但被分到"reviewer R5"
**Location**: `05-release-slicing-and-dag.md` §7 "Open question Q1" (并隐含 chapter 01 Q3)
**Issue**: §7 列了 Q1 "88 .skip 出处" 给 R5, 但 chapter 01 Q3 的 "requiresClaudeBin fail vs skip" 实际是 dev-loop 体验 (产品决策), R1 角度认为不该交 reviewer。本章 §7 应代为升级。
**Why blocker**: P2 — 流程 routing 问题, 不是 spec 行为问题。
**Suggested fix**: §7 加一条 "Open question Q-product: chapter 01 Q3 requires user/product approval — requiresClaudeBin fail-vs-skip 改 dev-loop 行为, 不在 reviewer 权限内。"

### P2 — §4 Set B 处理路径"escalate 为 P1 finding"是后置补救
**Location**: `05-release-slicing-and-dag.md` §4 "Set B regressions tracking"
**Issue**: 流程是 "Set B regression → 写 setB-regression-log.md → 如果 attributable to wave-2 cutover residue → escalate as P1"。这意味着 v0.3 dispatch 出去的 fixer 已经在干活时, Set B 退化才被发现, 升 P1 时已经走完一半。R1 角度: 应在源头加一句 "fixer 在动手前必须先在 v0.2 base 跑一遍 Set B 截图, 落地后跑第二遍 diff", 否则用户可见行为 (Set B 覆盖的那部分) 会在事后才被抓到。
**Why blocker**: P2 — 流程改进, 不是 spec bug。
**Suggested fix**: §4 加一条 "MANDATORY pre/post Set B baseline: 每个 PR fixer 在动手前快照 Set B 结果, merge 前对比 diff, 任何变化必须在 PR body 解释。"
