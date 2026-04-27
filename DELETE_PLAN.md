# W3.5 SDK Teardown — Delete Plan

Inventory of the renderer/main SDK surface left over after PR #433 (chat block
deletion). Downstream workers W3.5b-c, W3.5d, W3.5e execute this list verbatim,
in order. Read-only inventory; nothing has been modified by this PR.

Branch base: `971b9de` (origin/working).

> All absolute paths in this document use the `pool-5` worktree because that's
> where the inventory was authored. Downstream workers operate in their own
> pool worktree and should re-resolve via repo-relative paths
> (`src/agent/...`, `electron/agent/...`, etc.).

## Summary findings

- All five renderer/main categories are dead in production `src/`. No live
  ttyd-relevant code path imports anything from `src/agent/**`,
  `src/slash-commands/**`, the SDK store actions, or the SDK `agent:*` IPCs /
  `window.ccsm.agent*` methods.
- `subscribeAgentEvents()` is **never called from production**. Lifecycle install
  was removed when the right pane was deleted. Only `tests/lifecycle.test.ts`
  invokes it. → safe to delete the entire module + the boot wiring nowhere.
- `startSessionAndReconcile()` likewise has zero `src/` callers — only
  `tests/store.test.ts` and `tests/top-banner.test.tsx` mock-import it.
- Sole external (non-`src/agent/`) consumers are:
  1. `src/global.d.ts` → type-only `CliPermissionMode` import (trivial inline).
  2. `src/stores/store.ts` → real runtime imports of `disposeStreamer`,
     `streamEventToTranslation`, `EffortLevel`, `coerceEffortLevel`,
     `DEFAULT_EFFORT_LEVEL`. All become dead once the store's SDK actions go.
  3. `electron/agent-sdk/sessions.ts:73` → imports from `src/agent/effort.ts`
     (`projectEffortToWire`, `thinkingTokensForLevel`, `nextLowerEffort`,
     `isEffortRejectionError`). **HOT cross-package import.** This forces
     `src/agent/` deletion (W3.5b) and `electron/agent-sdk/` deletion (W3.5c)
     to land in the SAME PR — see "Worker handoff order" below for the merged
     **W3.5b-c** wave.
  4. Harness/probe scripts. They are NOT comment-only mentions: 6 scripts
     call `window.__ccsmStore.setState({...})` / `pushDiagnostic` /
     `setSessionInitFailure` / `__ccsmDebug.sessions.resolvePermission` at
     runtime. Inventoried as **Category 6** below.
- Component-level audit (TtydPane, ClaudeMissingGuide, AppShell, Sidebar,
  CommandPalette, ImportDialog, SettingsDialog, Tutorial, InstallerCorruptBanner)
  shows ZERO references to: `messagesBySession`, `messageQueues`, `runningSessions`,
  `startedSessions`, `interruptedSessions`, `statsBySession`,
  `contextUsageBySession`, `allowAlwaysTools`, `loadMessageErrors`,
  `pendingDiffComments`, `lastTurnEnd`, `stashedDrafts`, `composerInjectNonce`,
  `composerInjectText`, `focusInputNonce`, `diagnostics`, `sessionInitFailures`,
  `globalEffortLevel`, `effortLevelBySession`. Every one of these slices is
  dead at the renderer layer.

**No L1 BLOCKERS.** Plan is unblocked once W3.5b/c merge order is taken
care of (handled by the merged W3.5b-c wave).

---

## Category 1 — `src/agent/**` (W3.5b-c)

Files (all under `src/agent/`):

| File | Lines | Public exports | External importers |
|---|---|---|---|
| `ask-user-question.ts` | 35 | `parseQuestions` | (a) deletable — only used by `lifecycle.ts` |
| `effort.ts` | 179 | `EffortLevel`, `DEFAULT_EFFORT_LEVEL`, `EFFORT_LEVELS`, `ThinkingConfigProjection`, `EffortWireOptions`, `projectEffortToWire`, `thinkingTokensForLevel`, `nextLowerEffort`, `isEffortRejectionError`, `coerceEffortLevel` | (a) deletable. Cross-package importer `electron/agent-sdk/sessions.ts:73` forces this file's deletion to ride in the same PR as `electron/agent-sdk/`'s deletion (W3.5b-c). Store re-export of `EffortLevel` + `coerceEffortLevel` + `DEFAULT_EFFORT_LEVEL` go away with W3.5d store cleanup. |
| `lifecycle.ts` | 489 | `disposeStreamer`, `setBackgroundWaitingHandler`, `permissionRequestToWaitingBlock`, `maybeAutoResolveAllowAlways`, `subscribeAgentEvents` | (a) deletable — `disposeStreamer` is the only real `src/` import (`store.ts:8`); call site in `store.ts:1309` removed by W3.5d. Other exports have ZERO production callers. |
| `permission.ts` | 12 | `CliPermissionMode` (type only) | (b) trivial inline removal in `src/global.d.ts:1` (replace with literal union) |
| `startSession.ts` | 117 | `startSessionAndReconcile` | (a) deletable — zero `src/` callers; only `tests/store.test.ts` + `tests/top-banner.test.tsx` import it |
| `stream-to-blocks.ts` | 589 | `PartialAssistantStreamer`, `StreamTranslation`, `ToolResultPatch`, `streamEventToTranslation` | (a) deletable — `streamEventToTranslation` only consumed by `lifecycle.ts` and `store.ts:903 framesToBlocks` (both deleted in W3.5d) |

### W3.5b-c actions (Category 1 part)

1. Delete the entire `src/agent/` directory (all 6 files).
2. In `src/global.d.ts:1`, replace
   ```ts
   import type { CliPermissionMode } from './agent/permission';
   ...
   type PermissionMode = CliPermissionMode;
   ```
   with the inline literal union:
   ```ts
   type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'auto';
   ```
