# Review of chapter 02: Store and preload surface

Reviewer: R2 (security)
Round: 1

## Findings

### P2-1 (nice-to-have): `loadState`/`saveState` key validation not specified at preload bridge

**Where**: chapter 02, §3, "Required preload-bridge shape" code block (lines ~118-129) and "Daemon-side wiring" paragraph (lines ~146-152).

**Issue**: The preload bridge shape `loadState: (key: string) => rpcGet('/api/data/get?key=' + encodeURIComponent(key))` and `saveState(key, value)` accept arbitrary `string` keys with no length cap, no charset constraint, and no allow-list. The daemon-side UT requirement only covers `set(empty key) → 400`. The renderer is the trust boundary today (single-window Electron, loopback) so this is not a remote attack surface, but the bridge is a stable public surface that v0.4 web frontend (per `spec/2026-04-30-v0.4-web-frontend-design.md`) will eventually expose to a non-Electron renderer. Pinning the key shape in v0.3 prevents accidental coupling to "any string is fine" semantics that would later need a breaking-change deprecation.

**Why this is P2** (not P0/P1): no v0.3 attack vector. Single-window, loopback, no network exposure. Pure forward-compat hardening.

**Suggested fix**: add a one-line MUST in §3 — "`loadState`/`saveState` MUST reject keys longer than 256 chars or containing characters outside `[A-Za-z0-9._-]`; daemon returns `{ ok: false, error: 'bad_request' }`. UT covers oversized key + invalid charset." Or explicitly defer to v0.4 with a `Why deferred:` note so future fixers don't have to re-derive the call.

### P2-2 (nice-to-have): e2e-debug surfaces (`__ccsmStore`, `__ccsmTerm`, `__ccsmHydrationTrace`) are exposed in production builds

**Where**: chapter 02, §1 "Surface catalog" table (lines ~19-31), specifically the four "e2e-debug" rows.

**Issue**: §1 marks these as "e2e-debug" but the MUSTs that follow ("MUST be set by the same module that owns the underlying state") have no production-vs-test gate — i.e., shipped Electron builds also expose `window.__ccsmStore = useStore`, giving any renderer-loaded script (DevTools, content script, malicious npm dep with renderer-side import) full app-state mutation. v0.2 already shipped with this; chapter 02 is faithful to the existing model. This is **not a v0.3-introduced** attack surface.

**Why this is P2** (memory rule: don't cry-wolf about pre-existing surfaces): the e2e-debug pins predate v0.3. Removing them in v0.3 would break harnesses (the whole point of this spec is unbreaking harnesses). Chapter 02 §6 already lists "Renaming `window.__ccsmStore` etc." as v0.4 hardening — that's the correct call.

**Suggested fix**: in §1, add one sentence after the table: "All `__ccsm*` symbols are gated by a `process.env.NODE_ENV !== 'production'` check today (verify in §2 Fix-A code) — v0.4 hardening will replace with a stricter gate (e.g., `--enable-test-affordances` electron flag)." If the verify shows the gate is NOT in fact present today, that becomes a separate v0.4 P0; chapter 02 should call out the verification explicitly.

### P2-3 (nice-to-have): persisted state JSON parse path lacks explicit size/depth cap

**Where**: chapter 02, §3 "Migration policy" paragraph (lines ~155-159) and §4 mermaid diagram step `Daemon-->>Preload: <persisted JSON> | null`.

**Issue**: `loadState` returns a raw string that `src/stores/persist.ts` `JSON.parse`-es and `setState`-es into the live zustand store. No explicit size cap is stated. If a future bug or downstream tool corrupts the persisted blob (or, post-v0.4, a web client writes a hostile blob), the renderer parses a megabyte+ of attacker-controlled JSON into store state. v0.3 is single-renderer + loopback so the blast radius is local-only.

**Why this is P2**: pre-existing v0.2 behavior. v0.3 doesn't change the parse path.

**Suggested fix**: add a one-line `SHOULD` in §3 — "daemon `/api/data/set` SHOULD reject values > 1 MiB with `{ ok: false, error: 'value_too_large' }`; renderer `loadState` consumer SHOULD treat parse failure as `null` (use defaults) rather than crash." Either land in v0.3 or document as v0.4 follow-up.

## Cross-file findings (if any)

P2-1 and P2-3 both concern the `loadState/saveState` daemon-bridge contract; a single fixer (PR-1 owner per chapter 05 §3) is best positioned to address both atomically if accepted.
