# Audit Report — 2026-04-30 — Deps + Dogfood-bug-vs-e2e gap

**Audit context:** worktree `~/ccsm-worktrees/pool-7` (audit performed before reset to origin/working tip).

## Summary

Top 4 outdated deps are MAJOR-jumps (electron +8, vitest +2, @types/node +3, electron-builder/typescript/better-sqlite3/lucide +1 each). 4 dogfood-bug-vs-e2e gaps identified.

## 1. Outdated deps (registry latest vs `package.json`)

| Package | Declared | Latest | Major delta | Severity |
|---|---|---|---|---|
| `electron` (devDep) | `^33.2.1` (now `^41.3.0` post #582) | **41.3.0** | n/a now | LANDED |
| `electron-builder` | `^26.8.1` (post #579) | **26.8.1** | n/a now | LANDED |
| `vitest` | `^2.1.8` | **4.1.5** | +2 majors | **HIGH** |
| `typescript` | `^5.7.2` | **6.0.3** | +1 major | MED |
| `@sentry/react` | `10.49.0` | 10.51.0 | 0 | LOW |
| `@sentry/electron` | `7.11.0` | 7.12.0 | 0 | LOW |
| `@anthropic-ai/claude-agent-sdk` | `^0.2.119` | 0.2.123 | 0 | LOW |
| `better-sqlite3` | `^12.9.0` (post #582) | **12.9.0** | n/a now | LANDED |
| `lucide-react` | `^0.469.0` | 1.14.0 | +1 major (1.0 release) | MED |
| `@types/node` | `^22.10.0` | 25.6.0 | +3 majors | MED |
| `concurrently` | `^9.1.0` | 9.2.1 | 0 | LOW |
| `playwright` | `^1.59.1` | 1.59.1 | 0 | LOW |
| `node-pty` | `1.1.0` | 1.1.0 | 0 | LOW |

## 2. Security audit — DEFERRED

Not run from read-only context. Recommend re-run vs post-#579 baseline (16 vulns / 6 high). Likely improved post-#582 Electron 41 + sqlite 12 landings.

## 3. Unused deps (depcheck) — DEFERRED

Static review of `package.json`: no obvious removable deps (PostCSS chain, type packages, builder/CI tools all needed). Run `npx depcheck --skip-missing` from a writeable session.

## 4. Dogfood-bug-vs-e2e gap

`dogfood-logs/` exists with 5 sub-buckets: `BUG-186-REPRO.md` + 4 batch JSONs, `dogfood-public-001-2026-04-24/`, `r2-fp9/`, `r2-fp11/`, `r2-fp13/`, `ux-promax-wave2/`.

Probe coverage: 42 cases total (24 real-cli + 15 ui + 1 dnd + 2 standalone).

Spot-check of recent fix-PRs vs regression-probe presence:

| PR | Subject | Probe? | Where |
|---|---|---|---|
| #509 | notify shows session name | YES | `harness-real-cli.mjs:863` |
| #510 | import lands in focused group | YES | `harness-real-cli.mjs:1797` |
| #515 | imported session resumes claude --resume | YES | `harness-real-cli.mjs:1409` |
| #517 | exclude current group from Move-to-group | YES | `harness-ui.mjs:1516` |
| #519 | always send OS notification | **NO direct probe** | gap candidate |
| #520 | clear sessionNamesFromRenderer on delete | YES (seam at L2850-2916) | partial |
| #523 | Move-to-group submenu single group | YES (Subcase 2) | covered |
| #525 | unify "C" icon | NO (visual-only, deliberately removed) | acceptable |
| #526 | cwd popover Browse → OS folder picker | **NO probe found** | **GAP** |
| #527 | rename input no auto-cancel | YES | `harness-ui.mjs:836+` |
| #528 | arm gate per session | YES | `harness-real-cli.mjs:2093,2942` |
| #529 | sidebar rename writes JSONL via SDK | YES | `harness-real-cli.mjs:306` |
| #530 | rename focus race + Tab/Arrow/F2/dblclick | YES | `harness-ui.mjs:836-988` |
| #531 | OSC 0 title-stream as arm signal | partial — explicit OSC 0 not asserted by name | **possible GAP** |
| #547 | setActive does not count as user input | YES — explicit at L2942 | covered |
| #562 | macos dnd fallback + toast-a11y | YES | dnd harness + RTL |

**Gaps to file (HIGH priority):**
- **PR #526** — no probe verifies `dialog.showOpenDialog` invoked from cwd popover Browse.
- **PR #519** — no dedicated regression for "no longer gated by visibility/focus".
- **PR #531** — no probe asserts OSC 0 sequence specifically arms a notification.
- **BUG-186** — 4 batch JSONs reproduce bug but no `caseBug186*` exists; verify underlying fix has regression probe.

## 5. Native module compat (Electron ABI)

Post-#582:
- `electron@^41.3.0` (Node 22.x, NODE_MODULE_VERSION 145)
- `better-sqlite3@^12.9.0` — has prebuilds for Electron 41 ✓
- `node-pty@1.1.0` — N-API, ABI-agnostic ✓
- `@electron/rebuild@^4.0.4` (post-#582)

**Compatible.** All ABI mismatches resolved by PR #582.

## Recommendations (ranked)

### HIGH
1. **Bump `vitest`** `^2.1.8` → `^4.1.5` (2 majors; check breaking changes in v3 → v4 config + `expect.extend` types).
2. **Re-run `npm audit`** vs post-#579 baseline.
3. **Close dogfood→e2e gaps:** PR #526 (Browse), PR #519 (notify-always-fires), PR #531 (OSC 0 arm), `caseBug186*`.

### MEDIUM
4. **Bump `typescript`** `^5.7.2` → `^6.0.3` (TS6 stricter inference; gate behind separate PR with full lint/typecheck pass).
5. **Bump `@types/node`** `^22.10.0` → `^25.6.0` (Node 22 runtime matches).
6. **Bump `lucide-react`** `^0.469.0` → `^1.14.0` (1.0 milestone; verify icon renames).

### LOW
7. Patch-level bumps: Sentry, Anthropic SDK, concurrently, jsdom — single `chore(deps)` PR.
8. Run `npx depcheck --skip-missing` and confirm no unused deps remain.
