# Eval #849: Team agent mode for dev/reviewer dispatch

Status: read-only evaluation, no code change proposed in this PR.
Author: subagent under Task #849.
Target architecture: experimental agent teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`) with peer-to-peer `SendMessage` between teammates.

## TL;DR

| Question | Answer |
| --- | --- |
| Is team-mode usable for dev/reviewer? | Yes, the platform feature exists and is enabled in user settings; tooling (`TeamCreate` / `TeamDelete` / `SendMessage`) is permitted. Live spike was NOT runnable from the read-only evaluator subagent (see "Spike status" below) — needs a manager-context spike before flipping. |
| Does it actually save manager turns? | Marginally. ~1 turn per dev/reviewer pair under best case, but the **merge step** still has to come back to manager (GitHub same-identity self-approve block per `feedback_reviewer_self_merge.md`), so the savings are bounded to the "dev finishes -> reviewer launches" handoff turn. |
| Is the architecture cleaner if redesigned from scratch? | Mixed. Peer DM is conceptually nicer (producer/decider/sink alignment with `feedback_single_responsibility.md`), but the key manager safety nets (ground-task verification, hot-file collision check, post-merge backlog scan) are *only* enforceable at the manager-as-dispatcher chokepoint. Removing manager from the dev->reviewer path also removes those gates from the path. |
| Recommendation | **Hybrid: keep manager-mediated dispatch as the default; pilot team-mode only for dev<->fixer iteration loops (Layer-2 review changes requested -> worker fixes -> reviewer re-checks).** Do NOT migrate the dev->reviewer initial handoff. See section 4. |

## 1. Spike status (feasibility)

### 1.1 What the task asked for

Run a live spike in pool-4: `TeamCreate(team_name="eval-849-spike")`, dispatch a trivial dev (README append) and a reviewer pair via `Agent(team_name=..., name="dev"/"reviewer", subagent_type="general-purpose", model="opus")`, observe whether `SendMessage(to="reviewer", ...)` works, whether peer DMs surface to manager, whether team agents inherit the right model, and whether team agents can spawn nested children.

### 1.2 What actually happened

This evaluation is being authored from inside a **general-purpose subagent** dispatched by the project's manager. The tool surface available to a general-purpose subagent in this Claude Code build does NOT include `Agent`, `TeamCreate`, `TeamDelete`, or `SendMessage`. Those are **manager-only tools** in the current CLI, exactly as `feedback_reviewer_pr_url_in_prompt.md` already documented for `SendMessage`.

A read-only evaluator subagent therefore cannot drive the spike end-to-end. Running the spike requires the manager itself to issue the `TeamCreate` + paired-Agent calls. This finding is itself one of the most important answers for the eval: **the team-mode tooling is not exposed to subagents**, only to the top-level conversation. That has direct implications for nested teams (see 1.4).

### 1.3 What we DO know from non-spike evidence

- `~/.claude/settings.json` already sets `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (env block).
- `~/.claude/settings.json` `permissions.allow` already lists `TeamCreate(*)`, `TeamDelete(*)`, `SendMessage(*)`. So no permission gate would fire when the manager actually invokes them.
- `~/.claude/cache/changelog.md` (Claude Code release notes) confirms team agents and `SendMessage` are real, shipping features:
  - `2.1.117` fix note: "subagents resumed via `SendMessage` not restoring the explicit `cwd` they were spawned with"
  - earlier note: "Fixed a crash in the permission dialog when an agent teams teammate requested tool permission"
  - earlier note: "Fixed agent team members not inheriting the leader's permission mode when using `--dangerously-skip-permissions`"
  - earlier note: "Fixed inbound channel notifications being silently dropped after the first message for Team/Enterprise users"
  - `/team-onboarding` slash command was added.
- Memory `feedback_reviewer_pr_url_in_prompt.md` notes the previous (now-rescinded) memory `feedback_dev_reviewer_paired_dispatch.md` had a "team agent (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1) mode, not applicable to general-purpose subagent" carve-out — i.e. the team-mode handoff between teammates IS the published behavior, and was tried before.

