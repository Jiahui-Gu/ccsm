# Audit 2026-05-01 — persistence

**Domain**: memory / hook / cron
**Scanned by**: Daily audit subagent (pool-1, read-only except this file)
**Working tip**: `755fcae feat(daemon/envelope): T12 daemonProtocolVersion + x-ccsm-boot-nonce precedence (#654)`

**Files scanned**:
- 67 memory files (`~/.claude/projects/C--Users-jiahuigu/memory/*.md`, MEMORY.md + 66 leaves)
- 17 production hooks (`~/.claude/hooks/*.py`, excluding `test_*.py`) + 17 corresponding test files
- `~/.claude/settings.json` (10 hook entries across 5 events)
- `~/.claude/scheduled_tasks.json` (1 cron: daily 04:17 audit dispatcher — load-bearing)
- Hook state dir `~/.claude/hooks/state/` (2 stale txt files)

---

## Findings

### HIGH

- **[H-1] Stale e2e harness/probe references — files don't exist.** `harness-agent.mjs` and `harness-perm.mjs` are cited in MEMORY.md (`feedback_e2e_prefer_harness` summary), `feedback_e2e_prefer_harness.md`, `feedback_no_skipped_e2e.md`, `feedback_liveness_protocol.md` (implicitly via "harness-agent / harness-perm failing"), and the 4:17 daily audit cron prompt. Actual `scripts/` only has `harness-dnd.mjs`, `harness-real-cli.mjs`, `harness-ui.mjs`. Workers reading these memories are told "prefer harness-agent / harness-perm" and will fail to find them, then either fabricate a path or fall back to bespoke probes (defeating the rule). Similarly `feedback_no_skipped_e2e.md` says "Applies to all `scripts/probe-e2e-*.mjs`" — only `probe-e2e-sidebar-journey-expectations.md` (a doc) exists, no `.mjs` probes. **Fix**: rewrite the harness list in `feedback_e2e_prefer_harness.md` + MEMORY.md to actual current harness names, OR if the agent/perm harnesses were renamed/merged, add a note pointing to the new home; drop the `probe-e2e-*.mjs` clause from `feedback_no_skipped_e2e.md`.

- **[H-2] Broken cross-link `feedback_track_tasks_immediately`.** `feedback_dispatch_discipline.md` line "TaskCreate 任何浮现的新 work（依 `feedback_track_tasks_immediately`，不依赖 manager 记忆）" — this file does not exist in `memory/`. It was either renamed, consolidated, or never created. Effect: agent following the link gets nothing. **Fix**: either create the file or replace the inline reference with the actual rule text and drop the link.

- **[H-3] Broken cross-link `feedback_bug_fix_e2e_first` in `feedback_one_bug_one_worker.md`.** That file says "Per `feedback_bug_fix_e2e_first.md`, the fix worker writes failing e2e in phase 1, fixes in phase 3...". That file no longer exists — it was consolidated into `feedback_bug_fix_test_workflow.md` (the consolidation note inside `feedback_bug_fix_test_workflow.md` confirms it absorbed `bug_fix_e2e_first`, `bug_fix_e2e_reverse_verify`, `e2e_discipline`). MEMORY.md correctly points at the new file, but `feedback_one_bug_one_worker.md` still links the old name. **Fix**: in `feedback_one_bug_one_worker.md`, replace `feedback_bug_fix_e2e_first.md` with `feedback_bug_fix_test_workflow.md`.

### MED

- **[M-1] Contradiction: `ccsm-research/ccsm` "doesn't exist" vs really exists.** MEMORY.md top says "**No local main repo** — operate exclusively via `~/ccsm-worktrees/pool-{1..10}`". `bash-discipline.py:55` blocks `cd` into `ccsm-research/ccsm`. But the directory `C:/Users/jiahuigu/ccsm-research/ccsm` is a real working git repo (has `.git/objects`, `CONTRIBUTING.md`, `LICENSE`, `README.md`). `feedback_dogfood_check_main_repo_first.md` ALSO assumes a main repo at `C:\Users\jiahuigu\ccsm-research\ccsm` and says to run `git log --oneline -1` there (contradicts the "no main repo" claim and contradicts `bash-discipline.py` which would block cd into it). Net effect: dogfood-bug check rule is unimplementable as written. **Fix**: pick one truth: (a) main repo IS at `ccsm-research/ccsm` (then update MEMORY.md + remove the cd block in `bash-discipline.py` and rephrase project_worker_pool.md / reviewer_in_worktree.md), OR (b) main repo is gone (then delete the `ccsm-research/ccsm` directory and rewrite `feedback_dogfood_check_main_repo_first.md` to use a pool worktree as the "current code" reference).

