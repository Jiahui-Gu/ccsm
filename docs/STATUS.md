# Implementation Status

最后更新：2026-04-21

这是 agentory-next 当前实现进度的对账表。每个 PR 合并后必须更新本文件，让"已实现 vs 待实现"始终一目了然。

`docs/mvp-design.md` 是设计的 single source of truth；本文件是实现进度。两者冲突时，以 mvp-design.md 为准（除非显式更新设计）。

## 图例

- ✅ 已落地，连真实数据/真实行为
- 🟡 UI 已就位，但用 mock 数据或 `/* wire to store later */` stub
- ⬜ 完全未实现
- 🚫 显式 out-of-scope（参考 mvp-design.md §12）

## 1. 架构层

| 项 | 状态 | 备注 |
|---|---|---|
| Electron 壳（main + preload） | ✅ | `electron/main.ts` 启动单窗口；preload 是空 stub。 |
| React 18 + TS + Tailwind v3 | ✅ | webpack 5 dev server，端口 4100。 |
| Radix-based 手搓 ui/ 原语 | ✅ | Dialog / DropdownMenu / ContextMenu / Tooltip / Toast / ConfirmDialog / Button / IconButton / InlineRename / StateGlyph。 |
| framer-motion / lucide-react / @dnd-kit | ✅ | 已装并在 Sidebar 用。 |
| Zustand store | ✅ | `src/stores/store.ts` 持有 sessions/groups/recentProjects/UI 状态 + 15 actions；App.tsx 全量消费。 |
| better-sqlite3 持久化 | 🟡 | `electron/db.ts` 起 WAL，`app_state(key,value)` 单表；`db:load`/`db:save` IPC + preload bridge；renderer 通过 `hydrateStore()` 启动加载、debounced 250ms 写回。schema 是单 JSON blob，结构化 schema 留给后续。 |
| Claude Agent SDK 集成 | ⬜ | 未装包，未起 sidecar。 |
| `~/.claude/projects/` 导入 | ⬜ | |
| 全局快捷键注册 | 🟡 | `App.tsx` 注册了 Cmd+K / Cmd+, / Cmd+B；Cmd+N / Cmd+Shift+N 未实现。 |

## 2. Sidebar（`src/components/Sidebar.tsx`）

| 项 | 状态 | 备注 |
|---|---|---|
| 顶部 New Session + Search 按钮 | ✅ | 真触发 createSession / 打开 palette。 |
| Groups 列表渲染 | ✅ | 数据来自 store（store 用 mock 初始化，待 SQLite 接入）。 |
| Group 折叠/展开 + chevron 旋转动画 | ✅ | collapsed 持久化到 store。 |
| 拖拽 session 重排 + 跨组迁移 | ✅ | @dnd-kit + `onMoveSession`，App.tsx 已实现 setSessions。 |
| Session active 3px accent 竖条 | ✅ | framer-motion enter 动画。 |
| Session waiting 状态点 | 🟡 | 用红色小圆点表示，但 mvp-design.md §5 写的是"icon 外包 oklch amber 的呼吸光晕"——视觉对齐要 follow up。 |
| Session 右键 Rename | ✅ | InlineRename commit → `renameSession`。 |
| Session 右键 Move to group | ✅ | 子菜单列出 normal groups → `moveSession`；"New group…" 创建后 move。 |
| Session 右键 Delete | ✅ | ConfirmDialog → `deleteSession`。 |
| Group 右键 Rename | ✅ | InlineRename commit → `renameGroup`。 |
| Group 右键 Archive/Unarchive | ✅ | `archiveGroup` / `unarchiveGroup`。 |
| Group 右键 Delete group | ✅ | ConfirmDialog → `deleteGroup`（连带删 sessions）。 |
| "+ New Group" 按钮 | ✅ | onClick → `createGroup()`。 |
| Archived Groups 底部折叠区 | ✅ | UI 已实现；archived 数据来自 mockGroups。 |
| Deleted Groups 视图 | ⬜ | mvp-design.md §5 提到底部 ⋯ More；当前实现把 Deleted 略掉了，需对齐设计或更新设计。 |
| Sidebar 折叠（256↔48） | ✅ | Cmd/Ctrl+B 切换，framer-motion 220ms width 动画，折叠态显示 expand/new/search/settings 四个 IconButton；状态持久化到 SQLite。 |