### 1.4 Open questions the live spike must still answer (before any migration)

These cannot be answered from docs/changelog alone; manager must run them:

a. Does `SendMessage(to="reviewer", body="PR ready: <url>")` from a teammate (not from manager) actually deliver to the named teammate, and does the recipient get the message in their input as a system event?

b. Are inter-teammate DMs visible to the manager (e.g. as a transcript notification, idle summary, or just hidden)? The dispatch-discipline regime in `feedback_dispatch_discipline.md` assumes manager has read-through visibility into worker state machine; if peer DMs are invisible, manager loses the ability to see "reviewer has the PR URL but hasn't acked yet" mid-flight.

c. Does `Agent(team_name=..., name=..., subagent_type="general-purpose", model="opus")` actually pin the model to opus, or does the team subsystem override it back to sonnet? (Hook `agent-model-enforce.py` blocks model != "opus" on `Agent` calls — but only if the hook still receives a `tool_input.model` field for the `Agent` tool when team_name is present. See section 3.)

d. Can a team-mode reviewer itself dispatch a fixer (i.e. nested teams)? Per 1.2, `Agent` is manager-only for general-purpose subagents — does adding to a team unlock it? The published feature title is "agent teams", which suggests yes, but no public doc was found in the on-disk plugin marketplaces.

## 2. Workflow comparison: current vs. team-mode

### 2.1 Current (manager-mediated) flow

| Step | Actor | Manager turn cost |
| --- | --- | --- |
| 1. Dispatch dev (`Agent`, `run_in_background=true`) | manager | 1 (shared with other dispatches in same turn) |
| 2. Dev runs in background; mtime-tracked liveness cron ticks every 13 min | dev (subagent) | 0 |
| 3. Dev finishes; `task-notification` lands in manager | manager (passive) | 0 |
| 4. Manager reads dev report, extracts PR URL, runs `gh pr checks <NN>` | manager | 1 (shared turn) |
| 5. Manager dispatches reviewer (`Agent`, same pool-N, PR URL in prompt) | manager | 0 (same as step 4) |
| 6. Reviewer runs; emits `gh pr review --comment` "APPROVE: ..." + ack to manager | reviewer (subagent) | 0 |
| 7. Manager reads reviewer ack, runs `gh pr checks <NN>`, `gh pr merge --squash --delete-branch` | manager | 1 |
| 8. Manager runs post-merge backlog scan in same turn | manager | 0 (same as 7) |

**Manager turn count: 3** (step 1, step 4+5, step 7+8). All manager visibility is preserved (manager sees dev report, runs CI checks, sees reviewer comment, runs merge).

### 2.2 Team-mode flow (hypothesized — still depends on spike answers)

| Step | Actor | Manager turn cost |
| --- | --- | --- |
| 1. Manager `TeamCreate("pr-NNN")` + dispatches dev + reviewer as teammates in same turn | manager | 1 |
| 2. Dev runs; on completion, `SendMessage("reviewer", "PR ready: <url>")` | dev (teammate) | 0 |
| 3. Reviewer receives DM, runs `gh pr checkout`, reviews | reviewer (teammate) | 0 |
| 4. Reviewer `gh pr review --comment` APPROVE + `SendMessage("manager", "APPROVE, CI green, ready to merge")` | reviewer (teammate) | 0 |
| 5. Manager reads message, `gh pr checks` + `gh pr merge --squash --delete-branch` + post-merge backlog scan + `TeamDelete` | manager | 1 |

**Manager turn count: 2.** Net savings: **1 manager turn per dev/reviewer pair.** Plus the synchronization win that reviewer launch is automatic the moment dev finishes (no waiting for the next manager turn that gets the `task-notification`).

### 2.3 What's lost in team-mode

These are real costs, not speculation — every one is currently encoded in a memory rule that exists because we got bitten:

