# R1 review of 02-store-and-preload-surface — feature-preservation

Reviewer: R1 (feature-preservation)
Round: 1

## Findings

### P0 — §4 I-3a 强制 system theme 永远 resolve 到 dark|light, 可能改 v0.2 默认外观
**Location**: `02-store-and-preload-surface.md` §4 "Invariants" I-3a + §4 "Concrete fix for HP-5"
**Issue**: I-3a 要求 "at first paint, the initial-state `theme` value (default `'system'`) MUST resolve to either `dark` or `theme-light` — never neither"; §"Concrete fix for HP-5" 进一步要求 `resolveEffectiveTheme` 把 "system + osPrefersDark === undefined" 项目到 `'dark'|'light'` 之一, 用 osPrefersDark 当 tiebreak。但 spec 没有说明 v0.2 在 `theme==='system'` 且 `prefers-color-scheme` 不可用 (e.g. 测试环境 / 旧浏览器) 时**显示哪一个主题**。如果 v0.2 是"既不加 dark 也不加 theme-light, 走 CSS 默认 (浅色)", 而 v0.3 强制 fallback 到 (例如) `'dark'`, 用户首次冷启动会看到**反向主题**。
**Why blocker**: P0 — 改用户可观察的默认外观, 没有 user/product 决策授权, 且没引用 v0.2 当前 fallback 实际值。这正是 "while we're at it, let's tidy theme defaults" 类型的 feature drift。
**Suggested fix**: 在 §4 I-3a 旁注明 "v0.2 fallback (when `theme==='system'` AND `osPrefersDark` is undefined) MUST be preserved; fixer MUST `git blame` `resolveEffectiveTheme` and reproduce that exact branch。如果 v0.2 确实是 'neither class set', 那么 R1 路径 = 加 missing 测试 selector 但不引入新 fallback 主题。"

### P1 — §3 "loadState 必须 resolve null" 可能改 v0.2 抛错语义
**Location**: `02-store-and-preload-surface.md` §3 "Required preload-bridge shape" 第二条 MUST ("`loadState` MUST resolve `null` (not throw) when the key isn't set")
**Issue**: spec 把"key 不存在 → resolve null"硬性化, 但没引用 v0.2 行为。如果 v0.2 实际是 throw (然后 persist 代码 try/catch), 改成 resolve null 是**渲染层错误处理路径变化**:之前抛错 → 触发 sentry 上报或 toast, 现在静默 → 数据用默认值且无信号。
**Why blocker**: P1 — 用户可观察行为变化 (没有错误提示了), 且改变 telemetry / sentry 信号面。spec 自己说 "persist 代码 path treats `null` as 'no persisted state, use defaults'", 这暗示 v0.2 已是 null;但没有 git 引用证据。
**Suggested fix**: §3 该 MUST 改为 "`loadState` MUST preserve v0.2 missing-key semantics (verified by `git show 35b08d15^:src/stores/persist.ts` — if v0.2 expects null, return null; if v0.2 expects throw, throw)。"

### P1 — §1 "loadState 类型 Promise<string | null>" 可能 narrow v0.2 类型
**Location**: `02-store-and-preload-surface.md` §3 "Required preload-bridge shape" 第一条 MUST
**Issue**: "loadState is exposed as `Promise<string | null>` (not `Promise<unknown>` or `Promise<JSON>`)" — 如果 v0.2 实际签名是 `Promise<unknown>`, narrowing 到 `string | null` 可能 break 调用方 (即使 spec 说"only persist.ts 用此"); 而 narrow vs widen 的契约方向不是 refactor 该决定的。
**Why blocker**: P1 — TypeScript 类型契约面是 dev-visible 行为, 如果 narrow 错了下游会编译失败。spec 应记录 v0.2 实际签名作为 baseline。
**Suggested fix**: §3 该 MUST 改为 "preserve v0.2 type signature exactly; if v0.2 was `Promise<unknown>`, keep `Promise<unknown>` and add a runtime assertion in persist.ts instead。"

### P2 — §5 "initial state safety" 列出的字段隐含 v0.2 schema 假设
**Location**: `02-store-and-preload-surface.md` §5 sample test ("`expect(s.theme).toBeDefined(); expect(s.fontSizePx).toBeDefined(); expect(s.groups)...`")
**Issue**: 这个示例 UT 列了 `theme / fontSizePx / groups / sessions / activeId / hydrated` 6 个字段,**默认 v0.2 initial state 就是这套**。如果 wave-2 在某 commit 里悄悄改名了 (例如 `fontSizePx` → `fontSize`), 这个 UT 会"修复"成新名字但没人注意到 v0.2 是另一个名字。
**Why blocker**: P2 — UT 自身能保护住未来, 但当下应锁到 v0.2 实际字段名集合。
**Suggested fix**: §5 改为 "fixer MUST `git show 35b08d15^:src/stores/initialState.ts` 提取 v0.2 字段名列表作为 UT canonical set, 不能凭记忆列字段。"

### P2 — §1 catalog "every production symbol's preload bridge MUST list which RPC backs it in a doc-comment"
**Location**: `02-store-and-preload-surface.md` §1 第二条 MUST
**Issue**: 文档要求是好事, 但归在 v0.3 "MUST" 里 = 阻塞 merge。这是 doc-quality 要求, 不是用户行为, R1 角度认为应降级。
**Why blocker**: P2 — 不是 feature drift, 是 scope (doc work) 在 refactor 里被升级。
**Suggested fix**: 该 MUST 降为 SHOULD, 或拆出为 v0.4 follow-up task (可记入 v0.4 backlog)。
