# R1 review of 03-ptyhost-wiring — feature-preservation

Reviewer: R1 (feature-preservation)
Round: 1

## Findings

### P0 — §1 "host 无条件渲染 + 错误状态 child 在 host 内部" 改了 UI 结构
**Location**: `03-ptyhost-wiring.md` §1 "`host` — TerminalPane host element exists" → "Required gate change"
**Issue**: spec 写 "There MUST NOT be a 'claudeAvailable === true' conditional render around the host element. The pane MAY render an error-state child (Retry button) inside the host when claude is missing"。这条**直接规定了 v0.3 的 UI DOM 结构**:claude 缺失时, 用户看到的不再是某个独立 "Claude not installed" 屏 (如果 v0.2 是这样), 而是一个空的终端容器 + 内嵌 Retry 按钮。这是用户可见 UI 改动, 没有引用 v0.2 实际形态作为基线。
**Why blocker**: P0 — refactor 不该改 UI 形态。即使最终 v0.2 已是这个结构, spec 也必须 cite v0.2 baseline 才能这么写;否则下游 fixer 可能"按 spec 字面"改 DOM 树, 改变用户体验。和 01-cutover-audit HP-4 R1 是同一根问题, 这里是落地处。
**Suggested fix**: §1 第二段改为 "The fixer MUST first inspect `git show 35b08d15^:src/components/TerminalPane.tsx` to record v0.2's claude-missing branch. If v0.2 already renders host unconditionally with an inline error child → preserve. If v0.2 swaps host for an error screen → preserve that and instead expose a stable `data-testid` on whichever element actually mounts (harness selector adapts, not UI)。"

### P0 — §4 "snapshot 60s TTL + cwd mismatch 弃 snapshot" 是 v0.3 新引入产品规则
**Location**: `03-ptyhost-wiring.md` §4 "Implementation responsibilities" 第一条 + "Edge case" 段
**Issue**: spec 引入两条**全新的产品语义**:
1. "daemon MUST retain the pre-kill buffer for the sid until either (a) the renderer issues `detach` and never reattaches before a TTL (e.g. 60s)" — 60s TTL 是凭空冒出来的数字, 没有 v0.2 baseline。
2. "If the renderer's `spawn` carries a different `cwd` than the original, the daemon MUST treat it as a NEW pty (snapshot discarded). Document this in `daemon/api/pty.ts` doc-comment." — 这是新行为契约 (用户改 cwd 时旧 buffer 消失), v0.2 行为未引用。
**Why blocker**: P0 — 这两条都是用户可观察行为 (尤其 cwd-mismatch: 用户改目录后会"丢上下文")。v0.3 是 daemon-split refactor, 不应引入 reattach 的新策略。和 chapter 00 §3 iron rule 4、chapter 01 HP-8 是连环 scope creep。
**Suggested fix**: §4 改为 "v0.3 仅恢复 v0.2 sigkill-reattach 已有行为 (snapshot 保留策略和 cwd 行为均沿用 v0.2 默认; 如果 v0.2 没明确策略, 则 v0.3 也不引入)。任何 TTL / cwd 语义 = v0.4 spec, defer。"

### P1 — §5 "input RPC error-typed response" 可能改静默丢弃 → 用户可见错误
**Location**: `03-ptyhost-wiring.md` §5 "`input` (SendInput)" 第三条 MUST + Anti-stub rule 段
**Issue**: spec 要求 "error-typed response (`{ ok: false, error: 'no_such_sid' }`) if the sid does not exist. NOT 200 + silent drop"。如果 v0.2 IPC 实现是 silent drop (write to dead sid 不报错), v0.3 改成 typed error → renderer 会触发错误处理路径 (toast / sentry / store error slice), **用户可见**。
**Why blocker**: P1 — 改 user-facing 错误信号面。refactor 应保留 v0.2 行为 (silent drop 即 silent drop), 而非借机修正"应该有错误"。
**Suggested fix**: §5 input MUST 改为 "preserve v0.2 unknown-sid behavior (verified via `git blame`); if v0.2 silently drops, v0.3 MAY return `{ok:true, dropped:true}` for diagnostics 但 renderer error path MUST NOT 触发新 toast。"