- **Hot-file collision check (`feedback_dispatch_avoid_collisions.md` rule 0)**: The rule is "before EVERY dispatch (parallel or sequential), explicitly list in-flight workers' file footprints + check overlap." In team-mode, dev->reviewer launch is automatic (peer DM triggers reviewer in pool-N immediately). Manager doesn't get a checkpoint to verify pool-N is still the right pool, or to verify another dev hasn't been dispatched into pool-N in the meantime. Mitigation: reviewer always reuses the dev's own pool (which is what `feedback_reviewer_reuses_worker_pool.md` says anyway), and reviewer itself doesn't touch hot files. Risk is low.

- **Ground-task-before-dispatch (`feedback_ground_task_before_dispatch.md`)**: This is a manager-side grep check before dispatching ANY worker. In team-mode it still applies for the *initial* dev dispatch (manager still issues that). Reviewer dispatch already operates on the dev's actual diff, which is a strictly better grounding signal than the original task description, so no loss here.

- **Manager `gh pr checks` between dev finish and reviewer launch**: in current mode, manager runs CI snapshot before dispatching reviewer (per `feedback_reviewer_pr_url_in_prompt.md`). In team-mode, the dev->reviewer SendMessage happens with no manager pause. CI may not even have started yet when reviewer launches. Reviewer would then have to handle "wait for CI" itself (which it already does per `feedback_trust_ci_mode.md` HARD CONSTRAINT — reviewer must `gh pr checks` and not `--auto` merge). So this is **already covered**, the loss is minor.

- **Mid-flight visibility (the big one)**: `feedback_dispatch_discipline.md` assumes manager has a real-time mental model of {task -> dispatched/in_progress/blocked, owning agent, pool-N}. If peer DMs are invisible to manager (open question 1.4.b), manager can no longer answer "is reviewer waiting for CI or stuck?" without polling. The 13-min liveness cron (`feedback_liveness_protocol.md`) catches dead agents but can't distinguish "alive and politely waiting for CI" from "alive but doing nothing useful." This is a **real architectural regression** if peer DMs are not surfaced.

- **Reviewer self-merge still blocked**: `feedback_reviewer_self_merge.md` documents the reason reviewer can't `gh pr merge --admin` — it bypasses GitHub's PR approval gate by abusing the admin escape hatch. This constraint is identity-based (Jiahui-Gu identity is shared by both worker and reviewer), and team-mode does NOT change identity. Therefore the **merge step still must come back to manager**. Team-mode cannot save the merge round trip, only the review-handoff round trip.

### 2.4 Real savings, accounting honestly

- Per dev/reviewer pair in team-mode: 2 manager turns instead of 3 (saves 1).
- Risk of losing mid-flight visibility (open Q 1.4.b) could force adding manual polling cycles, which would *eat* the saved turn.
- Net per pair: 0.5-1 manager turn saved, with a non-trivial visibility risk.
- Across a typical day (~3-5 PR pairs): 1.5-5 turns saved. Useful but not transformative.

## 3. Migration cost

### 3.1 Affected memory files

Grep for `general-purpose|reviewer|manager|subagent_type|SendMessage|TeamCreate` over `~/.claude/projects/C--Users-jiahuigu/memory/` returned 33 files; the load-bearing ones for this evaluation:

**Must update (semantics change in team-mode):**

1. `feedback_reviewer_pr_url_in_prompt.md` — current rule "subagent doesn't have SendMessage, so dev->reviewer must go via manager" becomes false in team-mode. Replace with "for team-mode pairs, dev SendMessages reviewer with PR URL; for general-purpose dispatches, manager still ferries the URL."

2. `feedback_subagent_workflow.md` — "subagent reports back to manager" becomes "teammate may report back to manager OR to peer." Add team-mode branch.

3. `feedback_reviewer_reuses_worker_pool.md` — still holds; team-mode doesn't change pool reuse, but the dispatching actor changes from "manager picks pool-N for reviewer" to "reviewer is told its pool at TeamCreate time." Minor wording.

4. `feedback_independent_reviewer.md` — central "spawn a SEPARATE reviewer subagent" rule still holds. Team-mode just changes how the spawn is wired (teammate vs. fresh subagent). Memory currently says "If REQUEST CHANGES → manager sends the feedback to the original worker subagent (via SendMessage) to revise" — this is the **fixer iteration loop** that team-mode is best suited for (see 4.2).

