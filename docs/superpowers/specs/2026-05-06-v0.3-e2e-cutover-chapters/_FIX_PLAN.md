# Fix plan — round 1

聚合自 30 个 R1-R5 review (Task #592 stage-3 triage)。
- 仅 fix **P0 + P1**, P2 deferred (per `feedback_spec_pipeline_review_strictness.md`)。
- **互斥写规则**: 每个 fixer 只写自己 `files:` 列出的文件;cross-file fixer 锁住其覆盖的所有 chapter, 同 chapter 上的 single-chapter fixer 不得并行。
- 多个 cross-file fixer 之间若 `files:` 集合 disjoint, 可并行;否则串行。本计划尽量让 CF-* 之间 disjoint。
- Chapter 文件路径 (相对本目录):
  - ch00 = `00-overview.md`
  - ch01 = `01-cutover-audit.md`
  - ch02 = `02-store-and-preload-surface.md`
  - ch03 = `03-ptyhost-wiring.md`
  - ch04 = `04-probe-and-harness-update.md`
  - ch05 = `05-release-slicing-and-dag.md`

总计: P0 = 13, P1 = 41 (5 reviewer × 6 chapter aggregated)。

---

## Cross-file fixers (run sequentially or with strict file mutex)

### CF-1: skip-baseline reconcile  files: [ch00, ch01, ch04, ch05]

**Findings owned (P0/P1)**:
- [P0][R5] ch00 §2 — "88 .skip" baseline 是 phantom; 实际 0 Vitest skip + 1 `skipLaunch` (`cap-skip-launch-bundle-shape`)。
- [P0][R5] ch04 §1 — KEEP/DELETE/FIX/MARK 矩阵基于 88 entries 但 ground-truth = 1; 重写 §1 为 §1.1 canonical baseline / §1.2 forward guard / §1.3 真实 triage (`requiresClaudeBin / windowsOnly / darwinOnly`)。
- [P0][R5] ch05 §1 G8 — 措辞 "relative to 35b08d15" 有歧义;改为 "Vitest skip total = 0; harness flag count ≤ ch04 §1.1 baseline"。
- [P1][R5] ch01 Q4 — 标 RESOLVED, 把 R5 ground-truth answer 引用入 §"Open audit questions"。

**Brief**:
ch04 §1 是 canonical 落地点;ch00 §2 / ch01 Q4 / ch05 §1 G8 都 backlink 到 ch04 §1.1。重写 ch04 §1 三段;ch00 §2 把 "~88" 替换为 R5 给的精确措辞;ch01 Q4 加 RESOLVED note + 链 ch04 §1.1;ch05 §1 G8 替换 gate 文本与 grep 命令。一个 commit 落地, 文字保持一致。**不要**自行去调研 `requiresClaudeBin` 实际数, 留给 §1.3 fixer 实地枚举 (本任务只改 framing)。

---

### CF-2: cold-launch latency budget (Option C)  files: [ch01, ch03, ch05]

**Findings owned (P0/P1)**:
- [P0][R3] ch03 §3 — Option C 缺 measured cold-spawn budget;需要 §"Cold-spawn budget (measured)" / §"Spawn failure path" / §"Race after await" 三小节。
- [P1][R3] ch01 HP-3 — 加 Q5 要求 p50/p95 cold-spawn 表 (Win/macOS/Linux), 阻塞 PR-3 dispatch 直到表落地。
- [P1][R4] ch01 HP-3 — 同主题, R4 角度无 measured number。
- [P1][R4] ch03 §3 Decision — 必须记录 measured ms + ≤500ms budget + rollback trigger。
- [P1][R1] ch03 §3 — Option C 改用户冷启动时序但无量化预算;同上。
- [P1][R3] ch05 PR-3 — 缺 spawn-failure rollback/retry 设计 + Risk-1 增加 ">500ms 自动回退 Option B" 显式条款。
- [P1][R4] ch05 §7 Risk-1 — gate 缺 enforcement point;PR-3 acceptance 必须捕捉 first-paint delta。
- [P1][R1] ch05 PR-3 acceptance — 没把 ≤500ms 写进 acceptance。

**Brief**:
统一 budget 数字 (≤500ms regression vs 35b08d15 baseline) 写进三个章节, 措辞一致。
- ch01 HP-3 加 Q5 (要求 p50/p95 表), 标注 "blocks PR-3 dispatch"。
- ch03 §3 重排 Decision 段: 先列 measured budget (留 `<TBD by PR-3>` 占位), 再 Option A/B/C 对比, 再 Decision, 再 Spawn failure path (catch + 1 retry with port=0 + native error dialog + non-zero exit), 再 Race-after-await 段 (要么证明不存在要么 pin worst-case window)。
- ch05 PR-3 Acceptance 加 bullet "PR body MUST 包含 cold-launch click-to-window delta vs 35b08d15; >500ms 触发 Option B 回退而非 manager 拍板"; §7 Risk-1 同步。
- 同时锁住 ch03 §3 与 PR-3 的"timeout 拒绝"行为 (cf CF-7 if 单独取出 R5 P0-2);本 CF 只负责 budget/rollback, R5 P0-2 ready-signal & 10s timeout 归 CF-7。
约 50 行 spec 编辑。

---

### CF-3: feature-preservation guard for sigkill-reattach (R1 大议题)  files: [ch00, ch01, ch03, ch04, ch05]

**Findings owned (P0/P1)**:
- [P0][R1] ch03 §4 — 60s TTL + cwd-mismatch 弃 snapshot 是 v0.3 新引入产品规则, 不该 refactor 中带入;改 "v0.3 仅恢复 v0.2 行为, TTL/cwd defer v0.4"。
- [P0][R1] ch05 §1 G10 — 把 sigkill-reattach 锁为 release gate 等于 NEW feature 升 ship 标准;G10 删除或改 "v0.2-already-green 场景维持绿"。
- [P1][R1] ch01 HP-8 — verdict 拆为 (a) 恢复 v0.2 daemon-port 已有路径 = v0.3 必修, (b) 新 snapshot/cwd 语义 = defer。
- [P1][R1] ch00 §3.4 iron rule — sigkill-reattach 必修范围明确为"恢复 v0.2 行为", 新 UT path / 60s TTL / cwd 不在 v0.3。
- [P1][R1] ch04 §3 Set A — `sigkill-reattach (NEW)` 从 Set A 移到 Set B (informational), 或显式标 "pending user approval"。
- [P1][R1] ch04 §4 — `sigkill-reattach` Asserts 改为 "v0.2 既有断言通过, 无 new behavior"。
- [P1][R1] ch05 PR-6 acceptance — 拆为 (a) v0.2 既有 attach-replay 恢复, (b) G-1..G-4 新策略 → v0.4 follow-up。

**Brief**:
**这是本轮 review 最大的 cross-file 议题, 也是 manager 必须先拍板的方向 (见 Notes)**。在 manager 拍板前, fixer 不应直接执行;一旦拍板:
- 若拍板 = "R1 严格保留派" → 按上述全部改写, sigkill 任何"标准化"语义 defer v0.4。
- 若拍板 = "维持 author 原案" → 仅在 ch00/ch03/ch04/ch05 添加显式 NEW 标注 + user/product approval 引用, 不删 G10。
本 CF 锁住 ch00/ch01/ch03/ch04/ch05 的相关段落 (与 CF-2 在 ch03 §3 / CF-1 在 ch04 §1 / CF-7 在 ch03 §1 不重叠 — sigkill 涉及 ch03 §4, ch04 §3/§4, ch05 G10/PR-6)。预计 30 行编辑。

---

### CF-4: feature-preservation guards for UI / RPC contract drift  files: [ch01, ch03, ch05]

**Findings owned (P0/P1)**:
- [P0][R1] ch03 §1 host 段 — "host 无条件渲染 + 错误状态 child 在 host 内部" 改 UI DOM, 必须先 cite v0.2 baseline (`git show 35b08d15^:src/components/TerminalPane.tsx`) 才能定写法。
- [P1][R1] ch01 HP-4 R1 — 同根, 加前置 audit step "fixer MUST git show v0.2"。
- [P1][R1] ch03 §5 input — 改"unknown sid silent drop → typed error"前必须证明 v0.2 行为, 否则保 silent drop。
- [P1][R1] ch03 §5 resize — cols/rows ≤0 改 reject 前必须证明 v0.2 已 reject;否则只 clamp 不 reject。
- [P1][R1] ch05 PR-4 acceptance — Retry-state path 改 acceptance 为 "保留 v0.2 DOM 结构, 只暴露 stable testid"。

**Brief**:
统一 R1 规则: refactor 不该改 v0.2 用户/dev 可观察行为。所有"看似清理"的契约变化都加一句 "fixer MUST verify v0.2 behavior at `35b08d15^` first; preserve unless user/product approval"。每条 finding 在对应 §/行追加 1-2 句即可。注意与 CF-7 (ch03 §1 R5 P0-1 的 testability) 分隔 — 本 CF 改 §1 host 段的 **R1 baseline-cite 要求**, CF-7 改 §1 末尾的 **UT 要求**, 同一 §1 不同段, 串行执行 (CF-4 先, CF-7 后)。预计 20 行编辑。

---

### CF-5: hydration-ordering & loadState failure path  files: [ch02, ch04]

**Findings owned (P0/P1)**:
- [P0][R3] ch02 §3/§4 — `loadState` 缺 failure 路径 (HTTP 5xx / fetch reject / JSON parse err);加 "rejection 视同 null + 一次 toast" + UT in `tests/stores/persist.test.ts`。
- [P1][R3] ch02 §4 I-3a — `theme==='system' ∧ osPrefersDark===undefined` 必须 pin 到 `light` (CSS root default)。
- [P1][R3] ch02 §4 — 扩 `__ccsmHydrationTrace` 形状 (loadStateStartedAt / loadStateResolvedAt / setStateStartedAt / error?), probe-utils dump 用。
- [P1][R5] ch04 §2 `waitForTerminalReady` timeout dump 也 dump `__ccsmHydrationTrace` (R3 P1-1 配套)。

**Brief**:
ch02 §3 加 MUST: rejection branch + toast + persist.test.ts UT;§4 I-3a 把 tiebreak pin 死;§4 trace 形状扩展 (列字段表)。ch04 §2 `waitForTerminalReady` 编辑段加一句 "timeout 时 `await win.evaluate(()=>window.__ccsmHydrationTrace)` 一并 dump"。**与 CF-9 (R1 theme P0) 必须协调**: R1 P0 要求 fixer cite v0.2 fallback, R3 P1 直接 pin `light`;Notes 已标 manager 决策点。本 CF 假设 R3 方向胜出, 但 fixer 在 manager 拍板前不要 hard-pin。

---

### CF-6: SSE reconnect dedup + sigkill TTL pin (reliability)  files: [ch03, ch04, ch05]

**Findings owned (P0/P1)**:
- [P0][R3] ch03 §2 — 加 G-5 reconnect dedup contract: `attach` 返回 `{snapshot, snapshotLastSeq}`, `pty:data` 带 `seq`, renderer 过滤 `seq <= snapshotLastSeq`, input 在 reconnect 窗口内 queue (cap 64KiB)。
- [P1][R3] ch03 §4 — pin TTL = 60s MUST + buffer cap 1MB/sid + ring-buffer 截断 + eviction log。
- [P1][R3] ch03 §5/§6 — error-token 收敛 closed enum (`no_such_sid` `pty_dead` `bad_request` `spawn_failed` `daemon_unavailable` `internal`), 每 RPC 列出自己 emit 的子集。
- [P1][R3] ch03 §6 — 加 daemon stderr 结构化格式 (`[ccsmd] <ISO> <level> <category>: ...` + `CCSMD_LOG_LEVEL` 默认 info)。
- [P1][R5] ch03 §2 — UT 第 4 case: subscriber close + reconnect → 仅 post-reconnect 事件, 无 replay。
- [P1][R5] ch03 §4 — TTL 4 个 boundary UT (TTL elapsed → GC; elapsed → 新 snapshot; reattach pre-TTL → 服 snapshot; detach+immediate-reattach → 无 race), 用 `vi.useFakeTimers()`。
- [P1][R3] ch04 §2 — harness-runner 捕捉 daemon stderr 到 `tmp/e2e-logs/<run-id>/<case>.electron.log`, fail 时 tail 200 行入 error message。
- [P1][R3] ch05 §1 — 加 G11 "stderr capture 0 个 error 级行";`grep -c '\] [0-9T:.-]+Z error '` returns 0。
- [P1][R3] ch05 PR-3/PR-6/PR-8 — §5 dispatch order recommendation 段加一段说明 R3 cross-cut PR (failure path / port counter / SSE dedup / TTL / probe dumps)。

**Brief**:
本 CF 是 R3 + R5 的"硬化集合"。
- ch03 §2 加 G-5 + UT 第 4 case;§4 pin TTL/cap/eviction + 4 boundary UT;§5 列每 RPC 的 token 子集;§6 加 stderr 格式 + LOG_LEVEL + token 闭合 enum 表 (与 CF-7 P2-1 token registry 同表, 本 CF 落地)。
- ch04 §2 harness-runner 段加 stderr capture 要求 + reset-between-cases R3 P2-1 不在本轮 (P2);**本 CF 不碰 ch04 §1 (CF-1)**, 也不碰 ch04 §3 (CF-3 /CF-12 sigkill set assignment)。
- ch05 §1 加 G11 行;§5 加 dispatch 段。
**与 CF-3 在 ch03 §4 协调**: CF-3 锁 sigkill-reattach 的"feature 范围", 本 CF 锁 sigkill 的 reliability 细节;manager 若拍 CF-3 = "v0.4 defer", 本 CF 的 TTL/cap/UT 也要随之 defer (整组 finding 转入 ch03 §7 out-of-scope)。串行: CF-3 先, CF-6 后。
预计 80 行编辑 (是本轮最大的 CF)。

---

### CF-7: testability — UT levers, ready signals, three-RPC roundtrip, TerminalPane UT  files: [ch02, ch03, ch04, ch05]

**Findings owned (P0/P1)**:
- [P0][R5] ch02 §4 — 加 "Required UT levers" 子节, 表列 I-1 (`tests/stores/store-eval-order.test.ts` NEW), I-3a/I-3b (extend `tests/app-effects/useThemeEffect.test.tsx`), §5 (`tests/stores/initialState.test.ts` NEW); 修 §4 line 227 "add a unit test" → "extend the existing"。
- [P0][R5] ch03 §1 host 段 — 加 MUST `tests/components/TerminalPane.test.tsx` (NEW), 三个 case (`claudeAvailable:false` / `true+crashed` / `true+idle`), 都 assert `getByTestId('terminal-host')`。
- [P0][R5] ch03 §3 — pin `spawnDaemon` ready signal (PORT line regex + 端口范围) + 10s timeout MUST reject + 错误处理 (fatal dialog + clean exit, no retry into createWindow) + `electron/__tests__/daemon-spawner.test.ts` 4 个 UT。重排 §3 让 Option C 契约自包含。
- [P0][R5] ch05 PR-4 — Files touched 改 `tests/components/TerminalPane.test.tsx (NEW)`;acceptance 加三个 case 描述。
- [P0][R5] ch05 PR-1/PR-5 — 标注 `daemon/api/__tests__/` 是 NEW dir;PR-1 改 `(NEW directory + file)`, PR-5 改 `(NEW; also creates the __tests__ directory)`;§3 顶部加一句 "where __tests__ subdir doesn't exist, PR creates implicitly"。
- [P1][R5] ch01 §"Symptom catalog" — 加第 5 列 `Regression-test lever (post-fix)` (S1..S9 表)。
- [P1][R5] ch01 HP-1 verdict — 加 "MUST UT in `tests/stores/store-eval-order.test.ts` (NEW)"。
- [P1][R5] ch01 HP-4 — verdict 改 "chapter 03 §1 必须暴露 host/term/buffer 三独立 assertion + chapter 04 §2 三独立 UT", `waitForTerminalReady` 返回 `{host, term, buffer, sid, cols, rows}`。
- [P1][R5] ch02 §2 Fix-B — 把 "MUST grep" 转成 `tests/stores/single-instance.test.ts` (NEW) Vitest test。
- [P1][R5] ch02 §3 — 扩 daemon-side UT 覆盖 (encoded keys / 大值 / `&?#%` 字符), 标 NEW dir。
- [P1][R5] ch02 §4 — 加 I-5 "cold paint MUST 仅 1 次 `loadState` 调用"; UT in `tests/stores/persist.test.ts`。
- [P1][R5] ch03 §5 — 三 RPC 各加 dedicated harness case (Set A): `pty-input-roundtrip` / `pty-resize-roundtrip` / `pty-claude-available-roundtrip`。
- [P1][R5] ch04 §2 — 加 §2.0 "Ready-signal contract" 表 (signal vs poll); 把 seedStore / waitForTerminalReady / daemon-port-ready 列出 signal 来源 (`ccsm:app-shell-ready` / `ccsm:terminal-host-mounted` / `ccsm:term-attached`)。
- [P1][R5] ch04 §4 — 三新 case 加 Budget 列 (`daemon-port-ready-before-render` ≤5s; `sigkill-reattach` ≤45s; `loadstate-roundtrip` ≤3s)。
- [P1][R5] ch04 §2 reset-between-cases — 加 runtime 不变量 (`beforeRef === afterRef`, 双重 store 检测)。
- [P1][R5] ch04 §3 — 加 "Set assignment" 子节, 承诺 `04b-case-set-assignment.md` (NEW)。
- [P1][R3] ch04 §4 `daemon-port-ready-before-render` — 把 assertion 收紧为 "first RPC ≤500ms wall-clock + `__ccsmDaemonPortLoadIterations === 0`"。
- [P1][R5] ch05 §1 — G5/G6/G7 "two consecutive runs" 措辞收紧: "same CI workflow invocation, both green; e2e job 配置跑两次"。
- [P1][R5] ch05 §3 — 加 §3.0 Symptom-to-PR closure map (S1..S9 → 哪些 PR, 验证 case)。
- [P1][R5] ch05 PR-3 — 加 timeout-rejected UT in `electron/__tests__/daemon-spawner.test.ts`。
- [P1][R5] ch05 PR-2/PR-4/PR-8 — 加 production-event-emit 责任 (PR-2 `ccsm:app-shell-ready` in App.tsx; PR-4 `ccsm:terminal-host-mounted`/`ccsm:term-attached`; PR-8 改 `waitForEvent`)。
- [P1][R5] ch03 §2 SSE G-1..G-4 → UT 映射 (与 CF-6 G-4 第 4 case 是同一加法 — 由 CF-6 落, 本 CF 不重复)。

**Brief**:
本 CF 是 R5 testability 全集落地。涉及四个 chapter 但重点是 ch02/ch03/ch04/ch05 — ch01 只加 1 列 (symptom catalog) + 改 HP-1/HP-4 verdict 措辞。
- 所有"NEW directory"标注和"extend vs create"措辞统一。
- `useThemeEffect.test.tsx` 已存在 → "EXTEND";`store-eval-order.test.ts` / `initialState.test.ts` / `single-instance.test.ts` / `TerminalPane.test.tsx` / `daemon/api/__tests__/data.test.ts` / `daemon/api/__tests__/pty.test.ts` / `daemon-spawner.test.ts` 都是 NEW。
- production-event-emit (`ccsm:*` 事件) 在 PR-2/PR-4 必须 emit, PR-8 才能 `waitForEvent`;若不接受, 退回 poll 并在 §2.0 表里 document 原因。
- **与 CF-2 在 ch03 §3 协调**: CF-2 改 §3 budget/failure-path, CF-7 改 §3 ready-signal/timeout/UT;两者编辑 §3 不同子段, 串行 (CF-2 先, CF-7 后)。
- **与 CF-4 在 ch03 §1 协调**: CF-4 改 §1 host R1 baseline-cite, CF-7 在 §1 末加 UT MUST;串行 (CF-4 先)。
- **与 CF-3 在 ch04 §3/§4 协调**: CF-3 决定 sigkill case 的 set 归属, CF-7 加 Budget 列;串行 (CF-3 先)。
- **与 CF-1 在 ch04 §1 不重叠** (CF-1 §1, CF-7 §2/§3/§4)。
预计 120 行编辑 (本轮最大);可拆 CF-7a (ch02) / CF-7b (ch03) / CF-7c (ch04) / CF-7d (ch05) 让 4 个 fixer 并行 — 但需要先全员对齐"NEW vs EXTEND"措辞。建议保持一个 fixer 串行落地以保证统一。

---

## Single-chapter fixers (parallel, disjoint files)

> 注: 当某 chapter 已被 cross-file fixer 锁住时, 该 chapter 的 single-chapter fixer 必须等所有相关 CF-* 完成后再启动 (file mutex)。

### F-00: chapter 00 — 残余 P1 (R3)  files: [ch00]

**Findings owned (P0/P1)**:
- [P1][R3] ch00 §3 iron rules — 加 §3.7 "Daemon liveness contract": `spawnDaemon` rejection → electron hard-exit + structured stderr; daemon mid-session exit → renderer toast via zustand error slice + disable pty/data RPCs; auto-restart defer v0.4。
- [P1][R3] ch00 §6 quality bar — 加 bullet 6 "daemon stderr 结构化要求" (cross-link ch03 §6 — CF-6 落地)。

**Brief**:
两条 R3 P1, 都是 ch00 内部加段。CF-6 已经在 ch03 §6 / ch04 §2 落地 stderr 格式;本 fixer 在 ch00 §3 加 §3.7 (引用 ch03 §6 / ch03 §7 的 spawn failure / mid-session policy), §6 加 bullet 6 (引用 ch03 §6)。**串行**: 必须在 CF-1 / CF-3 完成后启动 (都改 ch00)。约 15 行。

---

### F-01: chapter 01 — 残余 P1  files: [ch01]

**Findings owned (P0/P1)**:
- [P1][R3] ch01 HP-12 — 增加 leaked-daemon detection mechanism 描述 (cross-ref ch04 §2 reset hook); 但 ch04 §2 落地由 R3 P2-1 标 P2 → 本轮只在 ch01 HP-12 加一句 "detection mechanism per ch04 §2 (forward-ref)" 不动 ch04。

**Brief**:
仅一条 R3 P1。注意 R3 自己把 ch04 §2 reset hook 配套标 P2-1 (避免 double-count), 因此 ch04 §2 本轮不改。本 fixer 在 ch01 HP-12 verdict 行加 "If/when leak detected: ch04 §2 reset-between-cases hook is the planned mechanism (deferred to v0.4 unless v0.3 incident triggers promotion)"。**串行**: 必须在 CF-1/CF-2/CF-3/CF-4/CF-7 完成后启动。约 5 行。

---

### F-02: chapter 02 — 残余 P0/P1 (R1)  files: [ch02]

**Findings owned (P0/P1)**:
- [P0][R1] ch02 §4 I-3a — `theme==='system'+osPrefersDark===undefined` fallback 必须 cite v0.2 行为 (`git blame resolveEffectiveTheme`), 不能凭空 pin。**与 CF-5 R3 P1-1 (pin `light`) 冲突 → manager 拍板**。
- [P1][R1] ch02 §3 `loadState` resolve null MUST — 改"必须 preserve v0.2 missing-key 语义", git verify。
- [P1][R1] ch02 §3 `Promise<string|null>` 类型 — 改"preserve v0.2 type signature, 必要时 runtime assertion"。

**Brief**:
三条都是 R1 "必须 cite v0.2" 守护。**与 CF-5 共担 ch02** → 串行: CF-5 先, F-02 后。F-02 改完后, ch02 §4 I-3a 可能与 CF-5 冲突 (R1 要 cite v0.2, R3 要 pin `light`); fixer 必须先看 manager 决策再写 (见 Notes)。约 10 行。

---

### F-03: chapter 03 — 残余 P1 (无独立 single-chapter P1, 全部已被 CF 接走)  files: [ch03]

**Findings owned (P0/P1)**:
- (空)

**Brief**:
ch03 所有 P0/P1 已被 CF-2 / CF-3 / CF-4 / CF-6 / CF-7 接走;无独立 single-chapter fixer。F-03 槽位保留给后续 round (例如 R2 P1-1 loopback bind, 是 P1, 见下)。

实际上 R2 P1-1 (loopback bind) 是 P1 — **补回**:
- [P1][R2] ch03 §3 — daemon HTTP 必须 bind `127.0.0.1`, 加 MUST + cross-link ch02 §1 footer + ch05 G9 收紧 (gate 措辞);ch02 §1 footer + ch05 G9 是跨章 → 升 cross-file。

**修正**: 这条 finding 改归 CF-8 (见下)。F-03 真空。

---

### CF-8: loopback-bind hardening (R2 P1)  files: [ch02, ch03, ch05]

**Findings owned (P0/P1)**:
- [P1][R2] ch03 §3 — 加 MUST "daemon HTTP server MUST bind `127.0.0.1` only; binding to `0.0.0.0` / `::` / 任何非 loopback = P0 regression"; cross-link ch02 §1 + ch05 G9。
- [P1 effectively, R2 P2-1 promoted to P1 by association] ch05 §1 G9 — 收紧 gate 措辞 + grep tooling: "no transport regression AND no daemon HTTP listen widening"; tooling line 加 `grep diff for daemon listen address`。
- ch02 §1 — surface catalog footer 加一句 cross-link ch03 §3 loopback MUST。

**Brief**:
R2 唯一 P1 + 配套 P2-1 (gate 落地)。三处编辑统一 loopback 守护。**与 CF-2 (ch03 §3 budget)/CF-7 (ch03 §3 ready-signal) 协调**: 同 §3, 不同子段, 串行 (CF-2 → CF-7 → CF-8)。**与 CF-1 (ch04 §1) 无交集**;与 CF-6 (ch05 §1 G11) 在 §1 不同行 (G9 vs G11), 可并行但建议串行避免合并冲突。约 10 行。

---

### F-04: chapter 04 — 残余 P0/P1 (R5 + R3 + R1)  files: [ch04]

**Findings owned (P0/P1)**:
- [P0][R5] ch04 §2 — Ready-signal contract §2.0 (已归 CF-7)。
- [P1][R3] ch04 §2 — `waitForTerminalReady` timeout dump 扩展 (已归 CF-5)。
- [P1][R3] ch04 §2 — daemon stderr capture (已归 CF-6)。
- [P1][R3] ch04 §4 — `daemon-port-ready-before-render` 收紧 assertion (已归 CF-7)。
- [P1][R5] ch04 §4 budget 列 / §3 set assignment / §2 reset-between-cases runtime invariant — 已归 CF-7。
- [P1][R1] ch04 §3 Set A — sigkill 移 Set B (已归 CF-3)。
- [P1][R1] ch04 §4 sigkill assertions 改写 (已归 CF-3)。

**Brief**:
ch04 所有 P0/P1 都被 CF-1 / CF-3 / CF-5 / CF-6 / CF-7 接走;F-04 真空。保留槽以备 round-2。

---

### F-05: chapter 05 — 残余 P0/P1  files: [ch05]

**Findings owned (P0/P1)**:
- [P0][R1] ch05 G10 (已归 CF-3)
- [P0][R5] ch05 PR-4/PR-1/PR-5 paths (已归 CF-7)
- [P0][R5] ch05 G8 措辞 (已归 CF-1)
- [P1][R3] ch05 PR-3 rollback (已归 CF-2)
- [P1][R3] ch05 G11 (已归 CF-6)
- [P1][R4] ch05 §7 Risk-1 enforcement (已归 CF-2)
- [P1][R1] ch05 PR-3 latency budget (已归 CF-2)
- [P1][R1] ch05 PR-4 acceptance (已归 CF-4)
- [P1][R1] ch05 PR-6 acceptance (已归 CF-3)
- [P1][R5] ch05 §3.0 symptom-to-PR map (已归 CF-7)
- [P1][R5] ch05 G5/G6/G7 措辞 (已归 CF-7)
- [P1][R5] ch05 PR-3 timeout UT (已归 CF-7)
- [P1][R5] ch05 PR-2/PR-4/PR-8 event-emit (已归 CF-7)
- [P1][R2 promoted] ch05 G9 (已归 CF-8)

**Brief**:
ch05 全部 P0/P1 已归 cross-file fixer;F-05 真空。

---

## File-mutex matrix (which CF/F locks which chapter)

| chapter | CF-1 | CF-2 | CF-3 | CF-4 | CF-5 | CF-6 | CF-7 | CF-8 | F-00 | F-01 | F-02 |
|---------|------|------|------|------|------|------|------|------|------|------|------|
| ch00    | X    |      | X    |      |      |      |      |      | X    |      |      |
| ch01    | X    | X    | X    | X    |      |      | X(§Symptom/HP-1/HP-4) |      |      | X    |      |
| ch02    |      |      |      |      | X    |      | X    | X    |      |      | X    |
| ch03    |      | X(§3) | X(§4) | X(§1,§5) |      | X(§2,§4,§5,§6) | X(§1,§3,§5) | X(§3) |      |      |      |
| ch04    | X(§1) |      | X(§3,§4) |      | X(§2) | X(§2) | X(§2,§3,§4) |      |      |      |      |
| ch05    | X(G8) | X(PR-3,§7) | X(G10,PR-6) | X(PR-4) |      | X(G11,§5) | X(§1,§3,§3.0,PR-1/2/3/4/5/8) | X(G9) |      |      |      |

**Recommended dispatch sequence** (顶层串行):
1. **决策门** (manager): 读 Notes, 拍 sigkill 方向 (CF-3) + theme fallback 方向 (CF-5 vs F-02);**未拍前 CF-3/CF-5/F-02 暂停**。
2. **Wave A (并行)**: CF-1 (skip baseline) + CF-2 (cold-launch budget) + CF-4 (R1 UI/RPC guards) + CF-8 (loopback bind) — 这 4 个 CF 在 ch03 §3 上有重叠 (CF-2/CF-4/CF-8), 实际 wave A 内串行: CF-1 ‖ (CF-2 → CF-4 → CF-8)。
3. **Wave B (manager 拍板后)**: CF-3 (sigkill 方向) + CF-5 (hydration failure path) — 与 wave A 串行。
4. **Wave C**: CF-6 (SSE/TTL/stderr) — 必须 CF-3 后, 因 CF-3 可能让 CF-6 全组 finding 转 v0.4。
5. **Wave D**: CF-7 (testability 全集) — 必须 wave A/B/C 后, 因为 ch03 §1/§3 / ch04 §3/§4 / ch05 G8/G10/PR-* 都已被前 CF 改过, CF-7 在已稳定 spec 上加 UT layer。
6. **Wave E**: F-00 / F-01 / F-02 / 残余 single-chapter 编辑。

---

## Notes / open questions for manager

1. **R1 P0 sigkill-reattach 是否升 release gate (G10)?**
   - 反对方: R1 (5 条 P0/P1 横跨 ch00/ch01/ch03/ch04/ch05) — sigkill 任何"标准化" (60s TTL, cwd 弃 snapshot, NEW harness case 入 Set A, G10 锁 ship) 都是 v0.3 refactor 不该带的 NEW feature, 应 defer v0.4。
   - 支持方: author Q3 把 sigkill 列 v0.3 必修 (chapter 00 §3.4 iron rule + chapter 04 §4 NEW case + chapter 05 G10);R3 也要求 pin TTL=60s 作为可靠性必修。
   - **manager 拍板影响**: CF-3 / CF-6 整组 findings;若选 R1 严守 → CF-3 删 G10/PR-6 acceptance 拆半 + CF-6 整组 (TTL/cap/UT) 转 v0.4 ch03 §7 out-of-scope。若选 author 原案 → CF-3 仅加 NEW 标注 + user-approval 引用, CF-6 全部落地。

2. **R5 SKIP reconcile = 0 .skip + 1 KEEP, ch04 矩阵需重写, 同步 ch00/ch01/ch05**
   - 5 reviewer 一致 (R5 P0-1 + ch01 R5 P2-2 + ch00 R5 P0-1 + ch05 R5 P0-3) — dev-574 "88 .skip" 是 phantom (实际是 case×capability-flag 评估次数);ch04 §1 KEEP/DELETE/FIX/MARK 必须重写为 §1.1/§1.2/§1.3 三段。
   - 由 CF-1 落地, 无歧义。**唯一 manager 决策点**: §1.3 真实 `requiresClaudeBin / windowsOnly / darwinOnly` 枚举工作要不要进 v0.3? 推荐"进", 因为 R5 估计 ≤15 entries 一次扫完 — 但要派一个独立 dev (不是本 plan 的范围)。

3. **R1 P0 vs R3 P1 在 ch02 §4 I-3a (theme fallback) 直接冲突**
   - R1 P0: fallback (theme==='system' + osPrefersDark===undefined) 必须 cite v0.2 行为, 不能凭空 pin。
   - R3 P1: 必须 pin 到 `light` (CSS root default 是浅色), 否则 SSR 不一致导致 theme-toggle 测试 flake。
   - **manager 拍板**: 若 v0.2 行为本来就是 `light` (高概率, 因为 CSS root 默认浅) → R3 方向胜出, R1 P0 降级为 "spec 加一句 'pinned to light = matches v0.2 fallback, verified at 35b08d15'"。若 v0.2 行为是别的 → 先派 dev 跑 `git show 35b08d15^:src/app-effects/useThemeEffect.tsx` 抽 ground truth, 再决定。建议 manager 先派 1 个 dev 做 5 分钟 git ground-truth, 不要让 fixer 在 spec 阶段瞎写。

4. **chapter 01 Q3 "requiresClaudeBin fail-vs-skip" 是 product 决策, 不该让 reviewer 投票**
   - R1 P2 (ch01) + R1 P2 (ch05) 都指出此点。本轮 P2 不修, 但 manager 应在 stage-3 前后**显式问 user**;否则 stage-4 fix 阶段会有 fixer 凭感觉做选择。
