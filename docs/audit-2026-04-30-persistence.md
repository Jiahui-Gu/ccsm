# Daily Audit D1: Persistence (memory / hook / cron) — 2026-04-30

## Summary

The persistence stack (50 memory files + 7 Python hooks + settings.json + 1 state file) is broadly coherent but shows **3 active contradictions**, **4 staleness defects** (including a dead file ref baked into a hook's user-facing error message), substantial **duplication around dispatch / e2e / reviewer rules**, and several **memory rules ripe for hook conversion** per `feedback_remember_might_be_hook.md`. No hook errors out — all 7 syntactically valid and tested. State file `pending-tasks.txt` clean. No noisy crons observed.

---

## HIGH (urgent)

### H1. Contradiction — autonomy mode disables AskUserQuestion vs "every clarifying question MUST go through it"
- `feedback_full_autonomy_until_list_empty.md:8`: *"零问题: 所有 AskUserQuestion 暂停"*
- `feedback_questions_via_askuserquestion.md:7-15`: *"every clarifying question … MUST go through AskUserQuestion … no plain-text questions"*
- `MEMORY.md:19` vs `:74` — both summaries appear two stanzas apart with no cross-ref.
- **Effect:** ambiguous handling for the 5 hard-trigger escalations during autonomy.
- **Action:** add explicit exception block to `feedback_questions_via_askuserquestion.md` for autonomy mode + group the three rules together in MEMORY.md.

### H2. Contradiction — "no local main repo" vs hook + memory references that still cite one
- `MEMORY.md:4`: *"**No local main repo** — operate exclusively via `~/ccsm-worktrees/pool-{1..10}`"*
- `bash-discipline.py:53` error msg references `feedback_reviewer_in_worktree.md` (does not exist; see H4)
- `feedback_dispatch_avoid_collisions.md:53,56-65`: still names `C:/Users/jiahuigu/ccsm-research/ccsm` as "main worktree"
- `feedback_reviewer_use_pr_worktree.md:7-29`: workflow assumes `~/ccsm-research/ccsm` exists
- **Verified on disk:** `~/ccsm-research/ccsm` does still exist as a dir
- **Action:** rewrite worker-setup blocks in `feedback_dispatch_avoid_collisions.md` (§5,6) and `feedback_reviewer_use_pr_worktree.md` to reference `~/ccsm-worktrees/pool-N` only; or mark superseded.

### H3. False rule — hot-file list points to deleted files
- `feedback_dispatch_avoid_collisions.md:27-34` lists hot files; **6/10 do not exist** on origin/working tip:
  - `src/components/chat/DiffView.tsx` (whole `src/components/chat/` dir absent)
  - `src/components/chat/blocks/ToolBlock.tsx`
  - `src/components/chat/blocks/AssistantBlock.tsx`
  - `src/components/PermissionPromptBlock.tsx`
  - `src/components/ChatStream.tsx`
  - `src/components/chat/renderBlock.tsx`
- Still real: i18n locales, electron/main.ts, src/stores/store.ts
- **Effect:** dispatch collision check is no-op for 6/10 entries.
- **Action:** regenerate via `git log --since=14.days --name-only origin/working | sort | uniq -c | sort -rn | head -20`.

### H4. Hook error message references a missing memory file
- `bash-discipline.py:53`: emits `(per feedback_reviewer_in_worktree.md / project_worker_pool.md)` — `feedback_reviewer_in_worktree.md` does NOT exist; closest match is `feedback_reviewer_use_pr_worktree.md`
- Same broken ref: `~/.claude/hooks/README.md:18,8`, `feedback_reviewer_reuses_worker_pool.md:24`
- **Action:** rename `feedback_reviewer_use_pr_worktree.md` → `feedback_reviewer_in_worktree.md` (preserves all refs in one move).

---

## MED (worth a sweep)

### M1. Duplication — dispatch immediately / discipline / follow-up overlap
- `feedback_dispatch_discipline.md` §5 vs `feedback_followup_dispatch_immediately.md` say the same thing twice.
- **Action:** merge `followup_dispatch_immediately.md` into `dispatch_discipline.md`; delete standalone; update MEMORY.md:65.

### M2. Reviewer rules now span 6 files
- `feedback_independent_reviewer.md`, `_two_layers.md`, `_self_merge.md`, `_use_pr_worktree.md`, `_reuses_worker_pool.md`, `_flags_ambiguous_requirements.md`
- `feedback_reviewer_self_merge.md:42-44` explicitly supersedes `_independent_reviewer.md`'s "manager never merges" rule — but the latter has no banner.
- **Action:** add `> **Superseded by feedback_reviewer_self_merge.md (2026-04-30) for the merge gate.**` banner to top of `feedback_independent_reviewer.md`. Consider consolidating to single `feedback_reviewer.md`.

### M3. e2e gate split across 4 files with shifting rules
- `feedback_e2e_before_merge.md` says reviewer spot-checks 1/5 PRs.
- `feedback_trust_ci_mode.md:46-48` supersedes that — reviewer does NOT run probes.
- **Action:** add banner to `feedback_e2e_before_merge.md:22-23`: *"⚠ Reviewer spot-check rule below SUPERSEDED by feedback_trust_ci_mode.md (2026-04-30)."*

### M4. Stale stat — "65 散 probe" claim
- `feedback_e2e_prefer_harness.md:14`: *"从 ~3 harness 涨到 65 独立 probe + 3 harness = 68 次 electron launch ≈ 30 分钟"*
- **Verified:** `ls scripts/probe-e2e-*.mjs | wc -l` = **0**. Consolidation Task #164 succeeded.
- **Action:** edit "Why" para to past tense: *"In 2026-04-26 we had 65 散 probe; consolidated by Task #164. Rule remains active to prevent re-fragmentation."*

### M5. Stale env — `MAX_THINKING_TOKENS=31999` in settings.json
- `~/.claude/settings.json:14,42`. Memory doesn't mention it. Worth verifying against current Opus 4.7 1M ceiling.
- **Action:** verify against current claude-code release notes; bump if stale.

### M6. Hook-candidate — TaskUpdate after Agent dispatch must happen same turn
- Currently soft `dispatch-track-prompt.py` reminder fires only on next UserPromptSubmit (next user message).
- **Hook-candidate:** add `Stop` hook checking `pending-tasks.txt` non-empty before turn ends.
- **Action:** create `~/.claude/hooks/dispatch-track-stop.py`. Start with strong `additionalContext` injection; only escalate to `exit 2` after a week of data.

### M7. Hook-candidate — Worker prompt first line `Task #NNN. <desc>`
- Already partially enforced by `dispatch-track-pre.py:23` (BLOCK on missing).
- **Action:** consider adding stderr WARN when first line lacks `Task #NNN` (currently silent on success). Low marginal value; skip unless drift returns.

### M8. Positive — `gh pr create --base working` `-B` alias handled in `bash-discipline.py:31` ✅

### M9. Skip — `#NNN` vs `Task #NNN` / `PR #NNN` lint
- `dispatch-track-pre.py` only scans first line; safe. Skip.

### M10. Duplication — task-list state suffixes repeated in 3 files
- `feedback_tasklist_conventions.md` (canonical), `feedback_dispatch_discipline.md` §2, `feedback_liveness_protocol.md`.
- **Action:** keep canonical; replace inline tables with one-line refs in the other two.

---

## LOW (cosmetic)

### L1. Tone mix — Chinese vs English vary file-to-file
- e.g. `feedback_independent_reviewer.md` (English) vs `feedback_reviewer_self_merge.md` (mixed) — same topic cluster.
- **Action:** optional pass to align reviewer cluster to one language.

### L2. Missing cross-refs
- `feedback_cron_quiet_output.md` should cross-ref `feedback_liveness_protocol.md` (it modifies output behavior).
- `MEMORY.md:49` — add "⚠ trust_ci_mode supersedes the reviewer step" annotation between `e2e_before_merge` and `trust_ci_mode`.

### L3. State file naming
- `~/.claude/hooks/README.md:73` — add typical operations `> ~/.claude/hooks/state/pending-tasks.txt` to clear.

### L4. Hook README test — fine ✅

### L5. `bash-discipline.py:15` ccsm-probe escape hatch
- All hooks share `if "ccsm-probe" in os.getcwd(): sys.exit(0)`. Documented in `feedback_agent_prompt_task_ref_format.md:22`.
- **Action:** fold into `~/.claude/hooks/README.md` "Failure modes" section.

---

## Hook health (item 5)

All 7 hooks pass `ast.parse`. Behavior smoke-tested:

| Hook | Status |
|---|---|
| `bash-discipline.py` | ✅ |
| `agent-model-enforce.py` | ✅ |
| `agent-prompt-clean-worktree.py` | ✅ |
| `dispatch-track-pre.py` | ✅ |
| `dispatch-track-post.py` | ✅ |
| `dispatch-track-prompt.py` | ✅ |
| `taskcreate-no-id-prefix.py` | ✅ |

`bash-discipline` fires on Bash invocations whose JSON payload contains literal `gh pr create` (false-positive rate tolerable).

## State file

`pending-tasks.txt`: only audit tasks #823-829 (created today). Clean.

## Cron noise (item 6)

CronList not accessed; based on memory analysis `feedback_cron_quiet_output.md` (4 days old) + `feedback_liveness_protocol.md` (13-min silent tick) look well-aligned.

---

## Top-3 actions

1. **Fix broken hook ref** — rename `feedback_reviewer_use_pr_worktree.md` → `feedback_reviewer_in_worktree.md` (one rename fixes hook + README + 2 memory cross-refs). [H4]
2. **Update hot-file list** in `feedback_dispatch_avoid_collisions.md:27-34` — remove 6 dead `src/components/chat/**` entries. [H3]
3. **Resolve autonomy/AskUserQuestion contradiction** by adding exception block to `feedback_questions_via_askuserquestion.md`. [H1]