5. `feedback_reviewer_self_merge.md` — UNCHANGED. Identity constraint is independent of dispatch mode.

6. `feedback_dispatch_discipline.md` — needs a new "team-mode dispatch state machine" section: TeamCreate is its own state, peer DM transitions are not visible in TaskList, must reflect via reviewer-back-to-manager ack.

7. `feedback_subagent_model_opus_1m.md` — still holds, but verify (open Q 1.4.c) that `model="opus"` propagates through `Agent(team_name=..., model="opus")`. If the team subsystem strips the model field, this rule needs a hook fix not just a memory update.

8. `feedback_reviewer_two_layers.md` — UNCHANGED. Layer 1/2 framing is mode-independent.

9. `feedback_reviewer_flags_ambiguous_requirements.md` — slight update: "flag to manager" can become "flag to manager via SendMessage" in team-mode (already does).

**Likely no change:**

- `feedback_ground_task_before_dispatch.md` (manager-side check before initial dispatch)
- `feedback_dispatch_avoid_collisions.md` (manager-side hot-file mental model)
- `feedback_trust_ci_mode.md` (CI rollup is mode-independent)
- `feedback_evaluation_before_implementation.md`, `feedback_one_bug_one_worker.md`, `feedback_split_large_worker_tasks.md`, etc. (task-shape rules, mode-independent)
- `project_worker_pool.md` (pool model unchanged)

**Memory net delta**: ~7 files need updates, mostly small wording. No memory needs deletion. No new memory file needs creation if migration is partial.

### 3.2 Hook impact

Each hook is a `tool_name == "Agent"` (or `TaskCreate` / `TaskUpdate`) PreToolUse / PostToolUse matcher. Team-mode dispatches are still `Agent` calls — the docs note `Agent(team_name=..., name=..., subagent_type=..., model="opus")` pattern. Therefore the **hook matcher itself still fires.** What changes is what `tool_input` contains.

| Hook | Triggers on | Team-mode risk |
| --- | --- | --- |
| `agent-model-enforce.py` | Pre `Agent` | **Verify**: hook reads `tool_input.model` and blocks != "opus". If team-mode `Agent` calls expose `model` normally, no change. If team subsystem nests model differently (e.g. inside a `team_member` block), hook may need an updated path. **Open Q 1.4.c for spike.** |
| `dispatch-track-pre.py` | Pre `Agent` | Reads `tool_input.prompt` first line for `Task #NNN`. Team-mode prompts can still embed `Task #NNN` — no change needed. May want to also record `team_name` for tracking. |
| `agent-prompt-clean-worktree.py` | Pre `Agent` | Reads `tool_input.prompt` for `git reset --hard` + `git clean -fd` discipline. Team-mode worker prompts should still include the same setup, so no change. Reviewer teammate prompts skip reset, also no change (existing skip rule applies). |
| `dev-needs-reviewer-pre.py` | Pre `Agent` | Reads prompt for DEV_SIGNALS, marks unpaired-dev state. In team-mode, dev + reviewer are dispatched in the SAME `TeamCreate` turn, so the unpaired-dev nag would auto-clear (the reviewer-like agent in same turn clears state). No change needed; arguably the hook is more accurate in team-mode. |
| `cron-lifecycle-on-dispatch.py` | Post `Agent`, when `run_in_background` | Reminds manager to ensure liveness cron is alive. Team-mode background dispatches still trigger this. No change. |
| `build-launch-reminder-pre.py` | Pre `Agent` | Detects build verbs. No change. |
| `taskcreate-id-discipline.py` | Pre/Post `TaskCreate` | Mode-independent. |
| `dispatch-track-post.py` | Post `TaskUpdate` | Mode-independent. |

**Hook net delta**: 0 hook code changes if open Q 1.4.c (model field propagation) confirms `tool_input.model` shows up normally. Possibly 1 hook tweak if not.

