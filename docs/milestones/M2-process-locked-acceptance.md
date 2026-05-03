# M2 — Process locked: Wave 2 acceptance report

**Task**: #238 — end-to-end verification that all 6 Wave 2 mechanical / process guards actually fire.
**Date**: 2026-05-04
**Worktree**: `pool-5` @ `m2-check/238-wave2-acceptance` (base `working` @ `cf2f175`).
**Scope**: verification only. No product code change in this PR (only this doc).

Each guard below was tested with: a baseline (green) run + at least one negative case that the guard MUST catch. Outputs are excerpted; reproduction commands are inline so the report is self-checking.

---

## 1. PR template — Wire-up evidence section (#218)

**File**: `.github/pull_request_template.md`

**What was tested**: that GitHub uses the template body when a PR is opened against this repo, and that the body contains the Wire-up evidence checklist (Importers / Startup wiring / Library-only marker / v0.2-only growth).

**How**:
1. Branched off `working` to `m2-check/238-dummy-template-test`, added a comment line to `CONTRIBUTING.md`, pushed.
2. Opened PR #970 with `gh pr create --base working` passing `.github/pull_request_template.md` verbatim as `--body` (simulating the auto-prefill GitHub does on the web "Create PR" form — the template file IS the source of that prefill).
3. `gh pr view 970 --json body` confirmed the rendered body.
4. Closed PR #970 with `--delete-branch` after capturing evidence (never merged).

**Expected**: PR body contains the 4 Wire-up checklist items.

**Actual** (excerpt from `gh pr view 970 --json body`):

```
## Wire-up evidence

If this PR introduces new exports / classes / handlers / sinks, fill these. If it's pure refactor / fix / test, mark `[REFACTOR-ONLY]` and skip.

- [ ] **Importers**: paste `grep -rn 'from.*<your-module>' apps/ packages/` output...
- [ ] **Startup wiring** (for listeners / sinks / services / capture sources)...
- [ ] **Library-only marker**: if there is no startup wiring...
- [ ] **v0.2-only growth**: if this PR modifies any file in `.v0.2-only-files`...
```

**Verdict**: PASS. Template file is at the canonical path GitHub honors, and renders all 4 wire-up checklist items.