3. Delete the test files that depend exclusively on these modules:
   - `tests/effort.test.ts`
   - `tests/permission.test.ts`
   - `tests/stream-to-blocks.test.ts`
   - `tests/lifecycle.test.ts`
   - `tests/top-banner.test.tsx` (mocks `startSession`; the banner itself was
     removed with the chat blocks)
4. Trim the `framesToBlocks` / `startSessionAndReconcile` describe blocks in
   `tests/store.test.ts`. Approximate line ranges at base `971b9de`: ~636–675
   and ~1120–1240. **Worker MUST re-grep for `framesToBlocks` and
   `startSessionAndReconcile` before editing** — line numbers will drift after
   any rebase (and after the d1/d2 split inside W3.5d).

### Verified references

- `src/agent/lifecycle.ts:404` — `i18next.t('chat.planTitle')`: confirmed still
  present in the lifecycle background-waiting handler.
- `src/agent/startSession.ts:95` — `i18next.t('chat.cwdMissing', { cwd })`:
  confirmed still present in the CWD_MISSING branch.

Both i18n keys (`chat.planTitle`, `chat.cwdMissing`) become orphaned bundle
strings after deletion. They are NOT load-bearing; W3.5b-c can leave them in
`src/i18n/locales/{en,zh}.ts` (untouched) or remove them — neither blocks the
teardown. Recommend leaving for now and sweeping in W3.5e i18n cleanup.

---

## Category 2 — `electron/main.ts agent:* IPC handlers` (W3.5b-c)

File: `electron/main.ts` (1506 lines). Each handler line range starts at the
listed line and runs until the closing `)` of the `ipcMain.handle(...)` call.

### Handlers to DELETE

