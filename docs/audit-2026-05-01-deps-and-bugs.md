# Audit Report — 2026-05-01 — Deps + Bugs

**Worktree:** `~/ccsm-worktrees/pool-7` reset to `origin/working` tip `755fcae` (T12 daemonProtocolVersion).
**Tooling:** `npm outdated --json`, `npm audit --json`, `npx depcheck --skip-missing`. node_modules freshly installed (`npm ci`).
**Scope:** outdated deps, security advisories, unused deps, dogfood-bug regression-test gaps. **No bumps, no commits, no other writes.**

## Summary

- **5 moderate vulns** (no high/critical). 1 chain is direct (`@anthropic-ai/claude-agent-sdk` → `@anthropic-ai/sdk` GHSA-p7fg-763f-g4gf, fix is **major-revert**, see HIGH-1). The other chain is `webpack-dev-server` → `sockjs` → `uuid` GHSA-w5hq-g745-h8pq (dev-only, fix major).
- **Top deps with major-version gaps:** `react`/`react-dom` 18→19, `@types/react*` 18→19, `eslint`/`@eslint/js` 9→10, `eslint-plugin-react-hooks` 5→7, `lucide-react` 0.469→1.14, `@xterm/*` 5→6 / 0.10–0.13→0.11–0.14, `pino` 9→10, `tailwind-merge` 2→3, `typescript` 5.9→6.0, `ulid` 2→3, `wait-on` 8→9, `webpack-cli` 6→7, `@types/node` 22→25, `@dnd-kit/sortable` 8→10.
- **Unused deps (depcheck, after manual filter for build-tool false positives):** `fuse.js`, `pino`, `ulid` (3 prod deps with **zero `from '<pkg>'` imports under `src/`** — true removal candidates). The 12 unused devDeps are all build-toolchain false positives (postcss/tailwind/webpack/loaders/nodemon).
- **Dogfood bug regression-test coverage gaps:** 4 distinct active bugs from `dogfood-public-001-2026-04-24.md` (Bug 1 elapsed-counter, Bug 3 allow-always copy, Bug 6 duplicate "New session" naming) + 3 r2-fp findings (fp9 edit-replace divergence, fp11-F horizontal overflow, fp13-A no ellipsis/tooltip on long names) + Gap 1 SCREAMING strings → **no probe references found** for any of them under `scripts/`.

---

## 1. Outdated deps (top 10 by major-version gap)

Source: `npm outdated --json` (24 packages outdated, all listed below; `wanted` == `current` for all but `jsdom` and `postcss`, indicating semver-locked at majors below latest).

| Package | Current | Latest | Major Δ | Severity | Notes |
|---|---|---|---|---|---|
| `@types/node` | 22.19.17 | 25.6.0 | **+3** | MED | type-only; safe to bump but watch Electron/Node version pin. |
| `@dnd-kit/sortable` | 8.0.0 | 10.0.0 | +2 | MED | dnd is core sidebar UX; verify drag handle + keyboard a11y after bump. |
| `react` / `react-dom` | 18.3.1 | 19.2.5 | **+1** | **HIGH** | Many upstream pkgs (radix, framer-motion, lucide) tracking React 19. Coordinate with `@types/react*` 18→19. |
| `@types/react` / `@types/react-dom` | 18.3.x | 19.2.x | +1 | HIGH | Pinned by React 18; bump together. |
| `eslint` + `@eslint/js` | 9.39.4 | 10.x | +1 | MED | Flat-config migration likely fine (already on 9). |
| `eslint-plugin-react-hooks` | 5.2.0 | 7.1.1 | **+2** | MED | New rules may flag existing code. |
| `lucide-react` | 0.469.0 | 1.14.0 | +1 (1.0 release) | MED | Icon API stable; treeshaking may improve. |
| `@xterm/xterm` + `@xterm/headless` | 5.5.0 | 6.0.0 | +1 | MED | Used by terminal pane; verify FitAddon/SerializeAddon compat. |
| `@xterm/addon-fit` | 0.10.0 | 0.11.0 | +1 | LOW | tied to xterm bump. |
| `@xterm/addon-serialize` | 0.13.0 | 0.14.0 | +1 | LOW | tied to xterm bump. |
| `pino` | 9.14.0 | 10.3.1 | +1 | LOW | unused (see §3); remove instead of bump. |
| `tailwind-merge` | 2.6.1 | 3.5.0 | +1 | LOW | small surface; bump w/ tailwind v4. |
| `typescript` | 5.9.3 | 6.0.3 | +1 | LOW | hold until ecosystem catches up. |
| `ulid` | 2.4.0 | 3.0.2 | +1 | LOW | unused (see §3); remove instead. |
| `wait-on` | 8.0.5 | 9.0.5 | +1 | LOW | dev/CI helper. |
| `webpack-cli` | 6.0.1 | 7.0.2 | +1 | LOW | dev only. |
| `@sentry/electron` | 7.11.0 | 7.13.0 | 0 | LOW | patch behind. |
| `@sentry/react` | 10.49.0 | 10.51.0 | 0 | LOW | patch behind. |
| `jsdom` | 29.1.0 | 29.1.1 | 0 | LOW | semver-fix only. |
| `postcss` | 8.5.12 | 8.5.13 | 0 | LOW | semver-fix only. |

