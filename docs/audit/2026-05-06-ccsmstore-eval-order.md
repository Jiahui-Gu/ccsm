# Audit Q1 — `window.__ccsmStore` bundle-eval order vs hydration

- **Date**: 2026-05-06
- **Task**: #595 (audit-only, no production code change)
- **Spec**: `docs/superpowers/specs/2026-05-06-v0.3-e2e-cutover-design.md`
  §1.2.1 (HP-1), §2.2 (root cause A/B), §5.3.2 (PR-2 contract) —
  spec lives on branch `spec/2026-05-06-v0.3-e2e-cutover` (not yet
  merged to `working`); read at commit `e397dfb8`.
- **Worktree**: pool-2 @ `working` `35b08d15`.
- **Downstream consumer**: PR-2 / Task #601 — uses this report to
  pick a fix variant before dispatch.
- **Scope**: read-only inspection of `src/`, `electron/preload/`,
  `webpack.config.js`, `scripts/probe-utils.mjs`. No code edits.

---

## 1. The question

Spec §1.2.1 names two candidate root causes for HP-1
(`waitForFunction(window.__ccsmStore)` timing out at 20 s in
`seedStore`):

- **A** — module-eval ordering: `__ccsmStore` is set *after* an
  awaited hydrate chain, so when the awaited piece (HP-2
  `window.ccsm.loadState`) throws, `__ccsmStore` is never assigned.
- **B** — duplicate-store regression: a sibling re-export creates
  two `useStore` instances; harness writes to one, renderer reads
  the other.

Q1 asks whether the **current bundle-eval order** can guarantee
that `__ccsmStore` is pinned on `window` before any code path that
could throw and abort the assignment runs — i.e. is the spec's
diagnosis (A) actually present today, and which fix shape
(Option A / B / C from §5.3.2) should PR-2 adopt?

---

## 2. Ground truth — where `__ccsmStore` is set today

Single assignment site. Verified by repo-wide grep
(`Grep '__ccsmStore' src/`):

`src/App.tsx:41-49` (top-level module body, **not** inside any
function or `useEffect`):

```ts
// Initialise i18next once, before any component renders.
initI18n(usePreferences.getState().resolvedLanguage);

// Expose the zustand store on `window` so E2E probes can introspect /
// drive state directly. We set this UNCONDITIONALLY (not gated on
// NODE_ENV) because webpack production builds dead-strip the gated
// branch — leaving probes that exercise a production-built renderer with
// no way to seed state. The exposure is a debug affordance, not a
// security boundary; same trade-off as `window.__ccsmI18n`.
if (typeof window !== 'undefined') {
  (window as unknown as { __ccsmStore?: typeof useStore }).__ccsmStore = useStore;
}
```

`src/stores/store.ts` itself does **not** assign
`window.__ccsmStore` anywhere. The store-module body is purely the
zustand `create<RootStore>(...)` call (lines 18-29) plus the async
`hydrateStore()` export (lines 59-215). `useStore` is buildable
without awaiting persisted state — that part of spec §2.2 Fix A is
already satisfied by the current code; it's the **pin location**
that is wrong.

---

## 3. Bundle-eval order — what actually happens at first JS tick

Bundler: webpack 5, single-chunk output (`webpack.config.js` lines
8-15: `output.filename: 'bundle.js'`, no `splitChunks`, no async
`import()`). So all top-level module bodies execute inline in
import-graph order from `src/index.tsx`.

Walking the entry point (`src/index.tsx`):

1. `sentryInit({})` — sync.
2. `setPersistErrorHandler(...)` — sync, just wires a callback.
3. `window.addEventListener('beforeunload', flushNow)` — sync.
4. `const root = createRoot(document.getElementById('root')!);` — sync.
5. `trace.renderedAt = Date.now();` — sync.
6. **`void (async () => { await installCcsmShim(); root.render(<App/>); void hydrateStore(); })();`** — fires-and-forgets an async IIFE.

