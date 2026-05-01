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
- Resets the worker pool worktrees at `~/ccsm-worktrees/pool-{1..N}` to a
  clean checkout when they have drifted onto stale feature branches. Discover
  the active set first: `git worktree list | grep -oE 'pool-[0-9]+' | sort -u`.
  Note: pools 11–20 may hold long-running spec/feat branches — treat each as a
  real worktree, do NOT bulk-delete.

It does **not**:

- Delete `main`, `working`, `release/*`, or any branch attached to an OPEN PR.
- Remove the pool directories themselves (they are pre-installed and reused).
- Run `git gc` / `git push --force` / amend history.

## Prerequisites

- Run from any worktree on `[working]` (e.g. `~/ccsm-worktrees/pool-N` or a
  topic-named worktree). See STATUS.md §47.
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
`git branch -r` output is the practical way to sort 400+ branches:

```python
# branch-categorize.py — emits /tmp/local_delete.txt and /tmp/remote_delete.txt
import json, subprocess, datetime as dt
prs = json.load(open('/tmp/all_prs.json'))
latest = {}
for p in prs:
    h = p['headRefName']
    if h not in latest or (p.get('mergedAt') or p.get('closedAt') or '') > (latest[h].get('mergedAt') or latest[h].get('closedAt') or ''):
        latest[h] = p
remotes = subprocess.check_output(['git','branch','-r'], text=True).splitlines()
cands = [r.strip().removeprefix('origin/') for r in remotes
         if 'HEAD' not in r and not r.strip().startswith(('origin/main','origin/working','origin/release/'))]
cutoff = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=7)
remote_del, investigate = [], []
for b in cands:
    pr = latest.get(b)
    if not pr: investigate.append(b); continue
    if pr['state'] == 'OPEN': continue
    if pr['state'] == 'MERGED': remote_del.append(b); continue
    closed = dt.datetime.fromisoformat(pr['closedAt'].replace('Z','+00:00'))
    if closed < cutoff: remote_del.append(b)
open('/tmp/remote_delete.txt','w').write('\n'.join(remote_del))
open('/tmp/investigate.txt','w').write('\n'.join(investigate))
gone = [l.split()[0] for l in subprocess.check_output(['git','branch','-vv'], text=True).splitlines() if ': gone' in l]
open('/tmp/local_delete.txt','w').write('\n'.join(gone))
```

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

Each pool at `~/ccsm-worktrees/pool-N` (N discovered above) should normally
end on `working` HEAD after its worker finishes. If a pool is sitting on a
long-stale feature branch with no associated open PR:

```bash
cd ~/ccsm-worktrees/pool-N

# 0a. Check for active worker activity (any of these → SKIP this pool):
test -f .git/index.lock                          && echo skip && exit
git log -1 --since="30 minutes ago" --oneline    # non-empty → skip
pgrep -f "node.*$(pwd)" || pgrep -f "electron.*$(pwd)"  # any → skip

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

## Recovery

If a branch was deleted in error, GitHub retains the ref for ~7 days:

```bash
# Find recently-deleted refs and the SHA they pointed at
git reflog show origin --date=iso

# Restore by pushing the SHA back to the original name
git push origin <sha>:refs/heads/<name>
```

Window is 7 days per GitHub's reflog retention default; act fast.

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
