# Agentory-next MVP Design

冻结日期：2026-04-18
状态：MVP 设计锁定，开始 scaffold 前的 single source of truth。

## 1. 定位与原则

- **核心差异**：group-first / repo-agnostic。Group 是用户定义的任务/领域容器，repo 只是 session 的元数据。
- **成功指标**：作者本人连续 30 天日用，且体验优于裸 CLI。朋友不在 KPI 内。
- **硬截止**：8 周达到 daily-self-use。
- **设计原则**：
  - CLI 视觉 + GUI 交互（详见 MEMORY 中"CLI visual + GUI interaction"）。
  - 不发明用户不会维护的状态。
  - 不约束用户。可逆 + 默认放行。
  - 状态优先派生自系统信号。

## 2. 技术栈（锁定）

Electron · React 18 · TypeScript · Tailwind v4 · shadcn/ui · Zustand · @dnd-kit · Claude Agent SDK（Node sidecar / main process）· SQLite（better-sqlite3）· 自定义 React renderer（无 xterm）· Vitest · Playwright。

> 从 Tauri 2 切到 Electron：纯壳层选择。视觉/交互由 React+Tailwind 决定，与壳层无关。Electron 选择换取更成熟的生态、更小的踩坑面、Node SDK 的进程内集成。

## 3. MVP 范围

In：
1. Claude Code（Agent SDK）
2. 自定义 group
3. 三态生命周期 ● / ⚡ / 🅿
4. 一个 group 里跨 repo 的 session
5. CLI 视觉风格的结构化对话流渲染
6. Import：扫 `~/.claude/projects/` 的历史 session
7. 全局搜索 / Command Palette（Cmd/Ctrl+K）
8. Settings（API key、data dir、theme、font、shortcuts、auto-update）
9. Sidebar 折叠
10. Session header（名字 + group + 状态 + rename + move-to-group）
11. Toast 通知（状态变化、错误）
12. Status bar（cwd + 当前 model）
13. Auto-update 检查（在 Settings 内）
14. Onboarding 首屏（Create / Import）

Out：Codex / Gemini 适配器、IM bridge、server mode、MCP marketplace、mobile、团队功能、消息 queue、tabs/split-view、account 区、slash command 自动补全、多 agent。

## 4. 状态机

二态：`idle` · `waiting`（需要用户输入）。UI 上只有 waiting 会提醒（呼吸光晕），idle 是静态默认态。

合法迁移：
```
┌─────────┐  agent 停下等输入    ┌─────────┐
│  idle   │ ──────────────────▶ │ waiting │
│ (静态)  │                     │ (呼吸)  │
│         │ ◀────────────────── │         │
└─────────┘  用户点进这个 session └─────────┘
```

设计意图：
- **没有显式 "park"**。用户切到别的 session 而不回复，就是隐式 park —— 用户不用维护、不用按钮。
- **没有 "running"**。跑没跑不是用户的决策轴，是 SDK 内部细节。用户只关心"这个 session 需不需要我"。
- **点击 = 已知悉**：点 waiting session 后立刻回到 idle，呼吸光晕停止。

边界：
- SDK crash / 进程退出 → 置 waiting，对话流尾部插 `[session interrupted]` 标记。
- 用户在 waiting 状态发送输入 → SDK `query({ resume: sessionId })` 恢复上下文。
- 删除 session：单一通用确认弹窗，不分状态。

## 5. Sidebar 结构

两列布局，左侧 sidebar 可展开树。视觉极简：无分区 border、无 section 标签，区域靠留白 + 颜色层级自然分隔。

```
Agentory                    [«]
[🔍 Search…            ⌘K]
[+  New Session]

▾ Group A                  [+]
    session 1
  ✦ session 2              ← waiting：呼吸光晕
▾ Group B                  [+]
    session 3
+ New group                        ← quiet row, nav 末尾

[⋯]  [⚙ Settings]
```

**设计决定（已定，勿反复改）**

- **无分区视觉**：不画 `border-t` / section header / 背景色区块。层级靠 weight + color + 留白。
- **Archive / Deleted 不占顶层空间**。它们是月频操作，进底部 `[⋯ More]` DropdownMenu（Archive / Deleted / Collapse all groups）。
- **高频 vs 低频动作分层**：
  - 顶部：Search（⌘K）、New Session —— 每天用。
  - nav 内：Group list、New group（quiet row，周频）。
  - 底部：`⋯` More、Settings —— 月频或更低。