There is no hook today that fires on `TeamCreate` / `TeamDelete` / `SendMessage`. If team-mode is adopted, we may want to add a hook on `TeamDelete` that nags "did you `gh pr merge` and run post-merge backlog scan before deleting the team?" — analogous to `cron-lifecycle-on-task-close.py`.

### 3.3 Estimated migration effort

- Spike (manager runs steps from 1.4): ~30 min.
- Memory rewrites (7 files, small edits): ~45 min single subagent.
- Hook tweak (only if open Q 1.4.c fails): ~30 min.
- Smoke test on 1-2 real PRs: 1 dispatch cycle each.
- **Total**: 2-3 hours wallclock if everything goes well.

## 4. Recommendation (sunk-cost-free, per `feedback_no_sunk_cost.md`)

### 4.1 If we were starting from scratch today

Team-mode is conceptually nicer for the **stable producer-decider-sink shape**:
- producer = dev (produces a PR)
- decider = reviewer (decides APPROVE / REQUEST_CHANGES)
- sink = manager merge

`feedback_single_responsibility.md` aligns with that: each role does one thing. Team-mode lets the producer hand directly to the decider without an extra hop through a fourth party (manager). That is mechanically purer.

But two real-world constraints break the purity:

1. **GitHub same-identity self-approve block** forces the merge step back to manager. The "sink" role cannot be a teammate. So team-mode shrinks the loop from {manager, dev, reviewer, manager-merge} to {manager-dispatch, dev, reviewer, manager-merge} — manager is still on both ends.