Critical observation about step 6: the IIFE body does not run until
the JS event loop yields. At that point, **all module-top-level
bodies imported by `index.tsx` have already executed**, because
ES-module top-level (compiled to CJS by webpack with `__webpack_require__`)
is fully synchronous.

The import graph from `index.tsx` reaches `App.tsx` via
`import App from './App'` at line 7. webpack evaluates `App.tsx`'s
top-level body the first time `__webpack_require__('./src/App.tsx')`
is hit, which is during the synchronous module-init walk triggered
by the `bundle.js` IIFE wrapper — **before** any line of
`index.tsx`'s function-scope body runs.

Therefore `App.tsx:48` `window.__ccsmStore = useStore` runs
**synchronously, before** `installCcsmShim()` is even called and
before `hydrateStore()` is queued.

### Verification of "no await between module-init and the assignment"

Walked `App.tsx`'s import graph for any top-level `await` /
top-level Promise that could re-order eval:

- `import { initI18n } from './i18n'` — `i18n/index.ts` exports
  named functions; no top-level await.
- `import { useStore } from './stores/store'` — store.ts top-level
  is `create<RootStore>(...)` plus declarations; no awaits.
- All other imports are React component / effect-hook modules; none
  use top-level await (verified: webpack 5 with
  `output.module: false` would refuse them anyway).

`initI18n(...)` at `App.tsx:39` runs **before** the
`__ccsmStore` assignment at `App.tsx:48`. `initI18n` is synchronous
on the call path that matters (inspected `src/i18n/index.ts:81`
which references `__ccsmStore` only in a comment). Even if
`initI18n` were async-internally, the assignment would still run as
soon as `initI18n` returns, which is before any `await`-resumption.

### Conclusion on root cause A

**The spec's root-cause-A description is no longer accurate against
current code.** The pin already runs at module eval, not inside an
awaited hydrate callback. `hydrateStore()` is fire-and-forget
(`index.tsx:75 void hydrateStore()`) and the renderer mounts (and
exposes `__ccsmStore`) before hydration even starts.

What the spec describes ("`__ccsmStore` never gets set until
persisted state is read … HP-2 currently throws → HP-1 never
resolves") would only be true if the assignment lived inside
`hydrateStore()` or inside an awaited block in `index.tsx`. It
does not.

### Why HP-1 still times out today (the actual cascade)

`seedStore` waits for **two** conditions joined by `&&`
(`scripts/probe-utils.mjs:357-361`):

```js
await win.waitForFunction(
  () => !!window.__ccsmStore && document.querySelector('aside') !== null,
  null,
  { timeout: 20_000 }
);
```

- `window.__ccsmStore` is pinned synchronously during bundle eval
  (verified above).
- `document.querySelector('aside') !== null` is true only after
  React has rendered the `<Sidebar>` (which lives inside `<aside>`).

`<Sidebar>` mount is gated by `installCcsmShim()` resolving
(`index.tsx:62-76`). `installCcsmShim` does a daemon-port discovery
+ a `/api/window/platform` round-trip. If the daemon is not up —
HP-3 — the shim either falls back to a guessed platform after a
timeout, or `installCcsmShim` itself stalls. Either way the
`<aside>` selector never appears within 20 s.

So **HP-1 today is not a store-pin problem at all** — it is HP-3
(daemon port) bleeding into the `seedStore` second condition. The
guard `!!window.__ccsmStore` becomes true within a few hundred
microseconds; the `aside` half is what times out.

This matters because PR-2 cannot be evaluated against the
acceptance signal "`seedStore waitForFunction` resolves <5 s on a
fresh launch" until PR-3 (daemon-port readiness, Option C) lands.
PR-2's own UT (per spec §5.3.2: `tests/stores/store-eval-order.test.ts`
asserting `(globalThis as any).__ccsmStore === useStore` synchronously
after `await import('src/stores/store')`) **is** still independently
verifiable and is what should gate PR-2 merge.

---

## 4. Root cause B — duplicate-store check

Single `create<...>` call across the codebase. Verified:

```
$ Grep -n 'create<' src/stores/
src/stores/store.ts:18:export const useStore = create<RootStore>((set, get) => ({
```