- **Group 行**：点击 chevron 折叠，右侧 hover 显示 `[+]`；collapsed 时显示 session 总数。
- **Session 行**：Agent icon + 名字；active 左侧 3px accent 竖条；waiting 时 icon 外包 oklch amber 的呼吸光晕（framer-motion，1.6s 循环）。不做角标。
- **Session 内排序**：用户拖拽决定（数组序即真相）。不按状态自动排。
- **拖拽**：`@dnd-kit` 整行 draggable，activationConstraint `distance: 6px`。支持组内重排 + 跨组迁移（同时改 `groupId` 和位置）。DragOverlay 浮层 = 原行克隆，不倾斜；原位透明度 0.4。
- **右键菜单**：
  - Session：Rename / Move to group ▾ / Delete
  - Group：Rename / Delete
- **Rename**：inline edit，Enter 提交 / Esc 取消。
- **Unpark 无按钮**：没有 park 这个状态，不需要 unpark。切 session 回来就是回来。
- **首次启动**：仅 "Create your first session" / "Import session" 两个入口。
- **没 group 就新建 session**：自动建默认 group。

### 5.1 Sidebar 折叠（实现已定）

- 展开宽 `256px` / 折叠宽 `48px`。
- 过渡：`framer-motion` width 动画，220ms，`cubic-bezier(0.32, 0.72, 0, 1)`。
- 折叠触发方式三个，等价：
  1. 顶部 `[«]` / `[»]` IconButton
  2. `⌘B` / `Ctrl+B` 全局快捷键
  3. 右边缘 1.5px 宽可点击 rail（hover 时 1px accent hairline 显现）
- **不迁 shadcn Sidebar**：外壳只有 ~30 行，shadcn 的价值（Dialog/Command/Form 等复杂组件）在此 ROI 低，且需做 token 映射（`--sidebar-*` ↔ `bg-bg-sidebar`）增加认知负担。内部 `GroupRow`/`SessionRow` 是 Agentory 专属 UI（rollup、state glyphs、cwdTail），无库可救，继续手搓。
- 折叠状态本地持久化（SQLite）。

### 5.2 Archive 行为

- Archive 一个 group：组内所有 session 冻结，只读不可交互。
- 从底部 `⋯` 菜单进入 Archive / Deleted 视图（MVP 可以是简单的列表弹层，不必做成独立路由）。

## 6. 全局搜索 / Command Palette

- 唯一入口：Cmd/Ctrl+K，或 sidebar 顶部搜索框点击。
- 单一弹层，混合结果：
  - Sessions（按名字、group、cwd 模糊匹配）
  - Groups
  - Commands（New session / New group / Toggle sidebar / Open settings / Switch theme）
- Enter 跳转 / 执行；Esc 关闭。
- 不做对话内容全文检索（MVP out，jsonl 量级未知，避免性能坑）。

## 7. 右侧对话流

5 项渲染规则（CLI 视觉风格）。无 session header，纯对话流；底部固定 status bar + 输入区。当前是哪个 session 由 sidebar 高亮表示。

### Q1 消息块样式
- 等宽字体，无气泡，无背景色，无圆角。
- 左侧标识符：`>` user · `●` assistant · `⏺` tool。
- 块之间用一个空行分隔。

### Q2 工具调用
- `⏺` 默认折叠为一行：`⏺ Read(file.ts)` / `⏺ Bash(npm test)`。
- 点击展开看参数 + 结果。

### Q3 输入区
- 底部固定，多行 textarea。
- **Enter 发送，Shift+Enter 换行**（跟用户的 CLI 习惯一致）。
- ● Running 时输入框禁用，显示 Stop 按钮。
- MVP 不实现 queue。

### Q4 滚动
- 默认自动跟随到底部。
- 用户手动上滚后停住，显示 "↓ Jump to latest" 按钮。
- 点击按钮或发送新消息恢复跟随。

### Q5 ⚡ Waiting 提示
- 对话流末尾插入高亮块，带操作按钮：
  - permission → Allow / Deny
  - plan approval → Approve / Reject
  - 普通问题 → 输入框聚焦
- 侧边栏对应 session 行同步显示 ⚡ 图标。

### Status bar
- 输入框正上方一行 dim text：`cwd: <path>  ·  model: <claude-...>`。
- 派生自 SDK / session 元数据，用户不维护。

## 8. Settings

通过 sidebar 底部 ⚙ 或 Cmd/Ctrl+, 打开。模态弹层，分组：
- General：theme（system / light / dark）、font family、font size。
- Account：Anthropic API key（本地存储，明文 OK，MVP 单用户）。
- Data：data dir 路径（显示，不可改 MVP，避免迁移坑）、`~/.claude/projects/` 路径（只读显示）。
- Shortcuts：列出所有快捷键（只读 MVP，不让用户改 — 改键 = 维护负担）。
- Updates：当前版本 + "Check for updates" 按钮（基于 electron-updater，手动触发，不后台静默）。