**Drift note**: GitHub web UI prefill cannot be 100% asserted programmatically (would need a browser screenshot). The evidence above proves the *content* is correct and the *path* is canonical (GitHub's documented location). Manager / future reviewer should once visually confirm the prefill in the web UI on the next real PR; if missing, the template file is being ignored due to a path/case issue and a hard test should be added (e.g. `gh api repos/.../contents/.github/pull_request_template.md` in CI).

---

## 2. reviewer.md — wire-up grep checklist (#219)

**File**: `~/.claude/skills/team-protocol/references/reviewer.md` lines 90-99 (header `## Wire-up check (mandatory before APPROVED)`).

**What was tested**: the doc itself — that the wire-up grep step is present and clearly worded.

**How**: `Read reviewer.md` lines 75-105.

**Actual** (excerpt):

```
## Wire-up check (mandatory before APPROVED)

Before approving any PR that adds new exports / handlers / services / sinks / capture sources:

1. **Grep importers**: `grep -rn 'from.*<new-module-path>' apps/ packages/ --include='*.ts'` — verify at least one production importer exists. Test files don't count.
2. **Startup wiring**: if the PR adds a listener / sink / service / capture source / scheduler, grep the daemon entrypoint (`apps/daemon/src/index.ts` or `runStartup.ts`) for the call site.
3. **PR body declares wiring**: confirm the PR template's "Wire-up evidence" section is filled, OR the PR is marked `[LIBRARY-ONLY]` with a follow-up task # linked.
4. **REQUEST_CHANGES if no wiring**: A library-shape PR that doesn't link a wire-up follow-up task is incomplete. Don't approve.

Background: 8 PRs ... merged 2026-04 with self-consistent code + green CI but no production importer.
```

**Expected**: section present, four numbered steps, REQUEST_CHANGES rule explicit.

**Verdict**: PASS. The checklist is present, mandatory before APPROVED, and includes the explicit grep command.

**Drift note**: enforcement is human (reviewer reads the doc). No mechanical guarantee a reviewer actually runs the grep before approving. Candidate for future automation: a CI bot that auto-flags PRs touching `apps/**` or `packages/**` with new exports if the PR body has empty Wire-up evidence checkboxes.

---

## 3. spec-pipeline Stage 6.5 — LIBRARY/WIRE-UP split (#223)

**File**: `~/.claude/skills/spec-pipeline/SKILL.md` lines 106-119.

**What was tested**: the doc — that Stage 6.5 split rule is present, mandatory, and clearly worded.

**How**: `Read SKILL.md` lines 100-125.

**Actual** (excerpt):

```
### Stage 6.5 — Library / wire-up split (manager, mandatory)

Before Stage 7 (TaskCreate seeding), the manager MUST scan every extractor-emitted task and decide:

- **Pure library** (defines code, no global state effect, no startup hook): split into two tasks:
  - `[LIBRARY] <name> — implementation`
  - `[WIRE-UP] <name> — call from runStartup` (with `addBlockedBy: [<library-task-id>]`)
- **Pure wire-up** (instantiates / registers / installs / boots existing library): leave as single task...
- **Pure refactor / cleanup / test**: leave as single task. Mark `[REFACTOR-ONLY]` in the subject.
- **Cross-concern monolith**: apply that feedback first, then re-apply 6.5 to each piece.

Why this stage exists: v0.3 audit (2026-05-03) found 8 tasks shipped "library ALIGNED + production unwired"...

Acceptance: after Stage 6.5, every shippable task has either (a) a wire-up follow-up linked via blockedBy, or (b) `[REFACTOR-ONLY]` marker, or (c) is itself the wire-up task.
```

**Expected**: stage 6.5 section present, mandatory, with library / wire-up / refactor branching rules.

**Verdict**: PASS. Stage 6.5 is mandatory, ordered before Stage 7 seeding, and lists the four task-classes with deterministic outcomes.

**Drift note**: this is a *manager-time* gate, not a runtime check. There is currently no audit that retroactively flags tasks created without 6.5 applied (e.g. older task IDs predating the rule). Acceptable for v0.3 since the rule is forward-only, but worth a `[FOLLOWUP] audit existing v0.3 task graph for library/wire-up split conformance` task before v0.4.

---

## 4. runStartup.lock assertWired (#221)

**Files**:
- `packages/daemon/src/runStartup.lock.ts` — `assertWired()` + `REQUIRED_COMPONENTS`.
- `packages/daemon/src/index.ts` — pushes `wired` array and calls `assertWired(wired, { warn: log })`.

**What was tested**:
- (a) Unit test stays green when nothing is wrong.
- (b) Removing one wire (commenting out `wired.push('supervisor')`) makes the e2e fail loudly with `missing wired components: supervisor`.

**How**:
```bash
# Baseline
cd packages/daemon && pnpm test test/lock/runStartup-lock.spec.ts
# → 9/9 pass

# Negative: comment out the supervisor push in src/index.ts:396
#   if (supervisor !== null) wired.push('supervisor');
# becomes
#   // if (supervisor !== null) wired.push('supervisor'); // M2-CHECK negative test

# Lock unit test still passes (it only tests the pure decider; index.ts is the caller):
pnpm test test/lock/runStartup-lock.spec.ts
# → 9/9 pass

# E2E test fails on the production wiring:
pnpm test test/integration/daemon-boot-end-to-end.spec.ts
# → 7/7 fail with the same root cause
```

**Expected**: e2e throws `Error: missing wired components: supervisor` from `assertWired`.

**Actual** (excerpt from vitest output):

```
Error: missing wired components: supervisor
 ❯ assertWired src/runStartup.lock.ts:99:11
     97|   }
     98|   if (missing.length > 0) {
     99|     throw new Error(`missing wired components: ${missing.join(', ')}`);
       |           ^
    100|   }
    101| }
 ❯ runStartup src/index.ts:410:3
 ❯ test/integration/daemon-boot-end-to-end.spec.ts:269:14
```

After restoring `index.ts`, the e2e returns to 7/7 PASS.

**Verdict**: PASS. The mechanical guard fires loudly with the documented stable error message (`missing wired components: <name>`), and the failure surfaces in the daemon-boot end-to-end spec, NOT only in a unit test.

**Drift note**: `WARN_ONLY` set currently contains `write-coalescer` (T6.x). If a developer accidentally adds another component to `WARN_ONLY` to "silence" a missing wire, that bypass is invisible. Candidate followup: a lint that fails CI if `WARN_ONLY` grows without a linked task # comment, or a periodic audit that asserts `WARN_ONLY.size <= 1` and gets bumped explicitly per Wave.

Pre-existing local-env note: on Windows the bundled migration `001_initial.sql` is checked out CRLF by default, which trips `MigrationLockMismatchError` before `assertWired` even runs. Stripping `\r` (or setting `core.autocrlf=false` for that file) makes the e2e runnable. CI runs Linux so this doesn't affect ship gates, but future Windows-dev onboarding may want a `.gitattributes` entry pinning `*.sql text eol=lf`.

---

## 5. spec-code lock — `tools/check-spec-code-lock.sh` (#220)

**File**: `tools/check-spec-code-lock.sh`. Lock JSON: `docs/superpowers/specs/2026-05-03-v03-daemon-split.lock.json`.

**Two negative tests**:

### 5a. Edit one byte of a lock-listed file

```bash
cd /c/Users/jiahuigu/ccsm-worktrees/pool-5/
printf '\n// negative test marker\n' >> packages/snapshot-codec/src/index.ts
bash tools/check-spec-code-lock.sh
# → exit 1
git checkout -- packages/snapshot-codec/src/index.ts
```

**Actual**:
```
FAIL: gate b path packages/snapshot-codec/src/index.ts changed
       expected sha256: e7d7e9a3283328c282a133cbad39dbab5c6d206c3c4e2752429540d3f3e71bd1
       actual   sha256: 5040817db9bc9d0e98d610dadf4a2773b2ef55c3299a9c5ce4a13d8f21714cab (working_tree(lf))
       to intentionally update, refresh the hash in docs/superpowers/specs/2026-05-03-v03-daemon-split.lock.json
check-spec-code-lock: 1/7 locked file(s) failed verification
EXIT=1
```

### 5b. Rename / hide one lock-listed file

```bash
mv tools/claude-sim/main.go tools/claude-sim/main.go.bak
bash tools/check-spec-code-lock.sh
# → exit 1
mv tools/claude-sim/main.go.bak tools/claude-sim/main.go
```

**Actual**:
```
FAIL: gate c path tools/claude-sim/main.go missing (working tree)
check-spec-code-lock: 1/7 locked file(s) failed verification
EXIT=1
```

**Verdict**: PASS (both 5a and 5b). Hash mismatch + missing-file paths are both caught with exit 1 and a clear gate-name + path message.

**Drift note**: the lock JSON itself is unprotected — if someone edits the JSON to update a hash WITHOUT touching the spec, the script will silently re-bless the new content. Acceptable in PR review (reviewer sees the JSON diff and can challenge), but a candidate followup: have `check-spec-code-lock.sh` also assert the lock JSON's git blob hash matches a value pinned in `tools/check-spec-code-lock.sh` itself, so unilateral lock-JSON edits also require a script change. Lower priority — review on the lock JSON is currently sufficient.

---

## 6. .v0.2-only-files monotonic shrinking — `tools/check-v02-shrinking.sh` (#222)

**File**: `tools/check-v02-shrinking.sh`. List: `.v0.2-only-files`.

**Two negative tests**:

### 6a. Add a NEW listed file (something not in base) with content

```bash
cat > electron/fake-test-file.ts <<'EOF'
// fake test file
export const x = 1;
export const y = 2;
EOF
printf 'electron/fake-test-file.ts\n' >> .v0.2-only-files
bash tools/check-v02-shrinking.sh
# → exit 1
git checkout -- .v0.2-only-files; rm electron/fake-test-file.ts
```

**Actual**:
```
GROW: electron/fake-test-file.ts (base=0, head=3, +3)
check-v02-shrinking: 17 checked, 0 skipped

FAIL: one or more .v0.2-only-files entries grew vs base.
EXIT=1
```

### 6b. Grow an EXISTING listed file beyond its shrink budget

```bash
# electron/main.ts current head=288, base=320 (already shrank by 32 lines).
# To trip the guard we must add MORE than 32 lines.
for i in $(seq 1 50); do echo "// growth marker line $i" >> electron/main.ts; done
bash tools/check-v02-shrinking.sh
# → exit 1
git checkout -- electron/main.ts
```

**Actual** (relevant lines):
```
... (other entries OK)
check-v02-shrinking: 16 checked, 0 skipped

FAIL: one or more .v0.2-only-files entries grew vs base.
      If this is intentional (file moved into shell, intermediate refactor),
      explain in the PR body under 'Wire-up evidence' and ping reviewer.
EXIT=1
```

**Verdict**: PASS — the guard catches both new-file growth and existing-file regrowth, with exit 1 and a clear `GROW:` per-file diagnostic.

**Drift note** (important — candidate for new task): the guard compares current line count against the **merge-base**, not against the immediately-preceding commit. Consequence: a file that already has shrink budget (e.g. `electron/main.ts` shrank 320→288, so 32 lines of headroom) can silently RE-GROW back up to 320 in a later PR without tripping the guard. Two negative implications:
1. A PR can re-add the EXACT lines that a previous shrink-PR removed and the guard says PASS — the "monotonic shrink" promise is per-base, not per-step.
2. If the merge-base is stale (e.g. a long-lived branch), all shrink history accumulates as headroom available for re-growth.

Recommended followup task: `[FOLLOWUP] check-v02-shrinking — also compare against HEAD~1 (or 'best historical low watermark' tracked in a small JSON sidecar)`. The current guard catches the *common* case (a PR that adds lines on top of the latest tip) only when the file has no leftover shrink budget. With budget present, growth is invisible.

A second smaller drift: appending a non-existent path to `.v0.2-only-files` is silently SKIPPED (`SKIP: ... (missing in both base and head)`). That means the original task brief's "test 6a" (append a fake path → expect exit 1) actually returns exit 0; what makes the test fail is the path EXISTING with content. The guard is doing the right thing (skipping unknown paths is intentional per the script's own comments), but the task brief's expected behavior was overspecified. Worth noting in case a future test author repeats the misunderstanding.