No other zustand `create(...)` call in `src/stores/**` or `src/`.
No re-export of `useStore` from a sibling path was found by
`Grep "export.*useStore" src/`. Root cause B is **not present**
today, but the spec's prescribed CI guard
(`tests/stores/single-instance.test.ts`) is still warranted as
regression armor.

---

## 5. The §5.3.2 Option A/B/C question

I want to flag a spec-vs-task wording mismatch up front: §5.3.2
(PR-2 contract) does **not** itself enumerate "Option A/B/C". The
A/B/C alternatives in the spec at §3.3.2 are about **HP-3 daemon
spawn timing** (PR-3, not PR-2). The "A/B" inside §2.2 are the two
**root causes**, with one **Fix A** (module-eval pin) and one
**Fix B** (single-instance UT) — both prescribed simultaneously,
not as alternatives.

So I am interpreting the task's "Option A/B/C per spec §5.3.2" as
asking me to recommend, among the implementation shapes available
to PR-2, which one to adopt. I distill three credible variants:

### Variant A — *Move the pin into `src/stores/store.ts`* (spec's literal Fix A)

```ts
// src/stores/store.ts (new lines, immediately after `useStore` declaration)
if (typeof window !== 'undefined') {
  (window as unknown as { __ccsmStore?: typeof useStore }).__ccsmStore = useStore;
}
```

Delete the assignment at `src/App.tsx:48`.

- **Pro**: aligns with the spec's literal Fix-A code block; the pin
  travels with the symbol it pins; harnesses that import store.ts
  directly (none today, but a future test seam) automatically get it.
- **Pro**: tightens the UT contract — `await import('src/stores/store')`
  → `globalThis.__ccsmStore` is the same symbol. Today the UT would
  need to import `App.tsx`, which drags in the entire React tree and
  i18n init.
- **Con**: store.ts becomes side-effecting on import in non-DOM
  environments only by the `typeof window !== 'undefined'` guard; this
  is fine but worth noting the SRP nick (store module also pins to
  global). The current `src/App.tsx:48` location took the same
  trade-off; relocation does not amplify it.

### Variant B — *Keep pin in `App.tsx` but lift it above all imports' side-effecting calls*

The `App.tsx:48` line already runs at module eval. The only
`App.tsx`-level statement that runs *before* it is
`initI18n(...)` at line 39. We could swap the order so the pin
runs first.

- **Pro**: smallest possible diff (two lines moved).
- **Con**: does not move the contract closer to "pinned by the
  module that owns the store." UT for `store-eval-order` still has
  to import `App.tsx`. The pin remains conditional on `App.tsx`
  being imported — fine today (it always is from `index.tsx`),
  brittle if a future refactor splits chunks or makes `App.tsx`
  lazy-loaded.
- **Con**: leaves the misleading historical comment in `App.tsx`
  (the "we set this UNCONDITIONALLY" rationale block) at the wrong
  layer.

### Variant C — *Pin from `index.tsx` directly, before `installCcsmShim()`*

```ts
// src/index.tsx (new lines, before the async IIFE)
import { useStore } from './stores/store';
if (typeof window !== 'undefined') {
  (window as unknown as { __ccsmStore?: typeof useStore }).__ccsmStore = useStore;
}
```

- **Pro**: explicit boot-order: `index.tsx` is *the* renderer entry,
  pinning here makes the contract maximally visible.
- **Pro**: even if `App.tsx` is later code-split or lazy-loaded,
  the pin survives.
- **Con**: `index.tsx` already imports `hydrateStore` from
  `stores/store`, so adding `useStore` to that import is cheap, but
  `index.tsx` becomes a slightly busier bootstrap. The store-pin
  contract is now tested against `index.tsx`, not against
  `stores/store` — slightly weaker than Variant A.
- **Con**: same SRP nick as Variant B (entry module owns a global
  pin that conceptually belongs to the store).

---

## 6. Recommendation