## 9. Toast 通知

bottom-right，3s 自动消失，最多堆 3 个。触发：
- session 状态变化（● → ⚡，特别是后台 session 进入 Waiting）
- SDK 错误 / crash
- API key 缺失 / 无效
- 不为成功操作发 toast（user-initiated 操作有视觉反馈即可，避免噪音）

## 10. 数据 / 持久化

- SQLite 存：group / session 元数据 / 用户自定义顺序 / 自定义名称 / sidebar 折叠状态 / theme。
- 对话历史：依赖 SDK 在 `~/.claude/projects/` 的 jsonl，不重复存。
- 启动时：扫 `~/.claude/projects/` 与 SQLite 对账；jsonl 中存在但本地未挂到 group 的 session → 进入"Imported"默认 group。
- API key：OS keychain（electron `safeStorage`），不入 SQLite。

## 11. 快捷键（MVP 全集）

- Cmd/Ctrl+K：搜索 / Command Palette
- Cmd/Ctrl+,：Settings
- Cmd/Ctrl+N：新 session（在当前 group，无则建默认 group）
- Cmd/Ctrl+Shift+N：新 group
- Cmd/Ctrl+B：折叠/展开 sidebar
- Enter：发送
- Shift+Enter：换行
- Esc：关闭弹层 / 取消 inline edit

不做：自定义快捷键、vim mode、多 chord。

## 12. 不在 MVP 的（明确写下来防止漂移）

- 多 agent（Codex / Gemini）
- IM bridge / server mode / mobile
- MCP marketplace
- 消息 queue
- Ctrl+C 作为通用中断（用 Stop 按钮）
- slash command 自动补全
- 团队 / 协作
- tabs / split-view
- account / 用户中心
- 对话内容全文检索
- 自定义快捷键
- data dir 迁移

## 12.1 SDK 默认值（不暴露 UI，但已锁定）

- **Extended thinking**：调 `query()` 时硬编码开启 + 取该 model 支持的最大 budget。
  - 理由：用户不在意这个旋钮；如果让选，他一定选最高的。那就直接给最高，省一次决策。
  - 不做 effort selector。Opus 4 的 budget 上限在接 SDK 时 verify 当时数值，避免文档写死后漂移。

## 13. 待解决（不阻塞 scaffold）

- Edge case 清单（来自之前 subagent 的竞品/审计）：放 `docs/triage.md`，post-MVP 再处理。

## 14. 完整 UI ASCII Mockup

```
┌──────────────────────────────────┬────────────────────────────────────────────────────────┐
│ [«]  Search…              ⌘K     │                                                        │
│ [+ New Session]                  │  > 把 webhook handler 改成异步队列消费                  │
│ ─────────────────────────────    │                                                        │
│ ▾ Backend Refactor        [+]    │  ● 我先看一下当前的 handler 实现，再给方案。            │
│   ● webhook-worker               │                                                        │
│   ⚡ webhook-async  ◀ active     │  ⏺ Read(src/webhook/handler.ts)                        │
│   🅿 old-sync-impl               │  ⏺ Grep("publish\\(", src/)                            │
│                                  │  ⏺ Bash(npm test -- webhook)                           │
│ ▾ Investigations          [+]    │                                                        │
│   ● oom-repro                    │  ● 方案：抽出 `WebhookJob`，用 BullMQ 做队列。          │
│                                  │    需要新增 redis 依赖，确认可以吗？                    │
│ ▸ Docs                    [+]    │                                                        │
│                                  │  ┌──────────────────────────────────────────────────┐  │
│ [+ New Group]                    │  │ ⚡ Permission requested                           │ │
│ ▸ Archive                        │  │ Add dependency: bullmq@^5                         │ │
│ ▸ Deleted                        │  │                          [ Deny ]  [ Allow ]      │ │
│                                  │  └──────────────────────────────────────────────────┘  │
│                                  │                                                        │
│                                  │                                       [↓ Jump to latest]│
│                                  │ ────────────────────────────────────────────────────── │
│                                  │  cwd: ~/projects/payments-api  ·  model: claude-opus-4 │
│                                  │ ┌────────────────────────────────────────────────────┐ │
│                                  │ │ Reply…  (Enter send · Shift+Enter newline)         │ │
│                                  │ │                                                    │ │
│                                  │ └────────────────────────────────────────────────────┘ │
│ ─────────────────────────────    │                                                        │
│ [⚙ Settings]                     │                                                        │
└──────────────────────────────────┴────────────────────────────────────────────────────────┘

                                                  ┌──────────────────────────────────────┐
                                                  │ ⚡ webhook-async needs your input    │
                                                  └──────────────────────────────────────┘
                                                                              (toast, br)
```
