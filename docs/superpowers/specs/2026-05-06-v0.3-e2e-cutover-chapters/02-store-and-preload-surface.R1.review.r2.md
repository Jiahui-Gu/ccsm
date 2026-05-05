# R1 review of 02-store-and-preload-surface — feature-preservation (round 2)

Reviewer: R1 (feature-preservation)
Round: 2

## Round-1 closures

- **[P0 §4 I-3a theme `system + osPrefersDark === undefined` 可能改 v0.2 默认外观]** — **CLOSED** by CF-5 (commit `1fabeba3`) per manager round-1 拍板 #2. I-3a now reads "Tiebreak (manager-pinned): when `theme === 'system'` and `window.matchMedia` is unavailable … `resolveEffectiveTheme` MUST return `light`. This matches v0.2 short-circuit semantics, verified at `35b08d15:src/stores/slices/appearanceSlice.ts:resolveEffectiveTheme` (v0.2 uses `osPrefersDark: boolean`, no undefined three-state path — when `matchMedia` is unavailable the boolean short-circuits to `false` → effective theme = `light`). v0.3 MUST preserve this boolean short-circuit behaviour and MUST NOT introduce an `osPrefersDark === undefined` three-state branch." This is the exact CF-5 落地 manager 拍板 cited.
- **[P1 §3 "loadState 必须 resolve null" 可能改 v0.2 抛错语义]** — **CLOSED** by F-02 (commit `1fe37ca8`). The MUST now carries an explicit "v0.2 baseline-cite (R1 guard)" paragraph: "fixer MUST verify with `git show 35b08d15^:src/stores/persist.ts` AND `git show 35b08d15^:electron/preload/bridges/ccsmCore.ts` … that v0.2 already resolves `null` (rather than throwing); if v0.2 actually threw, preserve the throw and route the error-slice toast at the persist caller instead."
- **[P1 §3 "loadState 类型 Promise<string | null>" 可能 narrow v0.2 类型]** — **CLOSED** by F-02 (commit `1fe37ca8`). The MUST now carries "v0.2 baseline-cite (R1 guard): this signature MUST preserve the v0.2 type exactly. The fixer MUST verify with `git show 35b08d15^:electron/preload/bridges/ccsmCore.ts` … that v0.2's `loadState` already returns `Promise<string | null>`; if v0.2 was `Promise<unknown>` (or any wider shape), keep that wider type and add a runtime assertion … instead of narrowing — narrowing the public preload surface in v0.3 is out-of-scope feature drift."
- **[P2 §5 initial state 字段隐含 v0.2 schema 假设]** — partially addressed by CF-7 §5 / §4 R5 testability map (UT lever pinned to `tests/stores/initialState.test.ts`); the §5 sample test's specific field list still depends on what the UT ends up importing from `src/stores/initialState.ts`. Not actioned as a hard cite, but P2 → no escalation needed.
- **[P2 §1 "every production symbol's preload bridge MUST list which RPC backs it in a doc-comment"]** — not actioned (P2 deferred per fix-plan); status unchanged.

## Round-2 findings

(none)

Note: CF-5 also introduced a `MUST (failure path)` clause in §3 requiring `loadState` to resolve `null` (not reject) on HTTP 5xx / fetch reject / JSON parse error, with a single fire-and-forget toast via the zustand error slice. This is a NEW behaviour rule not present in v0.2's IPC-era persist path (where transport-level failures simply did not occur the same way). However, this behaviour is justified inline in §3 ("v0.2 treats missing-key and transport failure as the same 'no persisted state' branch") and the F-02 R1 baseline-cite immediately following the MUST chains the failure-path rule onto the same "if v0.2 actually threw, route the toast at persist caller instead" escape hatch. Not raised as a NEW P0/P1: the rule is bounded by the v0.2-cite guard, the toast is fire-and-forget (no UI flow change), and the alternative (hang React mount on daemon mid-boot crash) is a strictly worse user experience. Acceptable under R1.

## Verdict

CLEAN. ch02 round-1 fixes close P0 + 2 × P1 + P2 (theme, loadState type, loadState null). The CF-5 failure-path addition is bounded by F-02's v0.2-cite guard and is acceptable under R1 strict-preservation.