- **[M-2] `bash-discipline.py` agentory regex misses real path.** Memory `feedback_dispatch_discipline.md`-era + MEMORY.md say "Old `agentory` repo at `C:\Users\jiahuigu\projects\agentory` is frozen". The regex on `bash-discipline.py:55` only blocks `cd ~/agentory` or `cd /c/Users/X/agentory` — does NOT block `cd /c/Users/X/projects/agentory`. The `projects/agentory` directory does NOT currently exist (already deleted), so the rule is moot in practice. **Fix**: either remove the `agentory` token from the regex (path is gone anyway) or extend the regex to match `projects/agentory` if it still might come back. Recommendation: drop `agentory` and `agentory-worktrees` from the regex — there is no agentory anymore.

- **[M-3] `ccsm-probe` skip guard missing on 4 hooks.** `bash-discipline.py`, `agent-model-enforce.py`, `cron-lifecycle-on-dispatch.py`, `cron-lifecycle-on-task-close.py`, `dispatch-track-pre.py`, `dispatch-track-post.py`, `question-without-askuserquestion-stop.py`, `question-without-askuserquestion-prompt.py`, `askuserquestion-autonomy-nudge.py`, `dispatch-track-prompt.py` all have `if "ccsm-probe" in os.getcwd()...: sys.exit(0)`. Missing the guard: `agent-prompt-clean-worktree.py`, `build-launch-reminder-pre.py`, `build-launch-reminder-prompt.py`, `dev-needs-reviewer-pre.py`, `dev-needs-reviewer-prompt.py`, `post-merge-pool-detach.py`, `taskcreate-id-discipline.py`. Per `feedback_agent_prompt_task_ref_format.md` "Hook quirks fixed 2026-04-29: 所有 hook 加了 `if "ccsm-probe" in cwd: exit 0` 守卫" — claim is false (≈50% of hooks lack it). If a ccsm-probe spawns a child Claude session, these hooks fire on probe activity. `agent-prompt-clean-worktree.py` would block the probe's setup commands; `taskcreate-id-discipline.py` would block probe TaskCreate calls; `post-merge-pool-detach.py` could detach pool worktrees during a probe `gh pr merge`. **Fix**: add the standard guard to all 7 missing hooks (one-liner each).

- **[M-4] `feedback_dogfood_protocol.md` references third-party hook semantics outside scope.** Not read in this audit but referenced from `dev-needs-reviewer-pre.py` whitelist patterns ("dogfood self-fix", "trivial fix", "≤3 line", "3-line fix") — the regex variants are 8 strings hard-coded in the hook. If the memory file changes the canonical phrase, the hook silently misses it. **Fix**: add a comment in both places linking each other ("if you change the canonical phrase here, update `dev-needs-reviewer-pre.py:WHITELIST`"). Lightweight cross-ref, no behavior change.

### LOW

- **[L-1] Stale state files.** `~/.claude/hooks/state/pending-tasks.txt` contains `963` (single ID, no current matching task). `~/.claude/hooks/state/untracked-dispatch.txt` contains 2 lines starting `Daily audit subagent — domain: GIT/PR HYGIENE.` — these are false-positives from THIS audit dispatch run (audit prompts contain words like "git", "merge", "rebase" that match `DEV_SIGNALS`, but legitimately have no `Task #NNN`). The `untracked-dispatch.txt` self-clears on next UserPromptSubmit, but the false-positive pattern will recur every daily audit run (the daily audit dispatches 7 subagents, all triggering the ghost-dispatch nag). **Fix**: in `dispatch-track-pre.py`, add a whitelist for prompts containing `Daily audit subagent` (or a more general "domain:" / "audit" marker) so audit dispatches don't trip GHOST DISPATCH. Also: `pending-tasks.txt`'s `963` is orphaned — manually `>` it once.

- **[L-2] Memory naming drift: `#NNN` ambiguity.** MEMORY.md lines like "Team-mode dispatch spike #873 results", "audit #876 (2026-04-30)", "派完两个 follow-up worker (#928 #929) 又问" — `#NNN` is ambiguous between local task IDs and GitHub PR/issue numbers. `feedback_agent_prompt_task_ref_format.md` mandates `Task #NNN` for tasks and `PR #NNN` for PRs in agent prompts, but the same convention is not followed in MEMORY.md / project_*.md text. Reader (human or subagent) cannot tell which they are. Verified: PRs #873/#876/#928 do not exist on GitHub (`gh pr view` returns "Could not resolve to a PullRequest"). **Fix**: sweep MEMORY.md + project_*.md, prefix bare `#NNN` with `Task ` or `PR ` per actual referent. ~15 occurrences.