### P1 — §5 "resize cols/rows 验证 → 400" 是新的输入验证, 改了 RPC 容错
**Location**: `03-ptyhost-wiring.md` §5 "`resize` (Resize)" 第三条 MUST
**Issue**: "validate `cols > 0`, `rows > 0`, both integers; reject 400 on invalid" — 如果 v0.2 IPC 接受非法 cols/rows (例如 cols=0) 然后 pty 内部静默 clamp, v0.3 改 400 等于把"曾被接受的输入"改为错误。renderer 可能在 resize observer race 里偶尔传 0/小数, 之前能跑, 现在 break。
**Why blocker**: P1 — 改 RPC 容错模型 = 改 dev-loop 可观察行为 (新 toast / 新 sentry 上报)。
**Suggested fix**: §5 resize MUST 改为 "preserve v0.2 input acceptance; fixer MUST add UT 证明 v0.2 已 reject 同样输入, 否则只 clamp 不 reject。"

### P1 — §3 Option C 改窗口启动时序但没量化预算
**Location**: `03-ptyhost-wiring.md` §3 "Decision" 段 ("MUST adopt Option C ... The window-show latency penalty is sub-second on every measured platform")
**Issue**: Option C 把 `await spawnDaemon()` 提前到 BrowserWindow 创建之前, **直接增加用户冷启动可见延迟** ("点击图标 → 窗口出现")。spec 写 "sub-second on every measured platform" 但**未引用具体数字**, 没给 v0.3 fixer 验收阈值, 也没给后续回退条件 (chapter 05 §7 Risk-1 提到 ">500ms 回退" 但本章没引)。
**Why blocker**: P1 — 用户可见时序变化, 必须有可机械验证的阈值, 否则等于"事后看心情"。
**Suggested fix**: §3 Decision 段补 "Acceptance: v0.3 cold-launch (click-to-window) latency MUST regress ≤500ms vs v0.2 baseline, measured on Windows primary dev box (per chapter 05 §7 Risk-1)。如果实测超过, fixer MUST 回退到 Option B。"

### P2 — §6 "renderer MAY display error token raw" 可能产出新 UI 文案
**Location**: `03-ptyhost-wiring.md` §6 "Error surface conventions"
**Issue**: "`error` is a stable lowercase token (`no_such_sid`, `bad_request`, `spawn_failed`). The renderer MAY display it raw" — 如果 renderer 真的 raw display, 用户会看到从未有过的英文 token (e.g. toast 上 "no_such_sid")。"MAY" 给了 fixer 自由度, 但没规定 v0.3 默认走哪条路 (raw vs 翻译)。
**Why blocker**: P2 — 文案变化风险中等, 取决于 fixer。
**Suggested fix**: §6 末尾补一句 "v0.3 默认 = renderer NOT display raw token; 任何用户可见错误文案 MUST 沿用 v0.2 既有 i18n key。新 token → silent log only。"

### P2 — §2 G-2 "subscribe AFTER pty has produced data MUST be served via attach, NOT SSE backlog" 可能改首次连接体验
**Location**: `03-ptyhost-wiring.md` §2 "Required guarantees" G-2
**Issue**: "SSE is 'live tail only'" 是显式新策略。如果 v0.2 IPC 实现里 late attach 会 replay 全部历史 (因为 IPC 是 request/response, 没有"backlog"概念), v0.3 引入"SSE 不 backlog" + "attach 必须显式拿 snapshot" 等于把"自动 replay"变成"必须显式 attach"。renderer 现有调用如果只 onSSE 不 attach, 会少看到老数据。
**Why blocker**: P2 — 取决于 v0.2 实现是否有这个 race;但 spec 应明确"v0.3 attach 调用点 = 100% 覆盖 v0.2 自动 replay 的所有 case"。
**Suggested fix**: §2 G-2 后追加 "fixer MUST audit 渲染端所有 SSE subscribe 站点, 确认每处都先 attach 再 onSSE; 否则 v0.2 自动 replay 的用户体验会丢失。"