**Adopt Variant A** (spec's literal Fix A — pin in `src/stores/store.ts`).

Rationale:

1. It matches the spec's prescribed code block in §2.2 and the
   spec-prescribed UT in §5.3.2 (`tests/stores/store-eval-order.test.ts`)
   verbatim. PR-2 reviewer can grep-match the spec without
   interpretation.
2. The UT becomes cheap and isolated:
   `await import('src/stores/store')` → assert pin. No React, no
   i18n init pulled in. Fast, deterministic, ESM-native.
3. Resilience to future code-splitting: if the bundle ever
   lazy-loads `App.tsx`, Variant A still pins on first store
   import. Variants B and C both rely on `App.tsx` / `index.tsx`
   being eagerly imported.
4. Co-locates the debug affordance with the symbol it exposes —
   matches the convention already used by `src/i18n/index.ts` (see
   the `__ccsmI18n` comment cross-reference in
   `src/i18n/index.ts:81`).

The historical concern that prompted putting the pin in `App.tsx`
("webpack production dead-strips the gated branch") is preserved
under Variant A — the `if (typeof window !== 'undefined')` guard
is identical, runs at module eval, and webpack's tree-shaker treats
the `window` check as live in `target: 'web'`.

### Sub-tasks PR-2 (Task #601) should bundle

Lifted from spec §5.3.2 acceptance, with notes on what this audit
verified vs. what PR-2 must still do:

| Item | Audit status | PR-2 work |
| --- | --- | --- |
| Move pin to `src/stores/store.ts`, drop `src/App.tsx:48` block | spec-prescribed; current code wrong location | edit |
| `tests/stores/store-eval-order.test.ts` (NEW) — `await import('src/stores/store')` then assert `globalThis.__ccsmStore === useStore` | not present today | add |
| `tests/stores/single-instance.test.ts` (NEW) — glob `src/stores/**/*.ts`, count `\bcreate\s*<[^>]*>\s*\(` matches == 1 | grep confirms count is 1 today; UT missing | add |
| `tests/stores/initialState.test.ts` (NEW) — fields read in `App.tsx` first paint exist on initial state | out of audit scope | add |
| `App.tsx` fires `window.dispatchEvent(new Event('ccsm:app-shell-ready'))` at end of first useEffect | out of audit scope; consumed by PR-8 probe | add + extend `tests/AppShell.test.tsx` |

### What PR-2 will **not** fix on its own

The "`seedStore` resolves <5 s" acceptance signal in spec §2.2.2
**cannot be measured against PR-2 in isolation** because the
`document.querySelector('aside')` half of the wait is gated by
`installCcsmShim()`, which is gated by daemon-port readiness
(HP-3). PR-2 should land the production change + the three new
UTs and document in its PR body that the end-to-end harness
acceptance signal is verified after PR-3 (Option C — `await
spawnDaemon` before BrowserWindow) merges. This is consistent with
spec §5.3.0's symptom-to-PR closure map (PR-2 closes HP-1, PR-3
closes HP-3; the harness symptom that combines them only clears
once both land).

---

## 7. Files inspected (read-only)

- `src/stores/store.ts` (216 lines)
- `src/stores/persist.ts` (121 lines)
- `src/App.tsx:1-90` (assignment + surrounding boot order)
- `src/index.tsx` (full, 77 lines)
- `electron/preload/index.ts` (full, 30 lines) — confirms preload
  installs five `ccsm*` bridges synchronously, no involvement in
  store pin
- `webpack.config.js` (full, 41 lines) — confirms single-chunk
  bundle, no `splitChunks`, no dynamic `import()`
- `scripts/probe-utils.mjs:350-368` (`seedStore` definition)
- `src/lib/window-ccsm-shim.ts:1-50` (confirms `installCcsmShim`
  awaits daemon work — explains the `<aside>` half of the
  20 s wait)

Spec text consulted (from branch `spec/2026-05-06-v0.3-e2e-cutover`
@ `e397dfb8`): §1.2.1, §2.2 (root causes A/B + Fix A/B), §5.3.2
(PR-2 contract), §5.3.0 (symptom-to-PR map), §3.3.2 (Option A/B/C
for HP-3 — out of this PR's scope).
