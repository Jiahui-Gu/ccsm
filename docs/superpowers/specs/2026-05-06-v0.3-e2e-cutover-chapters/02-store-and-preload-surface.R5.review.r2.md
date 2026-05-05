# Review of chapter 02: Store and preload surface

Reviewer: R5 (Testability)
Round: 2

## Round-1 closures

- **R1 P0-1 (hydration invariants I-1/I-2/I-3 have no UT lever — only e2e)** — CLOSED. §4 now carries a "Required UT levers (R5 testability map for §4 invariants)" subsection (lines 369-388) with a per-invariant table:
  - I-1 → `tests/stores/store-eval-order.test.ts` **NEW** (pin-at-eval assertion).
  - I-2 → no UT (integration-only, harness `startup-paints-before-hydrate`).
  - I-3a → `tests/app-effects/useThemeEffect.test.tsx` **EXTEND** (file exists at HEAD `5d0c5375` — false-NEW from r1 corrected).
  - I-3b → same EXTEND file.
  - I-5 (NEW invariant added per r1 P1-3) → `tests/stores/persist.test.ts` **NEW** spy on `loadState`, assert `callCount === 1`.
  - §5 → `tests/stores/initialState.test.ts` **NEW**.
  Plus the closing MUST: "each UT in the table above MUST land in the SAME PR as its corresponding production fix." NEW vs EXTEND status now explicit. Verified at HEAD: `tests/app-effects/useThemeEffect.test.tsx` exists (EXTEND correct); `tests/stores/{store-eval-order,initialState,single-instance,persist}.test.ts` all do NOT exist (NEW correct); `tests/components/TerminalPane.test.tsx` does NOT exist (NEW correct).
- **R1 P1-1 (Fix-B duplicate-store has no automated guard)** — CLOSED. §2 Root cause B (lines 96-114) now carries the explicit MUST UT: `tests/stores/single-instance.test.ts` **NEW** with the glob+regex assertion exactly as r1 suggested. CI catches the regression; no longer rests on a one-time grep.
- **R1 P1-2 (§3 daemon-side wiring UT scope incomplete)** — CLOSED. §3 "Daemon-side wiring" (lines 213-232) now (a) explicitly says "**NEW directory + file** — the `daemon/api/__tests__/` subdir does not yet exist at HEAD; the PR creates it implicitly", and (b) extends the UT case list to include encoded keys (`& ? # %`), unicode keys (`'theme.zh-CN'`), and large values (>100 KiB). The exact gaps r1 flagged are filled. Verified `daemon/api/__tests__/` does NOT exist at HEAD — NEW dir annotation is correct.
- **R1 P1-3 (mermaid hydration sequence assumes one `loadState` but doesn't pin it)** — CLOSED. §4 now has invariant I-5 (lines 307-316): "cold paint MUST issue **exactly one** `window.ccsm.loadState(STATE_KEY)` call. The mermaid diagram above pins the singular call as a contract, not just current behaviour. **MUST UT (R5 testability lever)**: …extend it with a case that mocks `window.ccsm.loadState` as a `vi.fn()` spy, runs the cold-paint hydration through `persist.ts`, and asserts `spy.mock.calls.length === 1`." Pinned via UT, mapped to the new `tests/stores/persist.test.ts`.
- **R1 P2-1 (initial-state UT field list is illustrative)** — NOT CLOSED at the literal level (the §5 code block lines 402-416 still lists 6 fields with `// …`). HOWEVER §4 lever table row "§5 initial-state coverage" now says "Every field used in App.tsx first paint exists; `hydrated === false` pre-loadPersisted; **top-level keys snapshot pinned**." The snapshot-pin requirement is now in the lever table even though the §5 illustrative code block wasn't rewritten. Sufficient for the fixer to land a snapshot test (the lever table is normative).

## Findings

No P0/P1 from R5 testability angle. The chapter is the most thoroughly improved by the round-1 fix pass: every invariant has a named UT, every UT has a NEW/EXTEND status grounded in HEAD, and every UT is required to co-land with its production fix.

### P2-1 (nice-to-have, carryover from r1): §5 code block illustrative test still shows `// …`

**Where**: chapter 02, §5 "Initial state safety", code block (lines 402-416).
**Issue**: code block lists 6 fields with trailing `// …`. The §4 lever table now says "snapshot pinned" but the §5 code block itself wasn't updated to show the snapshot pattern. A fixer copy-pasting the code block (rather than reading the lever table) gets the half-test.
**Why P2**: lever table is normative and will be read first by any sane fixer; code block is illustrative. Cosmetic doc consistency.
**Suggested fix**: update the §5 code block to show the snapshot test pattern (`expect(Object.keys(s).sort()).toMatchInlineSnapshot()` plus the `expect(s.hydrated).toBe(false)` for the load-bearing flag). Or add a comment "see §4 lever table — snapshot is the canonical shape; the explicit asserts below are illustrative for the pre-snapshot fields."

## Cross-file findings

None new. r1 P1-2 (`daemon/api/__tests__/` is NEW dir) cross-cut to ch05 PR-1 + PR-5: ch05 §3 path-existence note (lines 79-87) and PR-1 / PR-5 "Files touched" entries explicitly mark NEW dir + file. r1 P1-3 (one `loadState` call) cross-cut to ch04 §4 `loadstate-roundtrip` harness case: present in the case table, assertion is `saveState` then `loadState` round-trip. Both consistent.

## Verdict

**CLEAN** for ch02. One cosmetic carryover (P2-1 §5 code block) remains at P2 — not blocking.
