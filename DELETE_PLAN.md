# W3.5 SDK Teardown — Delete Plan

Inventory of the renderer/main SDK surface left over after PR #433 (chat block
deletion). Downstream workers W3.5b–e execute this list verbatim, in order.
Read-only inventory; nothing has been modified by this PR.

Branch base: `971b9de` (origin/working).

## Summary findings

- All five categories are fully dead in production `src/`. No live ttyd-relevant
  code path imports anything from `src/agent/**`, `src/slash-commands/**`,
  the SDK store actions, or the SDK `agent:*` IPCs / `window.ccsm.agent*` methods.
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
     `isEffortRejectionError`). **HOT — but only relative to the
     `electron/agent-sdk/` tree, which is itself slated for removal in W3.5c
     when its `agent:*` IPC handlers go.** Treat the agent-sdk runner module as
     part of the W3.5c sweep; once it's gone, `src/agent/effort.ts` has no
     runtime consumer.
  4. Tests + harness scripts. Tests get deleted/rewritten in their respective
     phases; harness scripts (`harness-agent.mjs` / `harness-perm.mjs` /
     `harness-real-cli.mjs` / `harness-restore.mjs`) only mention the symbols
     in COMMENTS — they don't import them.
- Component-level audit (TtydPane, ClaudeMissingGuide, AppShell, Sidebar,
  CommandPalette, ImportDialog, SettingsDialog, Tutorial, InstallerCorruptBanner)
  shows ZERO references to: `messagesBySession`, `messageQueues`, `runningSessions`,
  `startedSessions`, `interruptedSessions`, `statsBySession`,
  `contextUsageBySession`, `allowAlwaysTools`, `loadMessageErrors`,
  `pendingDiffComments`, `lastTurnEnd`, `stashedDrafts`, `composerInjectNonce`,
  `composerInjectText`, `focusInputNonce`, `diagnostics`, `sessionInitFailures`,
  `globalEffortLevel`, `effortLevelBySession`. Every one of these slices is
  dead at the renderer layer.

**No BLOCKERS surfaced.** Plan is unblocked.

---

## Category 1 — `src/agent/**` (W3.5b)