## 3. ChatStream（`src/components/ChatStream.tsx`）

| 项 | 状态 | 备注 |
|---|---|---|
| Block 渲染（user / assistant / tool / waiting / error） | 🟡 | 渲染规则齐全；数据来自 `mockMessages`，与 active session 无关联。 |
| Tool 调用折叠/展开 | ✅ | framer-motion chevron 旋转 + 内容展开。 |
| Waiting block Allow/Deny 按钮 | 🟡 | 按钮+焦点管理完整；按下后无效果（无 SDK）。 |
| 自动滚动到底 + "↓ Jump to latest" | ⬜ | mvp-design.md §7 Q4。 |
| 真实 SDK 事件流接入 | ⬜ | |

## 4. InputBar（`src/components/InputBar.tsx`）

| 项 | 状态 | 备注 |
|---|---|---|
| 多行 textarea + Enter 发送 / Shift+Enter 换行 | 🟡 | 输入捕获 + 空白校验通；发送行为是 console.log 或 stub。 |
| Running 时禁用 + Stop 按钮 | ⬜ | 没有 running 状态来源。 |

## 5. StatusBar（`src/components/StatusBar.tsx`）

| 项 | 状态 | 备注 |
|---|---|---|
| cwd / model / permission ChipMenu | ✅ | 三 chip 切换；都派生自 props，由 App 状态驱动。 |
| recentProjects + Browse folder | 🟡 | recentProjects 来自 mock；Browse 应通过 Electron dialog，未接。 |
| Token 进度（"12k / 200k tokens · 6% used"） | 🟡 | App.tsx 硬编码字符串显示。 |

## 6. SettingsDialog（`src/components/SettingsDialog.tsx`）

| 项 | 状态 | 备注 |
|---|---|---|
| 弹层骨架 + 分组 tabs | ✅ | UI 通；tab 切换正常。 |
| Theme 切换 | ✅ | `theme: system|light|dark` 持久化到 store；App.tsx 监听 `prefers-color-scheme` 并切换 `<html>.dark` class。 |
| Anthropic API key（safeStorage） | ✅ | `keychain:get/setApiKey` IPC + Electron `safeStorage`，加密文件落 userData，无加密时禁用输入。 |
| Data dir 显示 | ✅ | `app:getDataDir` IPC 返回真实 `app.getPath('userData')`。 |
| Shortcuts 只读列表 | ✅ | 静态目录，符合 mvp-design.md "MVP 不开放 remap"。 |
| Updates "Check for updates" | 🟡 | 版本号通过 `app:getVersion` 读真实 package.json；按钮禁用，等 electron-updater PR。 |

## 7. CommandPalette（`src/components/CommandPalette.tsx`）

| 项 | 状态 | 备注 |
|---|---|---|
| Cmd+K 打开 | ✅ | App.tsx 全局 keydown。 |
| Sessions / Groups / Commands 三段搜索 | ✅ | 数据来自 store；commands 全接：New session / New group / Toggle sidebar / Open settings / Switch theme（循环 system→dark→light）。 |

## 8. Toast（`src/components/ui/Toast.tsx`）

| 项 | 状态 | 备注 |
|---|---|---|
| ToastProvider 已挂 | ✅ | |
| 实际触发：状态变化 / SDK 错误 / API key 缺失 | 🟡 | persist 写盘失败已接 toast（5s 节流防 spam）；状态变化 / SDK 错误等真实场景不存在数据源前不接，避免无意义 toast。 |

## 9. 数据持久化（mvp-design.md §10）

| 项 | 状态 |
|---|---|
| SQLite schema（groups / sessions / ui_state） | 🟡 单 JSON blob，未拆表 |
| Boot：扫 `~/.claude/projects/` 对账 | ⬜ |
| API key keychain 存储 | ⬜ |

## 10. 其他

| 项 | 状态 |
|---|---|
| Onboarding 首屏（Create / Import） | ⬜ |
| Tests（vitest / playwright） | ⬜ |
| Auto-update（electron-updater） | ⬜ |

## PR 路线图

参见 task list（`#80 #81 #83 #79 #82 #72 #71 #84 #74 #77 #73 #78 #75 #76`），按编号顺序推进。每个 PR 合并后回填本表格状态。