| Channel | Lines | One-liner | Renderer caller (preload + window.ccsm) |
|---|---|---|---|
| `agent:load-history` | 626–646 | Read JSONL transcript via `loadHistoryFromJsonl` for renderer hydration | `window.ccsm.loadHistory` (preload.ts:90); deleted with W3.5d |
| `agent:start` | 957–1006 | Spawn / resume an SDK session via `sessions.start` | `window.ccsm.agentStart` (preload.ts:132) |
| `agent:send` | 1007–1010 | Send a plain-text user turn | `window.ccsm.agentSend` (preload.ts:134) |
| `agent:sendContent` | 1011–1017 | Send Anthropic content-block array (text+image) | `window.ccsm.agentSendContent` (preload.ts:140) |
| `agent:interrupt` | 1018 | Interrupt the current turn | `window.ccsm.agentInterrupt` (preload.ts:142) |
| `agent:cancelToolUse` | 1025–1049 | Per-tool cancel (#239); routes through SessionRunner | `window.ccsm.agentCancelToolUse` (preload.ts:153) |
| `agent:setPermissionMode` | 1050–1080 | Mid-session permission mode switch | `window.ccsm.agentSetPermissionMode` (preload.ts:156) |
| `agent:setModel` | 1081–1084 | Mid-session model switch | `window.ccsm.agentSetModel` (preload.ts:161) |
| `agent:setMaxThinkingTokens` | 1092–1116 | Legacy thinking-tokens cap | `window.ccsm.agentSetMaxThinkingTokens` (preload.ts:179) |
| `agent:setEffort` | 1121–1148 | 6-tier effort chip change | `window.ccsm.agentSetEffort` (preload.ts:169) |
| `agent:close` | 1149–1152 | Close a session's SDK runner | `window.ccsm.agentClose` (preload.ts:184); also called from `src/slash-commands/handlers.ts:33` (deleted with W3.5e) |
| `agent:resolvePermission` | 1154–1160 | Whole-tool allow/deny | `window.ccsm.agentResolvePermission` (preload.ts:185) |
| `agent:resolvePermissionPartial` | 1166–1174 | Per-hunk partial accept (#251) | `window.ccsm.agentResolvePermissionPartial` (preload.ts:196) |

Plus the renderer-facing event broadcasts these handlers depend on (sent via
`sessions.bindSender(win.webContents)` from `manager.ts`):
`agent:event`, `agent:exit`, `agent:diagnostic`, `agent:permissionRequest`.
Their wiring lives in `electron/agent/manager.ts`, not `main.ts` — but the
preload `onAgent*` listeners (preload.ts:202–221) become useless once the
broadcasters go.

### Handlers to KEEP

- All `cliBridge:*` handlers — registered via `registerCliBridgeIpc()` (main.ts:1431).
- All non-agent handlers, including: `db:load`, `db:save`, `truncation:get`,
  `truncation:set` (W3.5e drops these — see "Smaller items" below),
  `ccsm:get-system-locale`, `ccsm:set-language`, `connection:read`,
  `connection:openSettingsFile`, `models:list`, `app:getVersion`,
  `dialog:pickDirectory`, `dialog:saveFile`, `tool:open-in-editor`, `window:*`,
  `import:scan`, `import:recentCwds`, `import:loadHistory`, `app:userCwds:*`,
  `app:userHome`, `settings:defaultModel`, `paths:exist`, `commands:list`,
  `files:list`, `shell:openExternal`, `memory:*`, `notification:show`,
  `notify:availability`, `notify:setRuntimeState`, all `updates:*` handlers.

### Helper imports that become dead after handler deletion

In `electron/main.ts` top of file:

- Line 65: `import { sessions } from './agent/manager';` — DELETE entirely.
  All call sites become dead: 426, 438, 446, 574, 1002, 1009, 1015, 1018,
  1043, 1071, 1083, 1110, 1142, 1151, 1158, 1172, 1444–1455, 1477, 1498.
  `sessions.bindSender(win.webContents)` (line 426) and `sessions.rebindSender`
  (lines 438, 446) calls are obsoleted by `bindCliBridgeSender` (line 430)
  which already exists. Verified present in cliBridge — safe to drop bindSender.
- Line 66: `import { resolveCwd } from './agent/sessions';` — used inside the
  deleted `agent:start` handler only (line 985) → DELETE.
- Line 81: `import type { PermissionMode } from './agent/sessions';` — used by
  the deleted `agent:start` and `agent:setPermissionMode` handlers → DELETE.
- Line 82: `import { listModelsFromSettings, readDefaultModelFromSettings } from './agent/list-models-from-settings';`
  → **KEEP**. These are used by `models:list` (main.ts:827) and
  `settings:defaultModel` (main.ts:1194). See Category 7 for the per-file
  electron/agent/ disposition.
- Line 12: `import { loadHistoryFromJsonl } from './jsonl-loader';` — used only
  by the deleted `agent:load-history` handler → DELETE the import. The
  `electron/jsonl-loader.ts` module itself becomes dead and W3.5b-c removes it
  alongside `electron/agent-sdk/`.
- Line 73–74: `import { showNotification, ... }` and `notify` → KEEP (still used
  by `notification:show` and `notify:availability` IPCs).
- Line 75–80: `notify-bootstrap` imports → KEEP (used by `bootstrapNotify`,
  the notification toast router).
- Line 573–578: `bootstrapNotify(createDefaultToastActionRouter({
  resolvePermission: ... }))` — passes `sessions.resolvePermission` as the
  router callback. Decision: **(b) reshape `createDefaultToastActionRouter`
  to drop the `resolvePermission` parameter** (clean cut, no vestigial stub).
- Line 1444–1455 / 1438–1457: `__ccsmDebug` debug seam — see Category 8 for
  the concrete drop/keep list.
- Line 1477, 1498: `sessions.closeAll()` in `before-quit` and
  `window-all-closed` → DELETE; `shutdownCliBridge()` (line 1487) already
  handles ttyd teardown for the new world.

### W3.5b-c actions (Category 2 part)

1. Remove the 13 `agent:*` handlers listed above.
2. Remove the helper imports at lines 12, 65, 66, 81 and call sites
   (`sessions.bindSender`, `sessions.rebindSender`, `sessions.closeAll`,
   the `sessions.*` entries inside `__ccsmDebug` per Category 8).
3. **KEEP** line 82 (`list-models-from-settings`).
4. Delete `electron/agent/manager.ts`, `sessions.ts`, `stream-json-types.ts`,
   `start-result-types.ts`, `partial-write.ts`, `binary-resolver.ts` — see
   Category 7 for full per-file disposition.
5. Delete the entire `electron/agent-sdk/` directory.
6. Delete `electron/jsonl-loader.ts`.
7. Trim `electron/notify-bootstrap.ts` `createDefaultToastActionRouter` to
   drop the `resolvePermission` parameter.
8. Apply `__ccsmDebug` trim per Category 8.

---

## Category 3 — `electron/preload.ts window.ccsm SDK surface` (W3.5b-c)

File: `electron/preload.ts` (502 lines).

### Methods to DELETE on `window.ccsm`

| Method | Lines | IPC channel |
|---|---|---|
| `loadHistory` | 90–96 | `agent:load-history` |
| `agentStart` | 132–133 | `agent:start` |
| `agentSend` | 134–135 | `agent:send` |
| `agentSendContent` | 140–141 | `agent:sendContent` |
| `agentInterrupt` | 142–143 | `agent:interrupt` |
| `agentCancelToolUse` | 153–155 | `agent:cancelToolUse` |
| `agentSetPermissionMode` | 156–160 | `agent:setPermissionMode` |
| `agentSetModel` | 161–162 | `agent:setModel` |
| `agentSetEffort` | 169–173 | `agent:setEffort` |
| `agentSetMaxThinkingTokens` | 179–183 | `agent:setMaxThinkingTokens` |
| `agentClose` | 184 | `agent:close` |
| `agentResolvePermission` | 185–190 | `agent:resolvePermission` |
| `agentResolvePermissionPartial` | 196–201 | `agent:resolvePermissionPartial` |
| `onAgentEvent` | 202–206 | listener on `agent:event` |
| `onAgentExit` | 207–211 | listener on `agent:exit` |
| `onAgentDiagnostic` | 212–216 | listener on `agent:diagnostic` |
| `onAgentPermissionRequest` | 217–221 | listener on `agent:permissionRequest` |

Plus the type imports at the top of `preload.ts`:

- Line 3: `import type { PermissionMode, AgentMessage } from './agent/sessions';`
  → DELETE (electron/agent/ dir is going away).
- Line 4: `import type { StartResult } from './agent/start-result-types';`
  → DELETE.
- Lines 12–41: type aliases `StartOpts`, `AgentEvent`, `AgentExit`,
  `AgentDiagnostic`, `AgentPermissionRequest` — all only used by the deleted
  methods → DELETE.

### Methods to KEEP on `window.ccsm`

`loadState`, `saveState`, `i18n.{getSystemLocale,setLanguage}`,
`getVersion`, `pickDirectory`, `saveFile`, `toolOpenInEditor`,
`scanImportable`, `recentCwds`, `userHome`, `userCwds.{get,push}`,
`defaultModel`, `pathsExist`, `memory.*`, `commands.list`,
`files.list`, `openExternal`, `notify`, `notifyAvailability`,
`notifySetRuntimeState`, `onNotificationFocus`, `onNotifyToastAction`,
`updates*`, `onUpdate*`, `window.*`, `connection.*`, `models.list`.

`truncationGet` / `truncationSet` and `loadImportHistory` — DELETE in W3.5e
(promoted from "verify" — see "Smaller items" below).

### `window.ccsmCliBridge` (KEEP entire surface)

Lines 459–502 — `openTtydForSession`, `resumeSession`, `killTtydForSession`,
`checkClaudeAvailable`, `onTtydExit`. All four are consumed by `App.tsx`
(`checkClaudeAvailable` at line 217) and `TtydPane.tsx` (`openTtydForSession`,
`killTtydForSession`, `onTtydExit`). Untouched.

### `src/global.d.ts` types to trim (W3.5b-c)

File: `src/global.d.ts` (318 lines).

DELETE the matching declarations on the `Window['ccsm']` interface:

- Lines 1–2: type imports `CliPermissionMode`, `ClaudeStreamEvent`. Replace
  `PermissionMode` (line 11) with the inline union per Category 1; drop
  `AgentMessage` (line 12) and downstream `AgentEvent` / `AgentExit` /
  `AgentDiagnostic` / `AgentPermissionRequest` (lines 44–57).
- Lines 14–43: `StartOpts` and `StartResult` type aliases.
- Line 93–99 (`loadHistory`), 126 (`agentStart`), 127 (`agentSend`), 128
  (`agentSendContent`), 129 (`agentInterrupt`), 135–137
  (`agentCancelToolUse`), 138–141 (`agentSetPermissionMode`), 142
  (`agentSetModel`), 143–146 (`agentSetMaxThinkingTokens`), 147–150
  (`agentSetEffort`), 151 (`agentClose`), 152–156 (`agentResolvePermission`),
  157–161 (`agentResolvePermissionPartial`), 162 (`onAgentEvent`), 163
  (`onAgentExit`), 164 (`onAgentDiagnostic`), 165 (`onAgentPermissionRequest`).
- Line 208 (`loadImportHistory`) — DELETE in W3.5e once W3.5d removes
  `messagesBySession` (the only consumer of import-flow JSONL hydration).

`window.ccsmCliBridge` itself isn't declared in `global.d.ts` — it's typed via
`CCSMCliBridgeAPI` exported from preload.ts. Renderer accesses use the
`window.ccsmCliBridge` global through the `cliBridge.d.ts` declaration file
(`src/cliBridge.d.ts`). KEEP that file untouched.

---

## Category 4 — `src/stores/store.ts` SDK slice removal (W3.5d, two commits)

File: `src/stores/store.ts` (2888 lines).

### W3.5d execution shape: d1 + d2 in the same PR, two commits

Single rewrite at this ratio (~50–55% deletion) is the highest-risk path —
no incremental tsc gate, easy to clobber hydration logic
(`store.ts:2786–2851`), `SessionSnapshot` undo behaviour, or persist
sanitization. Instead:

- **Commit d1 — surgical action removal with tsc gate.** Delete each SDK
  Action one at a time (~38 actions in the table below), running
  `tsc --noEmit` after each removal. Mechanical, ~38 tsc runs. Any breakage
  surfaces against the single action just removed, not a 1500-line diff.
- **Commit d2 — sweep now-orphaned state, types, helpers, persist keys.**
  Drop `framesToBlocks`, `userFrameToBlock`, `inFlightLoads`,
  `sanitizeEffortLevelMap`, all dead state fields and interfaces (lists
  below), and persist.ts entries. Single-pass review of a smaller diff.

Same end state as a rewrite, lower risk, easier review.

### SDK-only imports (drop in d2 once d1 removes their last use sites)

| Line | Import | Disposition |
|---|---|---|
| 8 | `import { disposeStreamer } from '../agent/lifecycle';` | DELETE |
| 9 | `import { streamEventToTranslation } from '../agent/stream-to-blocks';` | DELETE |
| 10–14 | `import { coerceEffortLevel, DEFAULT_EFFORT_LEVEL, type EffortLevel } from '../agent/effort';` | DELETE |
| 15 | `export type { EffortLevel };` | DELETE (no consumers outside `persist.ts:8`, which itself loses the import) |

### State fields to DELETE in d2 (in the `type State = { ... }` block, lines 175–345)

- `globalEffortLevel: EffortLevel;` (206)
- `effortLevelBySession: Record<string, EffortLevel>;` (212)
- `messagesBySession: Record<string, MessageBlock[]>;` (227)
- `loadMessageErrors: Record<string, string>;` (234)
- `startedSessions: Record<string, true>;` (235)
- `runningSessions: Record<string, true>;` (236)
- `statsBySession: Record<string, SessionStats>;` (237)
- `contextUsageBySession: Record<string, SessionContextUsage>;` (238–241)
- `interruptedSessions: Record<string, true>;` (242–245)
- `messageQueues: Record<string, QueuedMessage[]>;` (246–253)
- `composerInjectNonce: number;` (290) — DELETE (InputBar gone in PR #433).
- `composerInjectText: string;` (291) — DELETE (InputBar gone).
- `focusInputNonce: number;` (270–276) — DELETE (InputBar autofocus gone).
- `stashedDrafts: Record<string, string[]>;` (292–298) — DELETE (InputBar
  draft recall gone).
- `diagnostics: DiagnosticEntry[];` (299–302) — DELETE (banner gone).
- `sessionInitFailures: Record<string, SessionInitFailure>;` (303–305) — DELETE.
- `allowAlwaysTools: string[];` (306–316) — DELETE.
- `pendingDiffComments: Record<string, Record<string, PendingDiffComment>>;`
  (317–327) — DELETE.
- `lastTurnEnd: Record<string, 'ok' | 'interrupted'>;` (339–344) — DELETE.

KEEP: `sessions`, `groups`, `recentProjects`, `userHome`,
`claudeSettingsDefaultModel`, `activeId`, `focusedGroupId`, `model`,
`permission`, `sidebarCollapsed`, `sidebarWidth`, `theme`, `fontSize`,
`fontSizePx`, `tutorialSeen`, `notificationSettings`, `models`, `modelsLoaded`,
`connection`, `hydrated`, `installerCorrupt`, `openPopoverId`.

### Type / interface declarations to DELETE in d2

- `interface SessionStats` + `EMPTY_SESSION_STATS` (80–92)
- `interface SessionContextUsage` (100–109)
- `interface DiagnosticEntry` (141–149)
- `interface SessionInitFailure` (161–166)
- `interface PendingDiffComment` (361–372)
- `function serializeDiffCommentsForPrompt` (382–413)
- `interface QueuedMessage` (38–42)
- The `messages`, `started`, `running`, `interrupted`, `queue`, `stats`
  fields on `SessionSnapshot` (433–439); ditto downstream cascade in
  `GroupSnapshot`. **Reduce SessionSnapshot to `{ session, index, draft,
  prevActiveId }`** and update `deleteSession` / `restoreSession` accordingly.

### Action types in `Actions` (455–660) and impls — DELETE in d1 (one-by-one with tsc gate)

| Type sig (line) | Impl (line) | Notes |
|---|---|---|
| `markSessionCwdMissing` (469) | 1473 | DELETE — used only by `startSession.ts:90` |
| `setGlobalEffortLevel` (486) | 1542 | DELETE |
| `setEffortLevel` (493) | 1548 | DELETE |
| `appendBlocks` (513) | 1728 | DELETE |
| `markQuestionAnswered` (519) | 1793 | DELETE |
| `streamAssistantText` (524) | 1815 | DELETE |
| `streamBashToolInput` (532) | 1841 | DELETE |
| `setToolResult` (539) | 1881 | DELETE |
| `clearMessages` (540) | 1898 | DELETE |
| `resetSessionContext` (547) | 1907 | DELETE |
| `rewindToBlock` (555) | 1960 | DELETE |
| `replaceMessages` (556) | 1954 | DELETE |
| `loadMessages` (557) | 2090 | DELETE — calls `framesToBlocks` |
| `markStarted` (558) | 2257 | DELETE |
| `recordSdkSessionId` (566) | 2265 | DELETE |
| `setRunning` (567) | 2279 | DELETE |
| `setSessionState` (568) | 2300 | DELETE — verify Sidebar doesn't read `Session.state` |
| `markInterrupted` (569) | 2312 | DELETE |
| `consumeInterrupted` (570) | 2328 | DELETE |
| `enqueueMessage` (571) | 2339 | DELETE |
| `dequeueMessage` (572) | 2352 | DELETE |
| `clearQueue` (573) | 2368 | DELETE |
| `resolvePermission` (574) | 2377 | DELETE |
| `resolvePermissionPartial` (581) | 2426 | DELETE |
| `addAllowAlways` (586) | 2464 | DELETE |
| `bumpComposerFocus` (591) | (search) | DELETE — InputBar gone |
| `injectComposerText` (594) | 2482 | DELETE — InputBar gone |
| `pushStashedDraft` (599) | 2490 | DELETE — InputBar gone |
| `addSessionStats` (600) | 2063 | DELETE |
| `setSessionContextUsage` (604) | 2081 | DELETE |
| `pushDiagnostic` (615) | 2648 | DELETE |
| `dismissDiagnostic` (619) | 2660 | DELETE |
| `setSessionInitFailure` (622) | 2671 | DELETE |
| `clearSessionInitFailure` (624) | 2679 | DELETE |
| `addDiffComment` (644) | (search) | DELETE — DiffView gone |
| `updateDiffComment` (650) | (search) | DELETE |
| `deleteDiffComment` (652) | (search) | DELETE |
| `clearDiffComments` (655) | (search) | DELETE |
| `clearLastTurnEnd` (659) | (search) | DELETE |
| `setInstallerCorrupt` (611) | 2644 | KEEP — InstallerCorruptBanner consumes |

KEEP: `selectSession`, `focusGroup`, `createSession`, `importSession`,
`renameSession`, `deleteSession` (simplified), `restoreSession` (simplified),
`moveSession`, `changeCwd`, `pushRecentProject`, `setGlobalModel`,
`setSessionModel`, `setPermission`, `setSidebarCollapsed`, `toggleSidebar`,
`setTheme`, `setFontSize`, `setFontSizePx`, `setSidebarWidth`,
`resetSidebarWidth`, `markTutorialSeen`, `setNotificationSettings`,
`createGroup`, `renameGroup`, `deleteGroup`, `restoreGroup`, `archiveGroup`,
`unarchiveGroup`, `setGroupCollapsed`, `loadModels`, `loadConnection`,
`setInstallerCorrupt`, `openPopover`, `closePopover`.

### Other dead exports (drop in d2)

- `function framesToBlocks` (903–969) — DELETE.
- `function userFrameToBlock` (search nearby) — used only by `framesToBlocks`,
  DELETE.
- `function migrateNotificationSettings` (742) — KEEP (used by hydration).
- `function sanitizeEffortLevelMap` (758) — DELETE (only used by
  `globalEffortLevel`/`effortLevelBySession` hydration; persist.ts drops
  those keys atomically in d2).
- `inFlightLoads` set (889) — used by `loadMessages` only, DELETE.

### Persistence (`src/stores/persist.ts`) follow-up (d2)

Drop these from `PERSISTED_KEYS` (lines 35–51) and `PersistedState` (55–85):

- `globalEffortLevel`
- `effortLevelBySession`
- The `EffortLevel` import on line 8.

KEEP: `sessions`, `groups`, `activeId`, `model`, `permission`,
`sidebarCollapsed`, `sidebarWidth`, `theme`, `fontSize`, `fontSizePx`,
`recentProjects`, `tutorialSeen`, `notificationSettings`.

### Test impact (W3.5d)

`tests/store.test.ts` line numbers cited above (~636–675, ~1120–1240,
plus the SDK action describes the d1 commit blasts through) **WILL drift**
during d1 as actions disappear. The W3.5d worker MUST re-grep before each
delete pass; do not trust the line numbers in this plan once d1 starts.

---

## Category 5 — `src/slash-commands/**` (W3.5b-c, alongside Category 1)

Files (all under `src/slash-commands/`):

- `handlers.ts` (102 lines) — exports `handleClear`, `handleConfig`,
  `blocksToTranscript`. Side-effect attaches handlers to
  `BUILT_IN_COMMANDS` entries.
- `registry.ts` (369 lines) — exports `BUILT_IN_COMMANDS`, `SlashCommand`,
  `SlashCommandContext` types.

### External importers (outside `src/slash-commands/`)

```
tests/slash-commands-handlers.test.ts:8  → registry
tests/slash-commands-handlers.test.ts:9  → handlers
tests/slash-command-picker.test.tsx:5    → registry
tests/slash-commands-registry.test.ts:11 → registry
```

**Zero `src/` callers.** The only runtime entry was `InputBar.send()` and the
`SlashCommandPicker` UI — both lived in deleted chat blocks (PR #433).

### W3.5b-c actions (Category 5 part)

1. Delete the entire `src/slash-commands/` directory.
2. Delete the three test files listed above.
3. Verify the `App.tsx:295–299` `ccsm:open-settings` window listener: the
   dispatcher (`handleConfig` in `handlers.ts:88`) is going away, so the
   listener becomes a one-sided no-op. SAFE to keep (it's harmless) or
   remove. Recommend removing in W3.5e for cleanliness.

---

## Category 6 — Harness/probe scripts touching SDK store, IPC, or __ccsmDebug (W3.5b-c + W3.5d)

The previous draft of this plan claimed these scripts only "mention symbols in
COMMENTS." That was wrong. Each script below uses removed surface at runtime
(`window.__ccsmStore.setState({...})` against fields W3.5d deletes,
`window.__ccsmDebug.sessions.*` against fields W3.5b-c deletes, or
`window.ccsm.agent*` against IPCs W3.5b-c deletes). Once the corresponding
wave lands, the script throws `TypeError` at first call. Per the project's
"no skipped e2e" gate, every script is given a concrete disposition here.

| Script | Symbols touched | Wave to update | Disposition |
|---|---|---|---|
| `scripts/harness-agent.mjs` (5259 lines) | `__ccsmStore.setState({ messagesBySession, diagnostics, sessionInitFailures, runningSessions, ... })` (lines 72–78, 155–161); `pushDiagnostic` (92, 129); `setSessionInitFailure` (174); `clearSessionInitFailure` (211); `__ccsmDebug.sessions.resolvePermission.bind(...)` (3711); `__ccsmDebug.activeSessionCount` / `selfExitCount` (3895–3970); `__ccsmDebug.notify` / `notifyBootstrap` (3672–3673) | **W3.5b-c (for IPC + __ccsmDebug.sessions removal); W3.5d (for store.ts field removal)** | **DELETE entire script.** It exclusively probes the SDK runner / SDK store / SDK permission flow — none of which exist post-teardown. The notify/notifyBootstrap probes (3672–3673) are the only fragments worth keeping; carve them into a small `scripts/probe-notify.mjs` if needed, otherwise drop. |
| `scripts/harness-perm.mjs` (3077 lines) | Same `setState`/`pushDiagnostic`/`__ccsmDebug.sessions.resolvePermission` pattern; entire script tests the SDK permission round-trip | W3.5b-c | **DELETE entire script.** Permission flow is the SDK runner's, gone with W3.5b-c. ttyd has no equivalent permission-toast plumbing. |
| `scripts/harness-restore.mjs` (2671 lines) | `setState({ messagesBySession, ... })`; SDK lifecycle | W3.5b-c | **DELETE entire script.** Restore here means restoring the SDK in-memory message stream after rewind — the entire concept dies with W3.5d's `messagesBySession`/`rewindToBlock` removal. |
| `scripts/harness-real-cli.mjs` (1088 lines) | `agentStart` / `agentSend` / `agentInterrupt` against the SDK | W3.5b-c | **DELETE entire script.** Bridges the renderer SDK path against a real claude binary — orthogonal to ttyd. |
| `scripts/harness-ui.mjs` (4329 lines) | `setState({ messagesBySession, ... })` to seed UI state for visual testing | W3.5b-c (for any SDK field assertions) + W3.5d (for store seeding) | **REWRITE.** The harness's surviving job (sidebar / settings / theme visual probes) doesn't need SDK state. W3.5d worker rewrites the seeding helpers to use only KEEP-list state (`sessions`, `groups`, `theme`, `notificationSettings`, etc.) and drops every assertion against `messagesBySession`/`runningSessions`/`diagnostics`. If post-rewrite the script is <500 lines and overlaps `harness-dnd.mjs`, fold into that. |
| `scripts/harness-dnd.mjs` | Only `__ccsmStore.getState().sessions` (KEEP-list field) | none | **KEEP.** Verified by Grep — only references KEEP-list fields. Re-verify in W3.5d worker prompt with a single grep before merge. |
| `scripts/probe-dogfood-r2-fp8-tools.mjs` | SDK tool-result store fields (`statsBySession`, `messagesBySession`) and SDK message round-trips | W3.5d | **DELETE.** Probes a tool-block UI that PR #433 already removed; there's no longer a "tools rendering" surface in renderer. |
| `scripts/probe-dogfood-r2-fp9-truncate-rewind.mjs` | `rewindToBlock` action + `messagesBySession` | W3.5d | **DELETE.** Truncate/rewind feature dies with W3.5d (`rewindToBlock` + `truncationGet/Set` removal — see "Smaller items"). |
| `scripts/probe-dogfood-r2-fp10-pickers.mjs` | `__ccsmStore.setState({ messagesBySession })` to seed a session before testing pickers | W3.5d | **REWRITE** (small) — drop the message seeding (pickers don't need messages); keep the picker probe itself. Worker reads & strips ~20 lines of seed setup. |
| `scripts/probe-dogfood-r2-fp11-i18n-markdown-long.mjs` | Renders markdown via the deleted message-block UI | W3.5d | **DELETE.** The markdown-block renderer is gone; the probe has no DOM to assert against. |
| `scripts/probe-dogfood-r2-fp12-settings-live.mjs` | Touches store but only against `notificationSettings` / `theme` etc. (KEEP-list); also has incidental `messagesBySession` seed | W3.5d | **REWRITE** (small) — strip the messagesBySession seed; keep the settings-live assertions. |
| `scripts/probe-dogfood-r2-fp13-details.mjs` | SDK message detail / tool-block details | W3.5d | **DELETE.** Detail view is on the deleted message-block UI. |
| `scripts/probe-dogfood-type-scale-225.mjs` | Seeds `messagesBySession` to render type ladder against chat blocks | W3.5d | **REWRITE** (small) — render type ladder against a static fixture page or use ttyd-iframe-free element; strip the messagesBySession seed. |
| `scripts/probe-utils.mjs` | Helper used by the above; contains `setState({ messagesBySession })` helpers and `__ccsmDebug.sessions.*` shims | W3.5b-c + W3.5d | **REWRITE.** Drop `seedSessionWithMessages`, `pushDiagnostic`, `resolvePermissionViaDebug` helpers. Keep the generic page-bootstrap / screenshot / wait helpers. |
| `scripts/probe-helpers/harness-runner.mjs`, `scripts/probe-helpers/reset-between-cases.mjs` | Touch store reset (`setState({ messagesBySession: {}, runningSessions: {}, ... })`) for between-case isolation | W3.5d | **REWRITE** — change reset to set only KEEP-list state to its empty form (`sessions: {}`, `groups: {}`); drop the dead-field resets. |

**Wave responsibilities:**

- **W3.5b-c worker prompt MUST include**: delete `harness-agent.mjs`,
  `harness-perm.mjs`, `harness-restore.mjs`, `harness-real-cli.mjs` from
  `scripts/` in the same PR as the SDK IPC removal. (Their failure modes are
  SDK-IPC and `__ccsmDebug.sessions.*`.)
- **W3.5d worker prompt MUST include**: delete `probe-dogfood-r2-fp8-tools.mjs`,
  `probe-dogfood-r2-fp9-truncate-rewind.mjs`,
  `probe-dogfood-r2-fp11-i18n-markdown-long.mjs`,
  `probe-dogfood-r2-fp13-details.mjs`. Rewrite `harness-ui.mjs`,
  `probe-dogfood-r2-fp10-pickers.mjs`, `probe-dogfood-r2-fp12-settings-live.mjs`,
  `probe-dogfood-type-scale-225.mjs`, `probe-utils.mjs`,
  `probe-helpers/harness-runner.mjs`, `probe-helpers/reset-between-cases.mjs`
  to use only KEEP-list store fields. Run the rewritten probes against the
  d2 commit before the PR is opened for review.

---

## Category 7 — `electron/agent/` per-file disposition (W3.5b-c)

The directory contains 8 source files plus `__tests__/`. Verified by reading
each file and grepping its importers across the worktree.

| File | Disposition | Reason |
|---|---|---|
| `manager.ts` | DELETE (W3.5b-c) | SDK runner manager; only consumers are itself + main.ts:65 (deleted) |
| `sessions.ts` | DELETE (W3.5b-c) | `resolveCwd`, `PermissionMode`, `AgentMessage` all consumed only by deleted main.ts/preload.ts/agent-sdk surfaces |
| `start-result-types.ts` | DELETE (W3.5b-c) | Only consumed by `electron/agent-sdk/sessions.ts` (deleted) and `preload.ts:4` (deleted) |
| `stream-json-types.ts` | DELETE (W3.5b-c) | SDK stream-event type bag; no consumer outside `electron/agent/` and `electron/agent-sdk/` |
| `partial-write.ts` | DELETE (W3.5b-c) | Only consumer is `electron/agent-sdk/sessions.ts:67` (deleted). `tests/partial-write.test.ts` deleted alongside |
| `binary-resolver.ts` | DELETE (W3.5b-c) | Importers: `electron/agent-sdk/sessions.ts:39` (deleted), `electron/agent/manager.ts:3` (deleted). `electron/cliBridge/claudeResolver.ts` is independent (verified — own implementation, no shared module). |
| `list-models-from-settings.ts` | **KEEP** | Used by `models:list` IPC at `electron/main.ts:827` (production renderer surface). Stays in place. |
| `cli-picker-models.ts` | **KEEP** | Used by `settings:defaultModel` IPC at `electron/main.ts:1194`, AND transitively by `list-models-from-settings.ts:30`. Stays in place. |

**Decision**: do NOT delete the entire `electron/agent/` directory. After
W3.5b-c, the directory contains exactly two files: `list-models-from-settings.ts`
and `cli-picker-models.ts`. Acceptable as-is; renaming the directory to
`electron/models/` is a cosmetic follow-up and explicitly out of scope for
W3.5b-c (would force an extra import-rewrite pass with no functional benefit).

### Tests under `electron/agent/__tests__/`

| Test file | Disposition |
|---|---|
| `__tests__/binary-resolver.test.ts` | DELETE (W3.5b-c) — module is gone |
| `__tests__/list-models-from-settings.test.ts` | KEEP — module is kept |
| `__tests__/cli-picker-models.test.ts` | KEEP — module is kept |
| `tests/partial-write.test.ts` (root tests/) | DELETE (W3.5b-c) — module is gone |
| `tests/sdk-session-effort-fallback.test.ts` (root tests/) | DELETE (W3.5b-c) — exercises `electron/agent-sdk/`, gone |

---

## Category 8 — `__ccsmDebug` seam (W3.5b-c, concrete dispositions)

`electron/main.ts:1438–1457`.

### DROP (SDK-only fields, gone with the runner)

- `dbg.activeSessionPids` — surfaced by `sessions.activeRunnerPids`
- `dbg.activeSessionCount` — surfaced by `sessions.activeSessionCount`
- `dbg.selfExitCount` — surfaced by `sessions.selfExitsSinceStart`
- `dbg.sessions` — direct reference to the deleted runner manager (used by
  `harness-agent.mjs:3711` for `__ccsmDebug.sessions.resolvePermission.bind`;
  the harness itself is deleted in Category 6)

### KEEP (live notification probes consume these)

- `dbg.notify` — consumed by `harness-agent.mjs:3672`. Notification probes
  survive even though `harness-agent.mjs` proper is deleted; the notify
  probe is being carved out per Category 6.
- `dbg.notifyBootstrap` — consumed by `harness-agent.mjs:3673`, same reason.

The W3.5b-c worker rewrites the `__ccsmDebug` object literal to expose only
`notify` and `notifyBootstrap`. No-op stubs for the dropped fields are NOT
kept — clean cut.

---

## Worker handoff order

**W3.5b-c (merged single PR, was W3.5b + W3.5c)** — deletes
`src/agent/` + `src/slash-commands/` + `electron/agent-sdk/` + most of
`electron/agent/` + `electron/jsonl-loader.ts`, removes `agent:*` IPC
handlers in `electron/main.ts`, trims `electron/preload.ts` and
`src/global.d.ts` SDK declarations, applies the `__ccsmDebug` cut from
Category 8, deletes the four pure-SDK harness scripts from Category 6, and
trims `notify-bootstrap`'s `createDefaultToastActionRouter` shape.

**Reason for merge**: `electron/agent-sdk/sessions.ts:73` imports from
`src/agent/effort.ts`. Splitting these into separate PRs leaves an
intermediate state where `tsc` is red on `working` (effort.ts gone, but
agent-sdk still importing it), preventing the second PR's reviewer from
running CI checks against a green baseline. Merging eliminates the partial
window with no loss of independent review (each side still gets the same
review prompt; only the merge boundary changes).

**W3.5d (single PR, two commits d1 + d2)** — see Category 4.
- d1: surgical action removal with `tsc --noEmit` after each (~38 actions).
- d2: drop now-orphaned state, types, helpers, persist keys; rewrite the
  Category 6 store-touching probes against KEEP-list fields only and run
  them green before opening for review.

MUST come after W3.5b-c so that `src/agent/` imports the deleted store
actions called are already gone (no brief window where the renderer holds
dead IPC handles or imports a deleted `effort.ts`).

**W3.5e (final sweep)** — see "Smaller items" promotions below.
- DELETE `loadImportHistory` (preload + main + global.d.ts surfaces; verified
  no consumer in `src/components/ImportDialog.tsx` after W3.5d's
  `messagesBySession` removal).
- DELETE `truncationGet` / `truncationSet` (preload + main + global.d.ts;
  only consumers were `store.ts:loadMessages` and `store.ts:rewindToBlock`,
  both deleted by W3.5d).
- Trim orphaned i18n keys (`chat.planTitle`, `chat.cwdMissing`).
- Audit `App.tsx:295–299` `ccsm:open-settings` listener (recommend remove).

---

## Files at-a-glance (repo-relative paths; resolve from your own pool worktree)

Deleted entirely (W3.5b-c):
- `src/agent/` (6 files)
- `src/slash-commands/` (2 files)
- `electron/agent/manager.ts`, `sessions.ts`, `start-result-types.ts`,
  `stream-json-types.ts`, `partial-write.ts`, `binary-resolver.ts`
  (KEEP `list-models-from-settings.ts` + `cli-picker-models.ts`)
- `electron/agent-sdk/` (whole directory)
- `electron/jsonl-loader.ts`
- `electron/agent/__tests__/binary-resolver.test.ts`
- `tests/effort.test.ts`, `tests/permission.test.ts`,
  `tests/stream-to-blocks.test.ts`, `tests/lifecycle.test.ts`,
  `tests/top-banner.test.tsx`, `tests/slash-commands-handlers.test.ts`,
  `tests/slash-command-picker.test.tsx`,
  `tests/slash-commands-registry.test.ts`, `tests/partial-write.test.ts`,
  `tests/sdk-session-effort-fallback.test.ts`
- `scripts/harness-agent.mjs`, `scripts/harness-perm.mjs`,
  `scripts/harness-restore.mjs`, `scripts/harness-real-cli.mjs`

Modified (W3.5b-c):
- `src/global.d.ts`
- `electron/main.ts`
- `electron/preload.ts`
- `electron/notify-bootstrap.ts` (drop `resolvePermission` from
  `createDefaultToastActionRouter` arg shape)

Modified (W3.5d, two commits):
- `src/stores/store.ts` (d1 actions, d2 state/types/helpers)
- `src/stores/persist.ts` (d2)
- `tests/store.test.ts` (re-grep before edit; lines drift in d1)
- `scripts/harness-ui.mjs`, `scripts/probe-dogfood-r2-fp10-pickers.mjs`,
  `scripts/probe-dogfood-r2-fp12-settings-live.mjs`,
  `scripts/probe-dogfood-type-scale-225.mjs`, `scripts/probe-utils.mjs`,
  `scripts/probe-helpers/harness-runner.mjs`,
  `scripts/probe-helpers/reset-between-cases.mjs` (rewrite to KEEP-list only)

Deleted (W3.5d):
- `scripts/probe-dogfood-r2-fp8-tools.mjs`,
  `scripts/probe-dogfood-r2-fp9-truncate-rewind.mjs`,
  `scripts/probe-dogfood-r2-fp11-i18n-markdown-long.mjs`,
  `scripts/probe-dogfood-r2-fp13-details.mjs`

Modified/deleted (W3.5e):
- `electron/main.ts` (drop `truncation:*`, `import:loadHistory` IPCs)
- `electron/preload.ts` (drop `truncationGet/Set`, `loadImportHistory`)
- `src/global.d.ts` (drop matching declarations)
- `src/i18n/locales/{en,zh}.ts` (remove `chat.planTitle`, `chat.cwdMissing`)
- `src/App.tsx` (remove `ccsm:open-settings` listener)