Files (all under `C:\Users\jiahuigu\ccsm-worktrees\pool-5\src\agent\`):

| File | Lines | Public exports | External importers |
|---|---|---|---|
| `ask-user-question.ts` | 35 | `parseQuestions` | (a) deletable — only used by `lifecycle.ts` |
| `effort.ts` | 179 | `EffortLevel`, `DEFAULT_EFFORT_LEVEL`, `EFFORT_LEVELS`, `ThinkingConfigProjection`, `EffortWireOptions`, `projectEffortToWire`, `thinkingTokensForLevel`, `nextLowerEffort`, `isEffortRejectionError`, `coerceEffortLevel` | (a) deletable once W3.5c removes `electron/agent-sdk/sessions.ts` (only consumer outside tests). Store re-export of `EffortLevel` + `coerceEffortLevel` + `DEFAULT_EFFORT_LEVEL` go away with W3.5d store cleanup. |
| `lifecycle.ts` | 489 | `disposeStreamer`, `setBackgroundWaitingHandler`, `permissionRequestToWaitingBlock`, `maybeAutoResolveAllowAlways`, `subscribeAgentEvents` | (a) deletable — `disposeStreamer` is the only real `src/` import (`store.ts:8`); call site in `store.ts:1309` removed by W3.5d. Other exports have ZERO production callers. |
| `permission.ts` | 12 | `CliPermissionMode` (type only) | (b) trivial inline removal in `src/global.d.ts:1` (replace with literal union) |
| `startSession.ts` | 117 | `startSessionAndReconcile` | (a) deletable — zero `src/` callers; only `tests/store.test.ts` + `tests/top-banner.test.tsx` import it |
| `stream-to-blocks.ts` | 589 | `PartialAssistantStreamer`, `StreamTranslation`, `ToolResultPatch`, `streamEventToTranslation` | (a) deletable — `streamEventToTranslation` only consumed by `lifecycle.ts` and `store.ts:903 framesToBlocks` (both deleted in W3.5d) |

### W3.5b actions

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
   `tests/store.test.ts` (lines ~636–675 and ~1120–1240) — both reference deleted
   exports.

### Verified references

- `src/agent/lifecycle.ts:404` — `i18next.t('chat.planTitle')`: confirmed still
  present in the lifecycle background-waiting handler.
- `src/agent/startSession.ts:95` — `i18next.t('chat.cwdMissing', { cwd })`:
  confirmed still present in the CWD_MISSING branch.

Both i18n keys (`chat.planTitle`, `chat.cwdMissing`) become orphaned bundle
strings after deletion. They are NOT load-bearing; W3.5b can leave them in
`src/i18n/locales/{en,zh}.ts` (untouched) or remove them — neither blocks the
teardown. Recommend leaving for now and sweeping in a later i18n cleanup.

---

## Category 2 — `electron/main.ts agent:* IPC handlers` (W3.5c)

File: `C:\Users\jiahuigu\ccsm-worktrees\pool-5\electron\main.ts` (1506 lines).
Each handler line range starts at the listed line and runs until the closing
`)` of the `ipcMain.handle(...)` call.

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
  `truncation:set` (still used by user-message hover menu's truncate-from-here
  logic — though the hover menu itself is in a deleted block, and its truncation
  store action is dead; W3.5d should also drop the `truncation` store calls,
  and W3.5c can then drop the `truncation:*` IPC pair too. However, since
  `window.ccsm.truncationGet/Set` are wired into the shape, we keep them on
  the SDK-isolated cleanup unless explicit), `ccsm:get-system-locale`,
  `ccsm:set-language`, `connection:read`, `connection:openSettingsFile`,
  `models:list`, `app:getVersion`, `dialog:pickDirectory`, `dialog:saveFile`,
  `tool:open-in-editor`, `window:*`, `import:scan`, `import:recentCwds`,
  `import:loadHistory`, `app:userCwds:*`, `app:userHome`,
  `settings:defaultModel`, `paths:exist`, `commands:list`, `files:list`,
  `shell:openExternal`, `memory:*`, `notification:show`, `notify:availability`,
  `notify:setRuntimeState`, all `updates:*` handlers.

### Helper imports that become dead after handler deletion

In `electron/main.ts` top of file:

- Line 65: `import { sessions } from './agent/manager';` — DELETE entirely.
  All call sites become dead: 426, 438, 446, 574, 1002, 1009, 1015, 1018,
  1043, 1071, 1083, 1110, 1142, 1151, 1158, 1172, 1444–1455, 1477, 1498.
  **HOT — but the `sessions.bindSender(win.webContents)` (line 426) and
  `sessions.rebindSender` (lines 438, 446) calls are gone, replaced by
  `bindCliBridgeSender` (line 430) which already exists. Verify
  bindCliBridgeSender is sufficient before deleting bindSender.**
- Line 66: `import { resolveCwd } from './agent/sessions';` — used inside the
  deleted `agent:start` handler only (line 985) → DELETE.
- Line 81: `import type { PermissionMode } from './agent/sessions';` — used by
  the deleted `agent:start` and `agent:setPermissionMode` handlers → DELETE.
- Line 12: `import { loadHistoryFromJsonl } from './jsonl-loader';` — used only
  by the deleted `agent:load-history` handler → DELETE the import. The
  `electron/jsonl-loader.ts` module itself becomes dead and W3.5c should remove
  it, along with `electron/agent/manager.ts`, the entire `electron/agent/`
  directory, and the entire `electron/agent-sdk/` directory.
- Line 73–74: `import { showNotification, ... }` and `notify` → KEEP (still used
  by `notification:show` and `notify:availability` IPCs).
- Line 75–80: `notify-bootstrap` imports → KEEP (used by `bootstrapNotify`,
  the notification toast router).
- Line 573–578: `bootstrapNotify(createDefaultToastActionRouter({
  resolvePermission: ... }))` — passes `sessions.resolvePermission` as the
  router callback. The router itself is needed for non-SDK toast actions
  (focus/dismiss); the `resolvePermission` field becomes vestigial. W3.5c
  must either (a) accept that `resolvePermission` on the router becomes a
  no-op stub, or (b) reshape `createDefaultToastActionRouter` to no longer
  require this callback. Recommend (b) — clean cut.
- Line 1444–1455: `__ccsmDebug` debug seam exposes `sessions.activeRunnerPids`,
  `sessions.activeSessionCount`, `sessions.selfExitsSinceStart`, plus
  `sessions` itself. Probes / harness consumers must be checked. **Likely
  HOT for harness probes.** W3.5c worker should grep
  `scripts/harness-*.mjs` and `scripts/probe-*.mjs` for `__ccsmDebug` usage
  before deletion and either rewire to `cliBridge` analogues or drop the
  probes alongside the SDK runner.
- Line 1477, 1498: `sessions.closeAll()` in `before-quit` and
  `window-all-closed` → DELETE; `shutdownCliBridge()` (line 1487) already
  handles ttyd teardown for the new world.

### W3.5c actions

1. Remove the 13 `agent:*` handlers listed above.
2. Remove the helper imports (lines 12, 65, 66, 81) and call sites
   (`sessions.bindSender`, `sessions.rebindSender`, `sessions.closeAll`,
   the `sessions.*` entries inside `__ccsmDebug`).
3. Delete the entire `electron/agent/` directory (`manager.ts`, `sessions.ts`,
   `stream-json-types.ts`, `start-result-types.ts`, `list-models-from-settings.ts`
   — verify `list-models-from-settings.ts` separately: `models:list` IPC at
   main.ts:827 still needs default-model + list-models discovery; if that
   functionality lives there it must be relocated, not deleted).
4. Delete the entire `electron/agent-sdk/` directory.
5. Delete `electron/jsonl-loader.ts`.
6. Trim `electron/notify-bootstrap.ts` `createDefaultToastActionRouter` to
   drop the `resolvePermission` parameter.
7. Trim or rewire `__ccsmDebug` (line 1438–1457) — depends on probe audit.

---

## Category 3 — `electron/preload.ts window.ccsm SDK surface` (W3.5c, alongside main.ts)

File: `C:\Users\jiahuigu\ccsm-worktrees\pool-5\electron\preload.ts` (502 lines).

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
`truncationGet`, `truncationSet` (see W3.5c note above — likely also dead but
out of scope for this category if W3.5d doesn't drop them in store.ts),
`getVersion`, `pickDirectory`, `saveFile`, `toolOpenInEditor`,
`scanImportable`, `recentCwds`, `userHome`, `userCwds.{get,push}`,
`defaultModel`, `loadImportHistory`, `pathsExist`, `memory.*`, `commands.list`,
`files.list`, `openExternal`, `notify`, `notifyAvailability`,
`notifySetRuntimeState`, `onNotificationFocus`, `onNotifyToastAction`,
`updates*`, `onUpdate*`, `window.*`, `connection.*`, `models.list`.

### `window.ccsmCliBridge` (KEEP entire surface)

Lines 459–502 — `openTtydForSession`, `resumeSession`, `killTtydForSession`,
`checkClaudeAvailable`, `onTtydExit`. All four are consumed by `App.tsx`
(`checkClaudeAvailable` at line 217) and `TtydPane.tsx` (`openTtydForSession`,
`killTtydForSession`, `onTtydExit`). Untouched.

### `src/global.d.ts` types to trim (W3.5c)

File: `C:\Users\jiahuigu\ccsm-worktrees\pool-5\src\global.d.ts` (318 lines).

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
  (`onAgentExit`), 164 (`onAgentDiagnostic`), 165 (`onAgentPermissionRequest`),
  208 (`loadImportHistory` keep — used by import flow, not SDK).

KEEP `loadImportHistory` (208) — it's the import-flow JSONL reader used to
seed `messagesBySession` on import. **Note:** this becomes dead too once W3.5d
drops `messagesBySession`. Mark for verification: if no remaining caller after
W3.5d, sweep alongside other dead `window.ccsm.*` methods.

`window.ccsmCliBridge` itself isn't declared in `global.d.ts` — it's typed via
`CCSMCliBridgeAPI` exported from preload.ts. Renderer accesses use the
`window.ccsmCliBridge` global through the `cliBridge.d.ts` declaration file
(`src/cliBridge.d.ts`). KEEP that file untouched.

---

## Category 4 — `src/stores/store.ts` SDK slice removal (W3.5d)

File: `C:\Users\jiahuigu\ccsm-worktrees\pool-5\src\stores\store.ts` (2888 lines).

### SDK-only imports

| Line | Import | Disposition |
|---|---|---|
| 8 | `import { disposeStreamer } from '../agent/lifecycle';` | DELETE |
| 9 | `import { streamEventToTranslation } from '../agent/stream-to-blocks';` | DELETE |
| 10–14 | `import { coerceEffortLevel, DEFAULT_EFFORT_LEVEL, type EffortLevel } from '../agent/effort';` | DELETE |
| 15 | `export type { EffortLevel };` | DELETE (no consumers outside `persist.ts:8`, which itself loses the import — see below) |

### State fields to DELETE (in the `type State = { ... }` block, lines 175–345)

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
- `installerCorrupt: boolean;` (278–284) — **KEEP** (consumed by
  `InstallerCorruptBanner.tsx`)
- `composerInjectNonce: number;` (290) — KEEP if InputBar still uses it; the
  InputBar component was deleted in PR #433, so likely DELETE.
  **Verify in W3.5d worker prompt** by re-grepping `src/` for
  `composerInjectNonce` / `composerInjectText` after the SDK actions go.
- `composerInjectText: string;` (291) — same as above.
- `focusInputNonce: number;` (270–276) — same: was for InputBar autofocus →
  likely DELETE.
- `stashedDrafts: Record<string, string[]>;` (292–298) — was for InputBar
  draft recall → likely DELETE.
- `diagnostics: DiagnosticEntry[];` (299–302) — DELETE (banner is gone).
- `sessionInitFailures: Record<string, SessionInitFailure>;` (303–305) —
  DELETE.
- `allowAlwaysTools: string[];` (306–316) — DELETE.
- `pendingDiffComments: Record<string, Record<string, PendingDiffComment>>;`
  (317–327) — DELETE.
- `lastTurnEnd: Record<string, 'ok' | 'interrupted'>;` (339–344) — DELETE.

KEEP: `sessions`, `groups`, `recentProjects`, `userHome`,
`claudeSettingsDefaultModel`, `activeId`, `focusedGroupId`, `model`,
`permission`, `sidebarCollapsed`, `sidebarWidth`, `theme`, `fontSize`,
`fontSizePx`, `tutorialSeen`, `notificationSettings`, `models`, `modelsLoaded`,
`connection`, `hydrated`, `installerCorrupt`, `openPopoverId`.

### Type / interface declarations to DELETE

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

### Action types in `Actions` (455–660) and impls — DELETE

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
| `setSessionState` (568) | 2300 | DELETE — but verify Sidebar doesn't read `Session.state` |
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

### Other dead exports

- `function framesToBlocks` (903–969) — DELETE.
- `function userFrameToBlock` (search nearby) — used only by `framesToBlocks`,
  DELETE.
- `function migrateNotificationSettings` (742) — KEEP (used by hydration).
- `function sanitizeEffortLevelMap` (758) — DELETE (only used by
  `globalEffortLevel`/`effortLevelBySession` hydration).
- `inFlightLoads` set (889) — used by `loadMessages` only, DELETE.

### Persistence (`src/stores/persist.ts`) follow-up

Drop these from `PERSISTED_KEYS` (lines 35–51) and `PersistedState` (55–85):

- `globalEffortLevel`
- `effortLevelBySession`
- The `EffortLevel` import on line 8.

KEEP: `sessions`, `groups`, `activeId`, `model`, `permission`,
`sidebarCollapsed`, `sidebarWidth`, `theme`, `fontSize`, `fontSizePx`,
`recentProjects`, `tutorialSeen`, `notificationSettings`.

### Estimate

Conservative deletion estimate over `store.ts`'s 2888 lines:

- Imports/types/interfaces: ~120 lines
- State field declarations: ~90 lines
- Action type signatures: ~190 lines
- Action implementations: ~900–1100 lines
- `framesToBlocks` + helpers: ~120 lines
- Persistence migrations: ~30 lines

**Estimated total: ~1450–1650 lines deleted (≈50–55% of the file).**

This crosses the 40% threshold flagged in the W3.5a brief. **RECOMMENDATION:**
W3.5d should treat this as a **rewrite** of `store.ts` rather than surgical
edit:

1. Author a fresh `store.ts` containing only the kept State fields, kept
   Actions, and kept persistence logic.
2. Diff against the current file as a sanity check (every removed symbol
   should be in the DELETE column above; every kept symbol should be
   intact).
3. Hand off to a separate worker for the test-rewrite phase
   (`tests/store.test.ts`, `tests/lifecycle.test.ts`, etc. — most likely
   wholesale deletion + a handful of new tests for session/group CRUD only).

The rewrite path is far less error-prone than surgical extraction at this
ratio — too many cross-cutting fields to thread through `set((s) => …)`
calls without clobbering live state.

---

## Category 5 — `src/slash-commands/**` (W3.5b, alongside Category 1)

Files (all under `C:\Users\jiahuigu\ccsm-worktrees\pool-5\src\slash-commands\`):

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

### W3.5b actions (Category 5 part)

1. Delete the entire `src/slash-commands/` directory.
2. Delete the three test files listed above.
3. Verify the `App.tsx:295–299` `ccsm:open-settings` window listener: the
   dispatcher (`handleConfig` in `handlers.ts:88`) is going away, so the
   listener becomes a one-sided no-op. SAFE to keep (it's harmless) or
   remove. Recommend removing for cleanliness.

---

## Worker handoff order

W3.5b first (deletes src/agent + src/slash-commands together — both pure
src-tree deletions, no cross-file impact beyond the two listed in
Category 1: `src/global.d.ts:1` inline type and `src/stores/store.ts` import
removal-but-defer-to-W3.5d). Once W3.5b lands and TS compiles:

W3.5c (electron deletion + preload trim + global.d.ts type trim). This is the
biggest cross-process cut. **Verify `__ccsmDebug` probe consumers before
deleting the helper imports** — see Category 2.

W3.5d (store rewrite). MUST come after W3.5b (so `src/agent/` imports are
already gone) and after W3.5c (so the IPC channels the deleted store actions
called are also gone — avoids the brief window where the renderer holds dead
IPC handles).

W3.5e (final sweep): trim orphaned i18n keys (`chat.planTitle`,
`chat.cwdMissing`), remove `window.ccsm.loadImportHistory` if unused after
W3.5d, drop `truncation:*` IPC pair if W3.5d removed the truncation store
calls, audit `App.tsx:295–299` `ccsm:open-settings` listener.

---

## Files at-a-glance (absolute paths)

Deleted entirely:
- `C:\Users\jiahuigu\ccsm-worktrees\pool-5\src\agent\` (6 files)
- `C:\Users\jiahuigu\ccsm-worktrees\pool-5\src\slash-commands\` (2 files)
- `C:\Users\jiahuigu\ccsm-worktrees\pool-5\electron\agent\` (W3.5c)
- `C:\Users\jiahuigu\ccsm-worktrees\pool-5\electron\agent-sdk\` (W3.5c)
- `C:\Users\jiahuigu\ccsm-worktrees\pool-5\electron\jsonl-loader.ts` (W3.5c)
- `tests/effort.test.ts`, `tests/permission.test.ts`,
  `tests/stream-to-blocks.test.ts`, `tests/lifecycle.test.ts`,
  `tests/top-banner.test.tsx`, `tests/slash-commands-handlers.test.ts`,
  `tests/slash-command-picker.test.tsx`,
  `tests/slash-commands-registry.test.ts`

Modified:
- `C:\Users\jiahuigu\ccsm-worktrees\pool-5\src\global.d.ts`
- `C:\Users\jiahuigu\ccsm-worktrees\pool-5\src\stores\store.ts` (rewrite)
- `C:\Users\jiahuigu\ccsm-worktrees\pool-5\src\stores\persist.ts`
- `C:\Users\jiahuigu\ccsm-worktrees\pool-5\electron\main.ts`
- `C:\Users\jiahuigu\ccsm-worktrees\pool-5\electron\preload.ts`
- `C:\Users\jiahuigu\ccsm-worktrees\pool-5\electron\notify-bootstrap.ts`
  (drop `resolvePermission` from `createDefaultToastActionRouter` arg shape)
- `C:\Users\jiahuigu\ccsm-worktrees\pool-5\tests\store.test.ts` (trim
  `framesToBlocks` + `startSessionAndReconcile` describes)
- `C:\Users\jiahuigu\ccsm-worktrees\pool-5\src\App.tsx` (remove
  `ccsm:open-settings` listener — W3.5e)