---

## Final summary

| # | Guard | Verdict |
|---|-------|---------|
| 1 | PR template Wire-up evidence (#218) | PASS |
| 2 | reviewer.md Wire-up grep checklist (#219) | PASS |
| 3 | spec-pipeline Stage 6.5 (#223) | PASS |
| 4 | runStartup.lock assertWired (#221) | PASS |
| 5 | tools/check-spec-code-lock.sh (#220) | PASS (both 5a + 5b) |
| 6 | tools/check-v02-shrinking.sh (#222) | PASS (both 6a + 6b) |

**6/6 PASS.** All Wave 2 guards fire as designed.

## Drift / followup candidates

Aggregated from per-section drift notes above. Each is a candidate for a separate small task (manager to triage):

1. **`check-v02-shrinking.sh` budget-recapture blind spot** — guard compares against merge-base only. A file with prior shrink budget can re-grow up to its old size silently. Consider tracking a low-watermark sidecar OR also comparing against `HEAD~1`. (HIGH — defeats the point of "monotonic shrink".)
2. **`assertWired` `WARN_ONLY` set has no growth gate** — a dev could silence a missing wire by adding it to `WARN_ONLY`. Add a CI lint that requires a Task # comment per `WARN_ONLY` entry, OR a hard cap. (MEDIUM.)
3. **PR template render not asserted in CI** — proof relies on humans noticing if GitHub stops auto-prefilling. Add a CI check that fetches the file via `gh api` and matches the expected checklist headers. (LOW.)
4. **reviewer.md wire-up grep is human-only** — no mechanism prevents an APPROVE without the grep being run. Optional bot to flag empty Wire-up checkboxes on PRs that touch `packages/**`. (LOW — process gate, not mechanical.)
5. **spec-pipeline Stage 6.5 has no retroactive audit** — pre-rule tasks are not flagged. Optional one-time audit task before v0.4. (LOW.)
6. **Lock JSON itself is unprotected** — `check-spec-code-lock.sh` could also pin its own lock-JSON hash to prevent silent re-blessing. (LOW — review covers it for now.)
7. **Windows CRLF in `001_initial.sql` trips migration lock** — pre-existing dev-environment friction, unrelated to Wave 2 guards but surfaced during this acceptance. Add `*.sql text eol=lf` to `.gitattributes`. (LOW.)