**Security-advisory flag:** `@sentry/*` patch bumps are non-security per audit; only chains in §2 carry advisories.

## 2. Security audit (high/critical only)

`npm audit --json` reports **5 moderate, 0 high, 0 critical, 0 low** across 1296 deps.

Per scope ("high/critical only"): **none to report.** Full table for reference (all moderate):

| Package | Severity | Direct? | Advisory | Fix path |
|---|---|---|---|---|
| `@anthropic-ai/sdk` (via `@anthropic-ai/claude-agent-sdk`) | moderate | indirect | [GHSA-p7fg-763f-g4gf](https://github.com/advisories/GHSA-p7fg-763f-g4gf) — Insecure Default File Permissions in Local Filesystem Memory Tool, range `>=0.79.0 <0.91.1` | npm proposes major-revert of `claude-agent-sdk` to 0.2.90. **Do NOT take that revert** — current `0.2.119+` is a forward-only contract per project memory. Wait for upstream `@anthropic-ai/sdk >=0.91.1` to land in a newer `claude-agent-sdk` release. |
| `@anthropic-ai/claude-agent-sdk` | moderate | direct | (transitive only — flagged because SDK pins vulnerable sdk range) | same as above. |
| `webpack-dev-server` | moderate | direct (devDep) | via `sockjs` | major bump to v5 (already on `^5.2.0` per package.json — **mismatch with lockfile shows v3-era resolved**; verify with `npm ls webpack-dev-server`). |
| `sockjs` | moderate | indirect | via `uuid` | tied to wds bump. |
| `uuid` | moderate | indirect | [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) — buffer bounds check missing, range `<14.0.0` | tied to wds bump. dev-only impact. |

## 3. Unused deps (depcheck)

`npx depcheck --skip-missing` reports 3 prod + 12 devDeps unused. After manual grep-verification under `src/`:

### Confirmed removal candidates (3 prod deps)

| Package | Declared | Verified | Action |
|---|---|---|---|
| `fuse.js` (`^7.0.0`) | yes | **0 `from 'fuse.js'`** in `src/` | **REMOVE** — no fuzzy-search consumer left. |
| `pino` (`^9.5.0`) | yes | **0 `from 'pino'`** in `src/` | **REMOVE** — logging done via console / sentry. |
| `ulid` (`^2.3.0`) | yes | **0 `from 'ulid'`** in `src/` | **REMOVE** — IDs generated via `crypto.randomUUID()` etc. |

### Build-tool false positives (12 devDeps — keep)

`@tailwindcss/postcss`, `@testing-library/user-event`, `autoprefixer`, `css-loader`, `nodemon`, `postcss`, `postcss-loader`, `style-loader`, `tailwindcss`, `ts-loader`, `webpack-cli`, `webpack-dev-server` — all referenced via webpack/postcss config, npm scripts, or jsdom test fixtures. depcheck cannot trace these.

## 4. Dogfood bug-pattern audit — regression test coverage

### Sources scanned

- `dogfood-logs/BUG-186-REPRO.md` (1 bug, probe bug not prod)
- `dogfood-logs/dogfood-public-001-2026-04-24.md` (5 active bugs + 7 UX gaps after Bug 2 rescission)
- `dogfood-logs/r2-fp9/findings.json` (8 checks, 4 FAIL/PARTIAL)
- `dogfood-logs/r2-fp11/findings.json` (6 checks, 1 FAIL + 1 PARTIAL)
- `dogfood-logs/r2-fp13/findings.json` (6 checks, 1 FAIL + 2 PARTIAL)

### Coverage matrix

| Source | Finding | Probe / regression test? | Severity |
|---|---|---|---|
| BUG-186 | Skill auto-injection causes Allow-click to wrong tool (probe-side, not prod) | Probe to be patched per fix recommendation §5 (not yet landed under `scripts/`) | MED — probe flake, prod unaffected |
| dogfood-public-001 Bug 1 | Bash elapsed-counter starts at request, "still no result" warning fires while permission still pending | **No probe / unit test** found. `grep -r "still no result"` in `src/` returns 0; no test asserts counter starts at execution-start | **HIGH** — confirmed P1 bug, user-visible, easy regression risk |
| dogfood-public-001 Bug 3 | "Allow always" copy doesn't convey per-tool/per-pattern scope | No probe; copy lives in `src/` permission UI but no UI test asserts the explanatory text | MED |
| dogfood-public-001 Bug 4 | Esc key multi-binding precedence not surfaced | No probe; Esc handler likely in input/popover layer, no test asserts ordering | LOW (P2) |
| dogfood-public-001 Bug 5 | Bash stdout collapsed by default + missing initial ticks | No probe; was a single-occurrence anecdote | LOW (P2) |
| dogfood-public-001 Bug 6 | Two sessions both auto-named "New session" indistinguishable | No probe asserts disambiguator | MED (P2 but visible) |
| dogfood-public-001 Gap 1 | SCREAMING UI strings (`STEP 1 OF 4`, `Q2 LAUNCH`, `BUG TRIAGE`, `RECENT`, `SETTINGS`, `CLI-PICKER`, `FALLBACK` badges) | No lint rule / no probe enforces sentence case across i18n | **HIGH** — explicit project rule violation, easy lint check |
| dogfood-public-001 Gap 3 | cwd hidden behind tiny chip; default = home | `docs/reference/cwd-and-first-run-design.md` exists but no probe asserts visible cwd line | MED |
| r2-fp9 D | Edit-and-resend appends new turn instead of replacing (spec divergence) | No probe asserts replace-vs-append semantics | MED — design intent locked but no regression test |
| r2-fp11 F | Stream container has horizontal overflow (scrollWidth=4297 / clientWidth=1006) | No probe asserts `scrollWidth <= clientWidth` for chat stream | **HIGH** — visible layout break |
| r2-fp13 A | Long agent/group names not clipped, no ellipsis, no tooltip | No probe asserts ellipsis / `title` attribute on truncated chips | MED |
| r2-fp13 C | Context chip hidden until ≥50% fill | Design choice; tracked by ux-promax-wave2 | LOW |
| r2-fp13 D | Store `costUsd=null` from proxy | Probe could assert non-null after first turn | LOW |

---

## 5. Recommendations (ranked)

### HIGH

1. **Decide @anthropic-ai/sdk advisory posture.** GHSA-p7fg-763f-g4gf affects Local Filesystem Memory Tool default permissions. CCSM does not use that tool surface (CLI binary owns the memory), so impact is **none in our context** — document this in a brief note and keep `claude-agent-sdk` forward. Do not take npm's auto-revert.
2. **File regression-probe tasks for the 3 HIGH dogfood gaps:**
   - Bug 1 (elapsed counter / "still no result" wording vs permission pending) — UI probe with mocked tool waiting on permission.
   - Gap 1 (SCREAMING strings) — add a lint or probe that scans i18n bundles for `^[A-Z0-9 ]{3,}$` strings rendered as labels/badges.
   - r2-fp11 F (horizontal overflow in chat stream) — probe asserts `scrollWidth <= clientWidth + epsilon` after rendering a long table / wide code block.
3. **Remove 3 unused prod deps** (`fuse.js`, `pino`, `ulid`). Net `package.json` cleanup, no runtime behavior change. (Single small PR; reviewer should grep again across full repo to confirm.)

### MED

4. **Bump React 18 → 19 + types** (coordinated PR). Many devDeps already at React-19-compatible majors; staying on 18 will accumulate compat debt.
5. **Bump `eslint` 9→10 and `eslint-plugin-react-hooks` 5→7** in one pass; expect new lint findings to fix.
6. **Bump `@xterm/*` 5→6 (and addons)** — verify terminal pane in dev, quick visual check.
7. **Bump `lucide-react` 0.469 → 1.14** — first stable release, treeshake benefits.
8. **File regression-probe tasks for r2-fp9 D (edit-replace vs append), r2-fp13 A (ellipsis/tooltip), Bug 3 (allow-always copy), Bug 6 (duplicate session naming).**

### LOW

9. **Bump patch-only deps** (`@sentry/*`, `jsdom`, `postcss`) in a single housekeeping PR.
10. **Bump dev-only majors** (`wait-on` 8→9, `webpack-cli` 6→7, `@dnd-kit/sortable` 8→10) — verify dev/build still works on Win 11.
11. **`webpack-dev-server` audit chain** — verify lockfile resolves to v5 (matches package.json `^5.2.0`); if not, regen lockfile to clear the moderate uuid/sockjs advisories.
12. **`@types/node` 22→25** — defer until Electron 41 → 42 bump (Node version coupling).

---

## Appendix — raw artifacts

- `/tmp/outdated.json` (5142 bytes) — full `npm outdated`
- `/tmp/audit.json` (3534 bytes) — full `npm audit`
- `/tmp/depcheck.json` (120580 bytes) — full `npx depcheck`
