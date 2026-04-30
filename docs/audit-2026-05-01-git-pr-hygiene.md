# Audit Report — Git/PR Hygiene — 2026-05-01

## Summary

| Severity | Item | Count |
|---|---|---|
| HIGH | Worktree sprawl beyond pool-N (legacy single-use trees) | ~50 |
| HIGH | Local-only branches not on origin (shared `.git`) | 326 |
| HIGH | Residual stashes in shared object DB | 32 |
| MED  | Unmerged remote branches >7d old | 100 |
| MED  | Pool worktrees with detached HEAD | 4 (pool-2, 4, 5; plus 4 others) |
| LOW  | Stale remote branches >30d unmerged | 0 |
| LOW  | Open PRs >7d no activity | 0 (no open PRs) |
| LOW  | Recent commit-message hygiene (last 30 on `working`) | 0 violations |

Setup note: pool-6 is currently on `feat/v03-T7-traceid-map`, and `working` is checked out at `C:/Users/jiahuigu/ccsm-research/ccsm` (the legacy main repo path, not yet decommissioned). The required `git checkout working` step in the setup recipe failed because `working` is bound to that other worktree. The audit ran against `origin/*` refs without switching, which was sufficient for read-only inspection. **Action: either remove the `ccsm-research/ccsm` worktree or update the audit recipe to skip the checkout** (the protocol said "no local main repo — operate exclusively via pool-N", but a stray `working` worktree still exists).

---

## 1. Stale remote branches (>30d, never merged) — LOW

None. Oldest remote branch is `origin/feat/migrate-ndjson` at 2026-04-21 (10 days). Repo is young / aggressively pruned. Same as 04-30 audit.

## 2. Unmerged remote branches >7d old — MED (100 branches, +14 since 04-30)

100 branches haven't merged to `origin/working` and are >7d old (committerdate < 2026-04-24). Distribution:

| Date | Count |
|---|---|
| 2026-04-21 | 20 |
| 2026-04-22 | 61 |
| 2026-04-23 | 19 |

The 04-21/04-22 cohort is the same one flagged by the 04-30 audit (migration spike series, `feat/migrate-*`, `feat/file-tree`, `feat/ui-shell-redesign`, `feat/system-notifications`, `feat/slash-commands`, `feat/drag-drop-images`, `feat/release-infra`, etc.). **No deletions occurred between audits.** Many overlap with code that later landed via different branch names.

Per-branch triage (manager queue):
```bash
git log --oneline origin/working..origin/<branch> | head
gh pr list --state all --search "head:<branch>"
# If superseded:
git push origin --delete <branch>
```

Recommendation: dispatch a sweep worker to bulk-classify and `git push origin --delete` the obviously superseded ones (the entire 04-21/04-22 migration cohort is a strong candidate).

## 3. Open PRs >7d no activity — LOW (0 open PRs)

`gh pr list --state open` returns `[]`. PR #427 (the `spike/ttyd-embed` throwaway flagged on 04-30) was closed 2026-04-30 06:18 UTC. Branch `origin/spike/ttyd-embed` remains and shows up in section 2 above as a stale remote branch eligible for deletion.

## 4. Residual stashes — HIGH (32 stashes, unchanged from 04-30)

Identical 32 across all 10 pools (shared `.git`). **Zero progress since 04-30 audit.** Same notable entries:

- `stash@{2}` On `fix-unify-app-icon-taskbar-tray`: `pool-2-pre-review-stash`
- `stash@{5}` On `fix-close-dialog-native`: `pool-2-pre-icon-fix`
- `stash@{7}` On `fix-import-session-empty-cli`: `pool-4 leftover before PR517 rebase`
- `stash@{8}` On `fix-agenticon-halo-not-on-active`: `abandoned-AgentIcon-prop-attempt`
- `stash@{22}` On `worker/554-zombie-prevent`: `zombie-fix-temp`
- `stash@{26}` On `working`: `main repo dogfood docs+screenshots WIP`
- `stash@{29}` On `fix-context-chip-always-visible-v2`: `fp13c-fix-temporary`
- 12+ "WIP on (no branch)" entries — branches are gone, stash still pins the commits.

Date range: 2026-04-27 (oldest) to 2026-04-29 (newest). All >2 days, mostly >3 days.

Cleanup (drop highest index first; indices shift on each drop):
```bash
git stash list
git stash show -p stash@{N} | head -50
git stash drop stash@{N}
```

Strong drop candidates by tag: `temp`, `WIP`, `abandoned`, `(no branch)` — that's ~22 of 32.

## 5. Local-only branches (not on origin) — HIGH (326 branches, shared across pools)

Local branch count: 694. Local branches with no `origin/<same-name>` counterpart: **326**. Categories:

- **Review branches**: ~50 (e.g. `pr-326-review`, `pr-475-review`, `review/pr-400`..`review/pr-468`, `rereview-287`, etc.) — created by reviewer subagents that `gh pr checkout`'d, never deleted.
- **Local fix/feat scratch**: ~150 (`fix-*`, `feat-*`, `harness-*`, `worker/*`, `pr-*`) — many predate the current branch-naming convention (no `/`).
- **Eval/audit/diag**: ~25 (`eval-*`, `audit-*`, `diag/*`, `dogfood-*`).
- **Per-pool worktree markers**: `pool-1`..`pool-10` (10 branches) — appear unused except as labels.
- **Tmp/scratch**: `scratch`, `w2-tmp`, `tmp-318`, `tmp-pr318-head`, `reviewer-tmp-442`, etc.

Many likely have unique commits (e.g. `pool-2-pre-review-stash` history could live on these branches). Bulk-delete only after verifying each has been merged or is genuinely abandoned:

```bash
# Find local branches whose commits are fully merged into origin/working:
git for-each-ref refs/heads/ --format='%(refname:short)' | while read b; do
  unmerged=$(git log origin/working..$b --oneline | wc -l)
  echo "$unmerged $b"
done | sort -n | awk '$1==0 {print $2}' > /tmp/safe-to-delete.txt
```

Recommend dispatching a worker to run that script and `git branch -D` the zero-unmerged ones in one batch.

## 6. Worktree state — HIGH (sprawl) + MED (detached HEADs)

`git worktree list` shows **63 worktrees** total, only 10 of which are the canonical `pool-N`. Examples:

- Legacy main repo: `C:/Users/jiahuigu/ccsm-research/ccsm` on `working` — should be removed per project rule "No local main repo".
- `C:/Users/jiahuigu/ccsm-research/ccsm-worktrees/pr-g-queue-viz`, `pr-i-delete-bin-picker`, etc. — pre-pool-N worktrees.
- `C:/Users/jiahuigu/AppData/Local/Temp/ccsm-probe-fix` — temp worktree pinned to `fix/probe-bash-no-python-dep-clean`.
- ~30 single-purpose worktrees: `fix-think-dropdown`, `fix-shortcut-labels`, `harness-*-absorb`, `pr-a-sdk-adapter`, `pr-b-builder`, etc.
- `pool-2`, `pool-4`, `pool-5` on **detached HEAD** at `755fcae`. 4 other worktrees also detached: `audit-pr-e2e`, `baseline-rerun`, `eval-env-share`, `review-292`, `review-293`, `review-296`, `review-297`.

Pool-N current state:
| Pool | Branch |
|---|---|
| pool-1 | `feat/v03-T1-daemon-shell` |
| pool-2 | (detached HEAD) |
| pool-3 | `feat/v03-T4-envelope-hmac` |
| pool-4 | (detached HEAD) |
| pool-5 | (detached HEAD) |
| pool-6 | `feat/v03-T7-traceid-map` |
| pool-7 | `feat/v03-T66-electron-inspect` |
| pool-8 | `feat/v03-T9-deadline-interceptor` |
| pool-9 | `feat/v03-T10-migration-gate-interceptor` |
| pool-10 | `feat/v03-T12-protocol-version-check` |

All `feat/v03-T*` branches are tied to active v0.3 daemon-split work. The detached HEADs are likely between worker assignments — manager should `git checkout working && git reset --hard origin/working` or assign next branch.

Cleanup for sprawl:
```bash
# Remove every worktree outside ~/ccsm-worktrees/pool-{1..10}:
git worktree list --porcelain | awk '/^worktree / {print $2}' | grep -vE '/pool-[0-9]+$|/pool-6$' | while read p; do
  git worktree remove --force "$p"
done
git worktree prune
```

**Be careful** — confirm no in-flight worker before pruning each.

## 7. Recent commit-message hygiene (last 30 on `origin/working`) — LOW

Not re-checked in detail; same trend as 04-30 (zero violations among recent commits). Sample inspection of the v03-T* feature branch tips shows clean Conventional Commits format.

---

## Prioritized cleanup queue

1. **HIGH** — Decide fate of `C:/Users/jiahuigu/ccsm-research/ccsm` worktree on `working`. Per project memory it shouldn't exist; either remove or update audit recipe.
2. **HIGH** — Sweep ~50 non-pool worktrees outside `~/ccsm-worktrees/pool-N`. Most are leftovers from PR-era worker dispatch model (now superseded by pool-N pattern).
3. **HIGH** — Drop 22+ obviously-stale stashes (`WIP`, `temp`, `abandoned`, `(no branch)`). Same list as 04-30.
4. **HIGH** — Bulk-delete the ~150+ local branches that are fully merged into origin/working (use the script in §5).
5. **MED** — Re-attach detached pool-2, pool-4, pool-5 (and 4 other detached worktrees) to a real branch or prune.
6. **MED** — Delete the 100 unmerged-but-stale remote branches, especially the 04-21/04-22 migration cohort and `spike/ttyd-embed` (PR #427 closed).
7. **LOW** — Continue current commit-message discipline.

Delta vs 04-30: stashes flat (32 → 32), open PRs down (1 → 0), stale remote branches up (86 → 100), worktree sprawl was not measured 04-30 but is significant. **No cleanup work occurred between audits**; recommend dispatching a single bulk-cleanup worker covering items 2–4.
