# Branch & worktree hygiene runbook

Operational guide for keeping `Jiahui-Gu/ccsm` branch list and the local
`~/ccsm-worktrees/pool-N` workspaces tidy. Run this whenever the branch list
grows past a few dozen, or after a sprint that produced many merged PRs (e.g.
the v0.3 daemon-split sprint that left ~400 stale heads behind).

This is a **safety-first** runbook: every destructive step is preceded by an
inventory step that produces a list you can review before deletion.

## Scope

- Cleans branches on `origin` (GitHub remote) that are no longer needed.
- Cleans local branches in the main repo that track those remotes.
- Resets the 10 worker pool worktrees at `~/ccsm-worktrees/pool-{1..10}` to a
  clean checkout when they have drifted onto stale feature branches.

It does **not**:

- Delete `main`, `working`, `release/*`, or any branch attached to an OPEN PR.
- Remove the pool directories themselves (they are pre-installed and reused).
- Run `git gc` / `git push --force` / amend history.

## Prerequisites

- Run from the main repo, not a worktree:
  `cd C:/Users/jiahuigu/ccsm-research/ccsm`
- `gh` CLI authenticated against the repo: `gh auth status`
- Refresh remote state first: `git fetch origin --prune`

## Inventory

```bash
# Local branches whose upstream was deleted on the remote
git branch -vv | grep ': gone'

# All remote candidates (excluding protected refs)
git branch -r | grep -v -E '(HEAD|origin/main$|origin/working$|origin/release/)'

# All worktrees + their current branch
git worktree list

# All PRs in one shot (used by the categorizer below)
gh pr list --state all --limit 2000 \
  --json number,headRefName,state,mergedAt,closedAt > /tmp/all_prs.json
```

## Categorize before deleting

For each candidate branch, assign one of:

| Category | Treatment |
| --- | --- |
| Latest PR is OPEN (any draft state) | KEEP — never delete |
| Latest PR is MERGED | DELETE remote + local |
| Latest PR is CLOSED and closedAt > 7 days ago | DELETE remote + local |
| Latest PR is CLOSED and closedAt <= 7 days ago | KEEP — author may reopen |
| No PR ever existed | INVESTIGATE — list, do not auto-delete |
| Branch checked out in a live worktree | KEEP — let the worker finish |
| Local branch with `[gone]` upstream tracking | DELETE local (upstream confirms removal) |

A small Python categorizer that consumes `/tmp/all_prs.json` plus
`git branch -r` output is the practical way to sort 400+ branches; see the
inline script in PR #<this-PR>.

## Execute deletions

After producing the safe-delete lists:

```bash
# Local
xargs -n 50 git branch -D < /tmp/local_delete.txt

# Remote (batched to keep individual push payloads small)
xargs -n 30 git push origin --delete < /tmp/remote_delete.txt
```

If a `git push --delete` rejects a branch, leave it for manual review — do not
chase with `--force`.

## Reset worker pools

Each pool at `~/ccsm-worktrees/pool-N` should normally end on `working` HEAD
after its worker finishes. If a pool is sitting on a long-stale feature
branch with no associated open PR:

```bash
cd ~/ccsm-worktrees/pool-N
oldbr=$(git symbolic-ref --short HEAD)
git fetch origin --prune
git checkout --detach origin/working
git reset --hard origin/working
git clean -fd
[ -n "$oldbr" ] && git branch -D "$oldbr" 2>/dev/null || true
```

Detached HEAD is intentional — `working` itself is checked out by the main
repo and cannot live in two worktrees at once. The next dispatched worker
will create its own task branch off `origin/working`.

**Skip a pool if:**

- `git status -sb` shows uncommitted changes (worker still running, or a PR
  in progress). Do not auto-reset; ping the manager.
- The pool is the current worker's cwd (don't reset yourself out of work).

## Verify

```bash
# Branch counts should drop sharply
git branch | wc -l
git branch -r | wc -l

# Pools should all be either detached on working or on a fresh task branch
git worktree list

# Confirm no protected refs were touched
git branch -r | grep -E '(main|working|release/)'
```

## Cadence

- Run after every release tag (`v*`) — the merge wave leaves a long tail.
- Run when `git branch -r | wc -l` exceeds ~75.
- Run when a worker reports "too many local branches" or a fetch becomes slow.

## Don'ts

- Don't `rm -rf` a pool directory — they are pre-installed (npm modules,
  electron-rebuild output) and cost 5–10 min to recreate.
- Don't delete a branch with `--force` past the safe-delete categorizer.
- Don't `git gc --prune=now` here — that's a separate, deeper hygiene pass.
- Don't push --force anything during a hygiene run.
