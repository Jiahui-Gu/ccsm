# R5 review — consistency, clarity, naming

Reviewer angle: R5 (pragmatic). Only inconsistencies that cause real reader
confusion are P1. Cosmetic issues are P2. Strict reviewers (R0/R1/R4) own
correctness, security, and architecture; this pass owns "does the spec read
as ONE document".

Scope: all 6 chapters in `docs/superpowers/specs/_toolchain-chapters/`.

## Verdict

**APPROVE with minor fixes.** Terminology, version numbers, and file paths
are uniform across all six chapters. Cross-references resolve. Findings are
mostly cosmetic; two genuine reader-confusion items (F1, F2) are P1 because
they will pull a careful reader up short.

---

## Findings

### P1 — fix before merge

#### F1 (P1) — ch06 done criteria contradicts ch01 + ch06 §v0.3 about scaffold timing

`ch06-rollout.md:158-159` (done criteria #4):

> v0.3 monorepo scaffold (separate spec, daemon-split ch11) lands on top
> of the locked toolchain without modifying any toolchain file.

But `ch01-overview.md:104-108` and `ch06-rollout.md:74-78` BOTH say the
v0.3 monorepo scaffold has ALREADY landed on `working` (with
`pnpm-workspace.yaml`, `packages/{electron,daemon,proto}`,
`pnpm-lock.yaml`, and `packageManager: pnpm@10.33.2`). So the done
criterion describes an event that has already happened in the past.

Reader confusion: "is this thing done or not?" Fix: rephrase done criterion
#4 as something testable in the FUTURE, e.g. "no toolchain-related file
churn on `working` in the 7 days following PR D merge", OR drop the
criterion (since the scaffold landing is upstream of this spec).

#### F2 (P1) — ch06 done criteria #1 omits PR C, but PR C has a 1-week notice gate

`ch06-rollout.md:155`:

> v0.2 PR A, B, D are all merged on `working` branch.

PR C is "process, not code" (announce + 1-week grace period). The spec
explicitly sequences PR D AFTER the PR C grace window
(`ch06-rollout.md:37-40`). Excluding PR C from done criteria is fine in
spirit (you can't merge an announcement) but it leaves a tester unable to
verify the grace window was honored.

Fix: either add a non-merge criterion ("PR C announcement posted ≥7 days
before PR D merged") or explicitly note in done criteria that PR C is
process-only and not directly testable.

---

### P2 — cosmetic / nice-to-have

#### F3 (P2) — ch01 says "exact minor pinned" but ch03 + ch04 pin exact PATCH

`ch01-overview.md:67`:

> **pnpm: 10.x, exact minor pinned via `packageManager` field.**

But `packageManager: pnpm@10.33.2` is a full `MAJOR.MINOR.PATCH` pin, and
`ch03-pnpm-pinning.md:19` correctly says "exact minor + patch". Reader
won't be misled (because the literal string `10.33.2` appears in ch01
line 110 anyway), but the prose is technically wrong.

Fix: ch01 line 67 → "exact patch pinned via `packageManager` field".

#### F4 (P2) — ch02 says "Node 20 → 22" is "2 LTS jumps"

`ch02-node-pinning.md:99-100`:

> we go from Node 20 (current `ci.yml`) to Node 22, which is 2 LTS jumps.

Node LTS lines are 18 → 20 → 22. Going 20 → 22 is ONE LTS jump (or "one
major LTS bump"). It is two minor-major numeric jumps (20 → 21 → 22), but
21 is not LTS. The prose calling this "2 LTS jumps" is likely meant as
"two major versions" but reads as a factual claim about LTS cadence and
will trip a careful reader.

Fix: "which is one LTS bump" OR "which crosses one LTS boundary
(20 → 22)".

#### F5 (P2) — ch04 `.npmrc` comment refers to a non-existent merged spec file

`ch04-engines-strict.md:39`:

```ini
# Toolchain lock — see docs/superpowers/specs/2026-05-03-toolchain-lock-design.md
```

That filename does not exist in the repo today (the spec lives under
`_toolchain-chapters/`). This is a forward-reference assuming the chapters
get merged into a single `2026-05-03-toolchain-lock-design.md`. If the
merged spec is named differently (e.g. `2026-05-03-toolchain-lock.md` to
match the branch name `spec/2026-05-03-toolchain-lock`), the comment goes
stale on day one.

Fix: confirm the canonical merged-spec filename before merge and update
the literal `.npmrc` content here, OR change the comment to point at the
chapter directory `docs/superpowers/specs/_toolchain-chapters/` which is
guaranteed to exist.

#### F6 (P2) — ch06 "TOOLCHAIN-DEBUG.md" reference is misleading

`ch06-rollout.md:146-149`:

> This playbook is referenced from CONTRIBUTING.md as "If install fails,
> see TOOLCHAIN-DEBUG.md" — but the content lives ONLY in CONTRIBUTING.md
> (no duplicate file).

Reads as: "we link to a file that doesn't exist." Intent is clearly: "the
text in the link reads TOOLCHAIN-DEBUG but the anchor target is the
existing section of CONTRIBUTING.md." Confusing as written.

Fix: rephrase as "CONTRIBUTING.md links to its own '## Install
troubleshooting' anchor as 'see toolchain debug guide'; no separate file
exists."

#### F7 (P2) — ch05 onboarding code block has nested triple-backticks

`ch05-ci-and-onboarding.md:106-137` is a fenced ```markdown block whose
body contains nested ```bash blocks (lines 118-121, 126-128, 131-133).
GitHub renders this correctly because the inner fences are indented under
list items, but other Markdown renderers (e.g. some CI doc generators,
plain `marked`, certain editors' previews) close the outer fence at the
first inner ` ``` `. Since this is the contributor-facing onboarding text
that gets copy-pasted into CONTRIBUTING.md, fragility matters.

Fix: switch the outer fence to `~~~markdown` (tilde fences allow nested
backtick fences cleanly), or drop the outer fence entirely and just
render the markdown literally with a "(verbatim text follows)" note.

#### F8 (P2) — Volta footnote resolution is consistent but split across 3 chapters

ch02 §Volta: "Recommended: the manual one-time step." (decision)
ch05 §Onboarding: "Volta users: a one-time `volta pin node@22` is
documented as a footnote, not the main path." (consequence)
ch06 §fallback step 1: "Volta: `volta pin node@22` not run." (diagnostic)

Each chapter is internally clear and they don't contradict, but the
"Recommended: the manual one-time step" sentence in ch02 line 56 has a
trailing parenthetical that's hard to parse:

> volta pin node@22` once locally (it writes to `package.json` but we
> gitignore that diff via a `.gitignore` rule on the `volta` block, OR we
> document the manual pin as a one-time onboarding step). Recommended: …

The OR-branch describes what we did NOT do; the "Recommended" sentence
then picks the second branch. A first-time reader has to re-read this to
realize both options were inside one parenthetical.

Fix: hoist the OR into separate sentences. E.g. "Two options exist: (a)
gitignore the diff via a `.gitignore` rule on the volta block, or (b)
document the manual pin as a one-time onboarding step. We pick (b)
because keeping `volta` out of `package.json` avoids a fourth-tool source
of truth."

#### F9 (P2) — duplicated "why corepack only" rationale across ch01 + ch03

ch01 §Cross-version conventions §Activation (lines 73-76) and ch03
§Onboarding flow + §CI consumption (lines 35-38, 62-66) both explain why
`pnpm/action-setup` and `npm i -g pnpm` are forbidden. Same content, two
phrasings.

This is acceptable for an overview→detail split (overview SHOULD
foreshadow), but the verbiage is nearly identical. If the chapters are
ever flattened into one document, the duplication will stand out.

Fix (optional): trim ch01's version to one sentence pointing to ch03 for
the full "why not".

#### F10 (P2) — ch05 §Reverse-verify matrix row 4 is in matrix table AND deferred

The table at `ch05-ci-and-onboarding.md:191-196` lists row 4 with
`(Optional, v0.4)` in the Environment column, then the prose
(line 204-205) says "Row 4 is deferred — no current self-hosted runner."
Row 4 also appears in `ch06-rollout.md:117-119` as v0.4 deferred work.

Self-consistent, just over-specified. Rebust against drift if row 4 ever
gets reclassified. Cosmetic.

Fix (optional): drop row 4 from the matrix; mention it once in prose
("v0.4 will add a row 4 for self-hosted ARM64").

---

## Things checked and found CONSISTENT

For the record (so a future reviewer doesn't redo the work):

- **Terminology** — "pin" / "lock" used consistently. "Freeze" appears
  ONLY as `--frozen-lockfile` (the literal pnpm flag), never as a design
  term. No drift.
- **Version strings** — `Node 22 LTS`, `Node 22`, `22.x`, `pnpm 10.33.2`,
  `pnpm 10.x` all appear with consistent meaning. The literal
  `pnpm@10.33.2` matches in ch01:110, ch03:14, ch04:110, ch06:78, ch06:137.
- **File paths** — `.nvmrc`, `.npmrc`, root `package.json`,
  `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.github/workflows/ci.yml`,
  `.github/workflows/e2e.yml`, `.github/workflows/release.yml`,
  `CONTRIBUTING.md`, `README.md` — all referenced identically across
  chapters.
- **PR labels A/B/C/D** in ch06 §v0.2 main rollout match the references
  from ch04 §v0.2 callout and ch01 §Relation to other specs (PR #848).
  ch05 doesn't reference PR-letter labels (it only says "v0.2 root once
  migrated to pnpm"); this is not a contradiction, just an asymmetry.
- **ch01 §Forever-stable shape vs ch02-ch04 actual pins** — ch01 says
  "Node major + pnpm major are forever-stable; minor/patch bumps are the
  knobs." ch02 pins major-only in `.nvmrc`. ch03 pins exact patch via
  `packageManager` (knob = the patch bump). ch04's `engines.node: 22.x`
  + `engines.pnpm: 10.x` matches the major-stability promise. Consistent.
- **Reverse-verify matrix self-consistency** — rows 1-3 are exhaustive
  for the three supported OS/arch combos; row 4 is consistently flagged
  as deferred; per-row pass criteria apply uniformly. The matrix
  reverse-verifies the full chain (Node from `.nvmrc` → Corepack → pnpm
  from `packageManager` → engine-strict → install + native build + test).
- **ch06 §Done criteria testability** — criteria 2, 3, 5 are objectively
  testable. Criterion 1 is a state check on `working`. Criterion 4 has
  the F1 issue above.
- **Markdown structure** — heading depth uniform (H1 = chapter, H2 =
  section, H3 = subsection); code-fence languages present and correct
  (`text`, `bash`, `yaml`, `json`, `ini`, `markdown`); tables use the
  same alignment style.

---

## Summary

- Total findings: **10**
- P0: 0
- P1: 2 (F1, F2)
- P2: 8 (F3-F10)

R5 verdict: **APPROVE** once F1 and F2 are addressed. F3-F10 are
nice-to-have and can be batched into a single follow-up cleanup commit
or deferred entirely without harming the spec's usability.
