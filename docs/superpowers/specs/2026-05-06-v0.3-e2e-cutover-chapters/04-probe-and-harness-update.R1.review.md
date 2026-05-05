# R1 review of 04-probe-and-harness-update — feature-preservation

Reviewer: R1 (feature-preservation)
Round: 1

## Findings

### P1 — §4 新 harness case `sigkill-reattach` 实际是 feature gate, 不是 refactor 验收
**Location**: `04-probe-and-harness-update.md` §4 "New harness cases required by spec" — `sigkill-reattach` 行
**Issue**: 这个 NEW case 断言 "Full HP-8 flow: spawn → write → SIGKILL → spawn(same sid) → attach → snapshot replay。" 配合 chapter 03 §4 引入的 60s TTL / cwd-mismatch 语义 + chapter 05 G10 把它作为 release gate, 整个链条等于 "v0.3 必须交付 v0.2 没有的 reattach 标准"。R1 角度下,**新加 e2e case 锁住的"行为标准"如果 v0.2 没明确, 就是 feature work 而不是 refactor preservation**。
**Why blocker**: P1 — 等同 chapter 01 HP-8 的 P1, 这里是 harness 落地处。如果上游 (chapter 00 §3.4 / chapter 03 §4) 收敛到 "v0.3 仅恢复 v0.2 行为", 这个 NEW case 也要相应改写。
**Suggested fix**: 该行 "Asserts" 改为 "Asserts: v0.2 attach-replay-from-headless-buffer 既有断言通过 (no new behavior introduced)。" 删除 "Full HP-8 flow" 的展开;把 spawn-with-same-sid / cwd-mismatch 等 v0.4 case 归 backlog。

### P1 — §3 Set A 加 `sigkill-reattach (NEW — author proposes adding)` 把 NEW feature 拉进 release gate
**Location**: `04-probe-and-harness-update.md` §3 "Set A — CI gate" 表格 harness-real-cli 行末 "(NEW — author proposes adding)"
**Issue**: Set A 是 "must be green to merge"。把 author-proposed NEW case 直接放入 Set A = 把 NEW feature 升级为 v0.3 ship 标准。R1 角度 = scope creep。
**Why blocker**: P1 — 与上一条同根, 同样需要 user/product 签字才能升级。
**Suggested fix**: 把 `sigkill-reattach` 从 Set A 表格移到 Set B (informational), 或在 Set A 标注 "pending user approval to gate v0.3"。

### P2 — §4 新 harness case `daemon-port-ready-before-render` 测的是 v0.3 新内部契约, 不是 v0.2 行为
**Location**: `04-probe-and-harness-update.md` §4 — `daemon-port-ready-before-render` 行
**Issue**: 这个 case 断言 "`window.ccsmPty` works on the very first RPC (no 5s polling waste)"。它锁住的是 chapter 03 §3 Option C 引入的"window 出现时 daemon 必已 ready"内部契约, **完全是 v0.3 新增**。这本身没改用户行为, 但作为 e2e gate 锁住了"启动顺序", 如果未来需要回退到 Option B (per chapter 05 §7 Risk-1), 此 case 会一起红, 形成 design lock-in。
**Why blocker**: P2 — 不改 v0.2 行为, 但**锁住了 chapter 03 §3 Decision 的可逆性**, 让"如有性能退化回退到 Option B"变得更贵 (要同时改 case)。
**Suggested fix**: 把 case 断言写得抽象一点: "first ccsmPty RPC succeeds within X ms of first paint"; 不要绑死 "before render" 字面, 给 Option B fallback 留路。

### P2 — §2 "Replace `'aside'` selector with `[data-testid="app-shell-ready"]`" 引入新 DOM affordance
**Location**: `04-probe-and-harness-update.md` §2 "scripts/probe-utils.mjs → seedStore"
**Issue**: 提议 App.tsx 在 post-mount effect 里加 `[data-testid="app-shell-ready"]`。这是**渲染端新增 DOM 节点/属性**, 哪怕只是 testid, 也是 production bundle 多出一个 attribute。R1 角度: testid 不直接影响用户, 但属于 "while we're at it 加点 affordance" 的灰色地带, 应明确归类。
**Why blocker**: P2 — 边缘 case, testid 不影响渲染外观但确实是 production code 改动。
**Suggested fix**: §2 该段改为 "v0.3 keep `'aside'` selector unchanged; new `[data-testid="app-shell-ready"]` defer to v0.4 hardening pass。" 或显式标注 "testid-only addition, production-neutral, not a feature change"。

### P2 — §3 "Set A 候选列表" 隐含确认 v0.2 已绿
**Location**: `04-probe-and-harness-update.md` §3 "Set A — CI gate (must be green to merge)" 表格
**Issue**: Set A 列表里包含 `theme-toggle`, `terminal-pane-mounted`, `startup-paints-before-hydrate` 等 case, **但没有标注哪些是 v0.2 已绿、哪些是 v0.2 也红**。如果某 case 在 v0.2 base 也红, 那 v0.3 把它列 Set A 等于借 refactor 提升 quality bar = scope creep。
**Why blocker**: P2 — quality-bar drift, 不是直接 user-visible feature 改动, 但 R1 角度还是要排查。
**Suggested fix**: §3 表格加一列 "v0.2-baseline status (green/red/unknown)"; 任何 v0.2 已红的 case 不应列入 v0.3 Set A 而应单独走 fix-track 并记入 v0.4 backlog。
