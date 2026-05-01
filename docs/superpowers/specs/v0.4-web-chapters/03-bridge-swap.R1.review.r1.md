# Review of chapter 03: Bridge swap
Reviewer: R1 (feature-preservation)
Round: 1

## Findings

### P1-1 (must-fix): Updater no-op stubs in web client + "UI hides updater Settings rows when VITE_TARGET === 'web'" — clarify this is per-platform conditional rendering, NOT a feature change
**Where**: chapter 03 §2, "Updater special case" block (last paragraph)
**Issue**: The text says "UI hides updater Settings rows when `import.meta.env.VITE_TARGET === 'web'`". From a strict feature-preservation lens, "hide rows in the web build" IS a renderer behavior change introduced by v0.4 — the same `src/` codebase now renders different UI depending on target. A reader could read this as either (a) acceptable per-platform conditional (the only honest UX given that the web client has no Electron app to update), or (b) a feature redesign of the Settings page. The current wording does not pin down which.
**Why P1**: the §4 hard rule says "the public shape of `window.ccsm*` MUST NOT change in v0.4. Renderer code (`src/`) is unmodified except for ..." — but hiding Settings rows is a renderer-code change inside `src/` (or wherever the Settings UI lives). The spec needs to either (a) explicitly enumerate this conditional as a permitted exception under §4 bullet "Build-time conditionals on `import.meta.env.VITE_TARGET` for the 3 Electron-only surfaces in §2", or (b) describe an alternative (e.g. updater rows show "not available in web" disabled state, preserving structure).
**Suggested fix**: in §4, add the updater Settings rows to the explicit list of permitted `VITE_TARGET` conditionals, OR change §2's "UI hides updater Settings rows" to "updater rows render in disabled state with a tooltip 'auto-update only available in the desktop client'" so the renderer structure is preserved and only the row's enabled-state forks. Either is fine; the spec MUST pin one.

### P2-1 (nice-to-have): Bridge swap §6 "no dual-transport" guarantee is great; cross-link from chapter 01 G3 / A1 for discoverability
**Where**: chapter 03 §6
**Issue**: The "one transport per build per bridge" lock is exactly the discipline that prevents feature drift via "we'll keep envelope as a fallback that subtly behaves differently". Currently only chapter 03 §6 states it; chapter 01 G3/A1 reference the swap but do not name §6 as the implementation discipline.
**Why P2**: cosmetic — makes the no-feature-drift discipline more obvious to a reader entering at chapter 01.
**Suggested fix**: in chapter 01 §1 G3 ("Why" paragraph) and §4 A1 ("Why"), add a one-line cross-ref: "Implementation discipline in chapter 03 §6 (no dual-transport during the swap)."

## Cross-file findings

None for R1 from this chapter (the §2 finding is contained inside chapter 03; no other chapter needs a coordinated change).