2. **Manager dispatch-time gates** (ground-task verification, hot-file collision check, pool tracking) are inherently centralized — they need a single decision-maker who sees all in-flight work. Distributing reviewer launch to "as soon as dev finishes, regardless of what else manager is juggling" weakens that gate. The gate exists because we got bitten (#520 ghost-symbol, #553 cross-PR file leak, #250 collision storms).

A truly clean redesign from scratch would either:
- (a) keep manager-mediated dispatch (current mode), lose 1 turn per pair, keep all gates intact; OR
- (b) move all the manager gates into hooks that fire on team peer events too (e.g. a hook on `SendMessage` that runs the hot-file check before forwarding the DM), which is a much larger investment than just flipping the mode.

Option (a) is the lower-risk, currently-correct answer for ccsm scale (5-10 PRs/day, 1 manager).

### 4.2 The hybrid worth piloting

Team-mode is **clearly correct** for the **fixer iteration loop**, which is the exact scenario `feedback_independent_reviewer.md` invokes `SendMessage` for today: reviewer says REQUEST_CHANGES, manager forwards bullets to original dev, dev fixes, reviewer re-checks. That loop:
- has no hot-file collision risk (it's the same dev touching the same diff)
- has no fresh ground-task verification (already verified in initial dispatch)
- has no new pool assignment (same pool throughout)
- is a tight inner loop where every saved manager turn matters
- benefits from peer DMs because manager's role is purely passive (just gating the eventual merge)

**Concrete pilot**: keep current dev->reviewer flow as-is. When reviewer hits REQUEST_CHANGES, instead of "reviewer reports to manager who forwards to dev," create a 2-person team via `TeamCreate("fix-NNN")` containing dev + reviewer. Reviewer SendMessages REQUEST_CHANGES bullets directly to dev; dev fixes + pushes; dev SendMessages "ready" to reviewer; reviewer re-checks; on APPROVE, reviewer SendMessages manager. Manager merges. Tear down team.

This pilot:
- Saves the 1-2 manager turns per fix iteration (typical iterations: 1-3 cycles per "imperfect first PR").
- Doesn't compromise dispatch-time gates (those fired on the original dev dispatch).
- Doesn't depend on uncertain answers to open questions about model propagation or peer DM visibility — even if peer DMs are invisible to manager, the fixer loop is small enough that occasional polling is fine.
- Is reversible (delete the team, revert to manager-ferry).

**If pilot succeeds for 2 weeks** (no missed REQUEST_CHANGES, no stuck fixer loops, no model-propagation incidents): consider extending to dev->reviewer initial handoff. Until then, **don't touch the initial handoff.**

### 4.3 Decision

- **Default mode: keep manager-mediated dispatch as-is.** No changes to `feedback_reviewer_pr_url_in_prompt.md` or related rules.
- **Pilot mode: team-mode for fixer iteration loops only.** Define after the spike answers open Q 1.4.a-d.
- **Spike must be run by manager** (read-only evaluator subagent cannot, see 1.2). One spike PR, ~30 min.

## 5. Open questions for manager (max 3)

These need a human (you) decision because they trade off direction, not implementation:

**Q1.** Spike priority: should we run the live spike (1.4.a-d) right now to unblock the fixer-loop pilot, or queue it after current TaskList is cleared? My read: spike is small (~30 min), low-risk, and unblocks a recurring iteration cost. Recommend: run after current dispatch round finishes naturally.

**Q2.** Manager merge gate (per `feedback_reviewer_self_merge.md`): keep it permanently, or revisit once a second `gh` identity is set up (bot account)? My read: setting up a bot identity unlocks reviewer self-merge AND removes the merge-turn cost AND simplifies team-mode further. But user has previously declined creating a bot account. If that decision still stands, the merge gate is permanent and team-mode's ceiling is "saves 1 dev->reviewer handoff turn, never the merge turn."

**Q3.** Visibility tradeoff: if open Q 1.4.b confirms peer DMs are invisible to manager, do we (a) accept the loss for the fixer-loop pilot only (where loops are short), (b) require reviewer to CC manager on every peer DM (turns the savings back to ~zero), or (c) push for a hook on `SendMessage` that mirrors traffic to manager state? Recommend (a) for now, revisit if pilot reveals stuck loops.

## 6. Appendix: spike protocol (for whoever runs it)

Single manager turn:

```text
1. cd C:/Users/jiahuigu/ccsm-worktrees/pool-4
2. TeamCreate(team_name="eval-849-spike",
              description="probe team agent dev/reviewer SendMessage")
3. Agent(team_name="eval-849-spike", name="dev",
         subagent_type="general-purpose", model="opus",
         run_in_background=true,
         prompt="""
   Spike Task #849 (eval-only, no PR).
   1. Append 'spike-849' to /tmp/eval-849-probe.txt (do NOT modify any tracked file).
   2. SendMessage(to="reviewer",
        body="dev: probe complete, fake PR path /tmp/eval-849-probe.txt").
   3. Then exit.
   """)
4. Agent(team_name="eval-849-spike", name="reviewer",
         subagent_type="general-purpose", model="opus",
         run_in_background=true,
         prompt="""
   Spike Task #849 reviewer.
   1. Wait for an inbound SendMessage from teammate "dev".
   2. When received, read the body, log to /tmp/eval-849-probe-reviewer.txt
      'reviewer: received <body>'.
   3. SendMessage(to="<manager-name>",
        body="reviewer: review APPROVE, body was: <body>").
   4. Try Agent(subagent_type="general-purpose", model="opus",
        prompt="echo nested probe") to test nested dispatch.
      Log result to /tmp/eval-849-probe-nested.txt.
   5. Exit.
   """)
5. After both agents finish, inspect:
   - /tmp/eval-849-probe.txt           -> dev wrote
   - /tmp/eval-849-probe-reviewer.txt  -> reviewer received DM body
   - /tmp/eval-849-probe-nested.txt    -> nested dispatch worked or rejected
   - manager transcript -> did manager see the peer DM body, or only the
     final reviewer ack?
6. TeamDelete(team_name="eval-849-spike")
7. rm /tmp/eval-849-probe*.txt
```

Record findings against open Q 1.4.a-d. If all four pass cleanly (peer DMs work, model propagates, manager has visibility, nested works) -> proceed to fixer-loop pilot. If 1.4.b fails (no manager visibility) -> still pilot fixer-loop only, do not extend. If 1.4.c fails (model stripped) -> add a hook fix to `agent-model-enforce.py` first, then pilot.
