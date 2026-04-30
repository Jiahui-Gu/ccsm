# Daily Full-Stack Audit Summary — 2026-05-01

7 read-only audit subagents ran in parallel across pools 1–7.

## Cross-domain ranking

### HIGH (manager attention required)

1. **Worktree sprawl** [git-pr-hygiene] — 63 worktrees on disk, only 10 are canonical pool-N. ~50 single-purpose worktrees from pre-pool-N era squat disk. Bulk prune candidate.
2. **326 local-only branches with no origin counterpart** [git-pr-hygiene] — review subagent leftovers, scratch branches, pool-N markers across all worktrees.
3. **STATUS.md is 11d/600+ PRs stale** [doc-code-consistency] — claims `electron/agent/sessions.ts` + Claude Agent SDK runtime; neither exists (real runtime is node-pty + xterm.js + CLI). Counter-source-of-truth.
4. **roadmap.md links to non-existent `docs/superpowers/specs/mvp-design.md`** [doc-code-consistency] — dead reference.
5. **v0.3-fragments dir was supposed to self-delete after merge** [doc-code-consistency] — both `v0.3-design.md` (1700+ lines) AND `v0.3-fragments/` directory still present. ~3400 LoC of duplicated spec.
6. **Daemon envelope subsystem (~1042 LoC) has zero production callers** [code-rot] — T8/T13–T20 wiring tasks must land or this is dead-on-arrival. Acceptable as L1 build-up while L2/L3 land in parallel waves.
7. **`electron/commands-loader.ts` (394 LoC) zero runtime callers** [code-rot] — superseded by renderer reading `CLAUDE_CONFIG_DIR` directly per memory note. Removal candidate.
8. **3 broken/stale memory references** [persistence] — `harness-agent.mjs` and `harness-perm.mjs` cited 6+ times don't exist; broken cross-links `feedback_track_tasks_immediately`, `feedback_bug_fix_e2e_first`.
9. **3 user-visible bugs lack regression probes** [deps-and-bugs] — Bash elapsed-counter "still no result" stuck during pending permissions; SCREAMING UI strings (rule violation, no lint guard); chat stream horizontal overflow scrollWidth=4297 vs clientWidth=1006.

### MED (next-sprint candidates)

- **vitest coverage gap**: `coverage.include` missing `daemon/src/**` — daemon LoC absent from lcov [test-coverage]
- **17 untested files** (down from 43 but most was heuristic correction; real growth ~0). Top: `ImportDialog.tsx` 264 LoC, `CwdPopoverPanel.tsx` 162, 5 `electron/preload/bridges/*` totaling 498 LoC [test-coverage]
- **9 carry-over MEDs** from 04-30 audit unfixed [doc-code-consistency] — 69% carry rate
- **README/mvp-design shortcut lists ≠ code** [doc-code-consistency] — Cmd+N documented but never bound
- **Cleanup not happening between audits** [git-pr-hygiene] — stashes 32 (unchanged), open PRs 0 (down 1), stale remote branches up 86→100
- **3 worktree pools (2/4/5) on detached HEAD** at `755fcae` [git-pr-hygiene]
- **5 truly orphan files in `src/`** (~457 LoC): FileTree.tsx + utils/file-tree.ts, MetaLabel.tsx, shared/ipc-types.ts, utils/diff.ts [code-rot]
- **`@anthropic-ai/sdk` GHSA-p7fg-763f-g4gf moderate** [deps-and-bugs] — DO NOT take npm's revert proposal (forward-only contract); CCSM doesn't use affected memory-tool surface
- **`webpack-dev-server` → uuid GHSA-w5hq-g745-h8pq** [deps-and-bugs] — dev-only, lockfile staleness
- **Memory contradiction**: MEMORY.md says "no local main repo" but `ccsm-research/ccsm` exists AND `feedback_dogfood_check_main_repo_first.md` assumes it [persistence]
- **`ccsm-probe` skip guard missing on 7 of 17 hooks** [persistence]
- **bash-discipline regex doesn't match `projects/agentory` path** [persistence]
- **2 user-visible bugs lack probes** [deps-and-bugs] — edit-replace vs append divergence; ellipsis/tooltip on long names

### LOW (auto-applied or trivial follow-ups)

- 3 unused prod deps verified zero-import: `fuse.js`, `pino`, `ulid` [deps-and-bugs] — removal candidate (manager opts in via separate PR)
- Stale `pending-tasks.txt` orphan = 963 [persistence]
- `untracked-dispatch.txt` collects false positives from "Daily audit subagent" dispatches every day [persistence] — needs whitelist in `dispatch-track-pre.py`
- README screenshot still placeholder TODO [doc-code-consistency]
- 14 "pending" markers (mostly v0.3 vocabulary, 2 actionable in STATUS.md) [doc-code-consistency]
- Vitest threshold not CI-enforced [test-coverage] — carry from 04-30
- #520 regression UT still missing [test-coverage] — carry from 04-30
- Hook L-7 candidate: enforce `cd pool-N` first-step rule [persistence]
- Top outdated: `@types/node` 22→25, `@dnd-kit/sortable` 8→10, `react` 18→19, `eslint` 9→10 (all major-version, defer) [deps-and-bugs]

## Stats

| Domain | HIGH | MED | LOW | Notes |
|---|---|---|---|---|
| persistence | 3 | 4 | 9 | 16 findings |
| doc-code | 6 | 9 | 6 | 9/13 carry-over (69%) |
| code-rot | 2 | ~5 | ~8 | TODOs all <2d, zero commented-out blocks (clean) |
| architecture | 0 | 0 | watchlist | All 3 prior MEDs fixed; preload split shipped; max file 477 LoC |
| test-coverage | 0 | 2 | 3 | 0 unauthorized skips; 43 e2e cases (+1) |
| git-pr-hygiene | 2 | 4+ | — | Bulk cleanup needed |
| deps-and-bugs | 3 (bug-probe gaps) | 5 | various | 0 high/critical CVEs |

## Auto-applied LOW fixes

(See companion commit body — manager applied conservative fixes that don't risk merged code.)

## Manager action requested

Manager review: please flag which HIGH and MED items should become tasks. Recommended sequence:
1. **Worktree+branch bulk cleanup** (HIGH #1, #2) — single dispatched cleanup worker can handle both safely
2. **STATUS.md rewrite** (HIGH #3) — replace agent-sdk fiction with actual node-pty runtime; cite recent merged daemon work
3. **Spec dedup** (HIGH #5) — collapse `v0.3-fragments/` into `v0.3-design.md` OR vice versa, not both
4. **Add probes for 3 user-visible bugs** (HIGH #9) — bash counter, screaming-strings lint, chat horizontal-overflow
5. **Fix doc dead refs** (HIGH #4, persistence H1-H3) — quick wins
6. **commands-loader.ts removal** (HIGH #7) — verify zero callers then delete

Defer: daemon envelope dead-on-arrival concern (HIGH #6) — actively being wired in current sprint (T8/T13-T20).
