# cwd indicator + first-run empty state — design brainstorm

Task 326. Brainstorm only. No code.

Sources: PR #248 dogfood log `dogfood-logs/dogfood-public-001-2026-04-24.md` Gap #2 (first-run) and Gap #3 (cwd). Issues #317 (T4), #314 (T7), #312 (T5, absorbed), #313 (T11, knock-on), #316 (T13, deleted).

## Layer 1 verdict

Brainstorm IS necessary, but only barely. The negatives are obvious:

- Auto-creating an unnamed session at launch is obviously wrong: violates "don't invent state users won't maintain" — the user did not ask for a session, and the unnamed group is unmaintained product-side state.
- Defaulting cwd to `C:\Users\jiahuigu` is obviously wrong: silent destructive default for any write-heavy task.

What is not obvious is the replacement. Each problem has 3 plausible alternatives that materially affect onboarding flow, T11's status, and CLI density. Sub-questions T4.a (visibility), T4.b (default), T7.a (auto-create) need a decision; the rest are downstream consequences.

## T4 — cwd indicator + default

### T4.a Visibility — where to show cwd

Today: cwd lives only inside the popover. The trigger label is `lastSegment(cwd)` which for the home default reads `jiahuigu` — looks like a username, not a path.

**Option A — monospace chip in input bar (last 1-2 segments + folder glyph)**

```text
+--------------------------------------------------------------+
|  [#] personal   /  scratch                                   |
|  > ___________________________________________________       |
|     [folder] ccsm/src   v       Enter to send                |
+--------------------------------------------------------------+
```

Tooltip: full path. Click: opens existing CwdPopover.

**Option B — bottom strip, full short-form path always visible**

```text
+--------------------------------------------------------------+
|  > ___________________________________________________       |
|                                                              |
|  [folder] C:\Users\jiahuigu\projects\ccsm   ~  branch: main  |
+--------------------------------------------------------------+
```

Path lives in a dedicated bottom strip. Click strip = open popover. Truncate middle when narrow.

**Option C — inline placeholder hint when empty**

```text
+--------------------------------------------------------------+
|  > Type a message in C:\…\ccsm and press Enter               |
|                                              [folder] ccsm v |
+--------------------------------------------------------------+
```

Disappears the moment user types. Density wins, but cwd vanishes during composition — exactly when the user needs it.

**Recommendation: Option A.** Cite: `feedback_design_density_polish.md` (block rendering + monospace + scannable). The path sits next to the composer where action happens; segment count adapts to width; the existing popover is the click target so no new component. Option B costs a row at the bottom, redundant with the StatusBar. Option C disappears at the wrong moment.

### T4.b Default cwd

Today: home directory.

**Option A — last-used cwd per group.** Group is the user-defined axis (repo-agnostic moat). New session in group `personal` reuses the cwd the previous session in `personal` ended on. Empty group falls back to T4.b's first-time path: empty placeholder, popover auto-opens.

**Option B — last-used cwd per session.** Session-level memory; new session resets. Effectively the same as today for the new-session case.

**Option C — block submit until picked.** Composer disabled, banner says "Pick a working directory first". Constrains the user.

**Option D — explicit no-default.** Empty cwd shown as `[folder] (none)`. Popover auto-opens on first focus. User can still type a message before picking.