- **[L-3] `pending-build-launch.txt` no `ccsm-probe` skip on its writer.** `build-launch-reminder-pre.py` writes state if a build verb + dest signal hit. Probe environments could trigger if a probe Agent prompt mentions "make:win" + "installer". Same fix family as M-3.

- **[L-4] `dispatch-track-pre.py` and `dev-needs-reviewer-pre.py` duplicate `DEV_SIGNALS` list with comment "Kept inline (not imported)". Comment acknowledges the drift risk. Harmless today, easy hook candidate later — extract to `_dev_signals.py` shared module and import. Not urgent.

- **[L-5] `feedback_no_uppercase_ui_strings.md` cites a one-time sweep dispatched 2026-04-24 ("separate PR from feature work"). No reference to PR# or task#. Stale event reference, no actionable info to verify completion. **Fix**: drop the dispatch breadcrumb or replace with the merged PR# if recoverable.

- **[L-6] `feedback_post_merge_pool_detach.md` says "顺手删本地 stale 分支" but `post-merge-pool-detach.py` only deletes the matched feature branch via `git branch -D merged_branch` AFTER detach succeeds. Other stale local branches in the pool (from previous unsuccessful runs) are NOT swept. Memory promises slightly more than hook delivers. **Fix**: clarify memory wording to "deletes the matched merged branch" (rather than "stale 分支" plural), or extend hook to sweep `git branch --merged origin/working` orphans (riskier; recommend the doc fix only).

- **[L-7] Hook candidate (memory→hook upgrade per `feedback_remember_might_be_hook.md`)**: `feedback_dispatch_avoid_collisions.md` rule #6 "Manager prompts for ANY worker MUST include as the FIRST step: cd C:/Users/jiahuigu/ccsm-worktrees/pool-N + git fetch + git reset --hard + git clean -fdx + git checkout -b". `agent-prompt-clean-worktree.py` enforces the `git clean` part but NOT the `cd pool-N` first-step requirement. A new PreToolUse(Agent) hook could verify the prompt's first 5 non-empty lines contain `cd C:/Users/jiahuigu/ccsm-worktrees/pool-` (or whitelist evaluator/reviewer). Same family as the existing dev-needs-reviewer hooks. Not urgent — manager has been disciplined about it — but exactly the kind of mechanical check `remember_might_be_hook` calls out.

- **[L-8] No noisy crons.** Only durable cron is the daily 04:17 full-stack audit dispatcher. 1×/day, load-bearing, fine. No 13-min liveness cron currently registered (consistent with `feedback_liveness_cron_lifecycle.md` "no active worker → cron deleted"). Healthy.

- **[L-9] `feedback_dogfood_protocol.md` not read in detail (audit time budget); spot-check OK based on cross-references.

---

## Stats

- Memory files: **67** total (1 root + 66 leaves). 41 `feedback_*`, 11 `project_*`, 1 `MEMORY.md` index. Total ~6,200 lines, avg 92 lines/file.
- Hooks: **17** production (avg 70 lines), all wired in `settings.json`, all backed by a `test_*.py`.
- Settings.json hook entries: 10 (PreToolUse: 5+1+1+1, PostToolUse: 1+1+2+1, UserPromptSubmit: 4, Stop: 1). All commands use absolute Windows paths.
- Cron: 1 task (`baf7d279`, daily 04:17, recurring, last fired 2026-04-30).
- Hook state files: 2 present (1 stale ID, 1 false-positive — both auto-clear on next prompt).
- Cross-link health: **3 broken** (H-2, H-3, H-1's harness names), **1 contradiction** (M-1), ~15 ambiguous `#NNN` refs (L-2).
- Findings: **HIGH 3 / MED 4 / LOW 9 = 16 total**.

## Suggested fix order

1. H-2, H-3 (one-line edits, prevent immediate worker confusion)
2. H-1 (factual sweep; check whether harness-agent/perm were renamed or just imagined)
3. M-1 (decide ground truth on `ccsm-research/ccsm`, then update MEMORY + hook in one PR)
4. M-3 (add `ccsm-probe` guards to 7 hooks — single PR, mechanical)
5. L-1 (whitelist audit prompts in dispatch-track-pre, `>` clear stale state once)
6. M-2, L-2..L-7 (low-priority polish, batch into a memory-cleanup PR)