**Recommendation: Option A + Option D fallback.** Cite: "repo-agnostic groups" moat (group is the persistence axis), "don't invent state users won't maintain" (group exists because user made it; per-group cwd is a memory of past *user choice*, not invented state), "don't constrain the user" (no submit block; D's auto-open popover is a nudge, not a wall). Option B fails the new-session case; Option C blocks the user.

### T4.c cwd chip rebrand (absorbs T5 #312)

Today: chip reads `jiahuigu` because home cwd's last segment is the user name. Misleading.

**Pick:** folder glyph + last segment, or last 2 segments when first segment is one of `[users, home, projects, repos, src, dev]`. Always full path on tooltip. When cwd is empty, render `(none)` in `text-fg-tertiary` italic. Resolves with T4.a — the chip *is* the cwd indicator.

```text
[folder] ccsm/src      <-- normal
[folder] (none)        <-- no cwd set
[folder] dogfood-tgt   <-- single segment in a known prefix
```

## T7 — first-run empty state

### T7.a Auto-create session at launch

**Option A — kill auto-create.** Show empty state with three sentence-case CTAs.

```text
+--------------------------------------------------------------+
|                                                              |
|     Welcome to ccsm.                                         |
|                                                              |
|     [+] Create your first group                              |
|     [v] Import a CLI session                                 |
|     [>] Start a new session                                  |
|                                                              |
|     Tip: groups organize sessions by task, not by repo.      |
|                                                              |
+--------------------------------------------------------------+
```

**Option B — keep auto-create, pre-name from onboarding.**

```text
+--------------------------------------------------------------+
|  [#] personal  /  new session                                |
|                                                              |
|     Ready when you are.                                      |
|     Type a message and press Enter.                          |
|                                                              |
|     Or: import a CLI session  ·  rename this group           |
|                                                              |
+--------------------------------------------------------------+
```

Onboarding step 4 asks "Name your first group" (default "personal"); session is auto-created inside it. Continuity preserved.

**Option C — keep current.** Status quo. Onboarding promises group/session/import; main pane delivers an unnamed shell. Rejected.

**Recommendation: Option A.** Cite: "don't invent state users won't maintain" — auto-created sessions are exactly the state we should not invent. The 8-week author-self-use deadline (`project_direction_locked.md`) favours clarity over hand-holding; the author opens the app dozens of times and a 3-CTA palette is faster than dismissing a phantom session. Onboarding continuity is fixable inside Option A by pre-selecting the first CTA `Create your first group` with focus.

Caveat: Option A is correct on principle, Option B is correct on UX continuity. If user rejects A on continuity grounds, the fallback is B with onboarding step 4 asking for a group name (no skip). B then becomes acceptable because the group is user-named, not invented.

### T7.b Knock-on for T11 #313 (auto-named session disambiguation)

- T7 = A: T11 becomes moot. No auto-creation path; user names the group, session title derives from first prompt with timestamp fallback only on user-driven `New session` clicks. T11 collapses into "use first-prompt as title; timestamp fallback" — keep open as a simpler scope.
- T7 = B: T11 stands as triaged. First-prompt as title, timestamp fallback for empty sessions, `(2)` suffix on collisions.
- T7 = C: T11 stands unchanged.

### T7.c T13 #316 group choice on new session

Confirmed deleted. None of the recommended options reintroduces a "must pick group" modal. Option A's "Create your first group" CTA is a first-time prompt only, not a per-session gate.

## State of downstream tasks

- T5 #312 — absorbed into T4.c. Close T5 once T4.c lands.
- T11 #313 — status depends on T7 outcome (see T7.b).
- T13 #316 — confirmed deleted, not reintroduced.

## Open questions for the user

1. **T7.a tie-break.** A (kill auto-create, 3-CTA empty state) vs B (auto-create with onboarding-named group). Principle says A; UX continuity says B. Pick.
2. **T4.a chip placement.** Composer chip (Option A) confirmed, or move to bottom strip (Option B) for taller composers? Default to A unless overridden.
3. **T4.b empty-group fallback.** When a group has no past cwd, do we (i) auto-open the popover on focus or (ii) only show `(none)` and let the user click? Default (i).

## Recommendation summary (one-liner each)

- T4.a: composer chip with `folder + last 1-2 segments`, tooltip full path, click opens existing popover.
- T4.b: per-group last-used cwd; empty-group fallback = `(none)` placeholder + popover auto-opens on focus.
- T4.c: folder glyph + smart last-segment(s); never user name; `(none)` when unset; absorbs T5.
- T7.a: kill auto-create; 3-CTA empty state with `Create your first group` focused.
- T7.b: under recommended T7=A, T11 simplifies to "first-prompt title + timestamp fallback" on user-clicked new sessions only.
- T7.c: no group-choice modal anywhere; T13 stays deleted.
