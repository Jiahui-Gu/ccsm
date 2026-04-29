# Dogfood R2 — full 9-path report (post-#584)

**Worker:** dogfood R2 (full 9-path)
**Date:** 2026-04-29
**Working tip:** `26f85b3` (`fix(ui): replace empty pre-hydrate skeleton with content-shaped placeholder (#584) (#499)`)
**Build:** `npm run make:win` → `release/CCSM-Setup-0.1.0-x64.exe` + `release/win-unpacked/CCSM.exe` (exit 0)
**Install method:** Used unpacked binary (`release/win-unpacked/CCSM.exe`) with isolated `--user-data-dir`. `%APPDATA%\CCSM\` was wiped (`rm -rf ~/AppData/Roaming/CCSM`) before the run to simulate a fresh install. Squirrel-installer ceremony was not exercised because (a) it cannot be driven non-interactively in this environment and (b) the unpacked tree is byte-identical to what Squirrel deploys to `%LOCALAPPDATA%\CCSM`.
**Probes:** [`scripts/dogfood-r2-9paths.mjs`](../../scripts/dogfood-r2-9paths.mjs), [`scripts/dogfood-r2-supp.mjs`](../../scripts/dogfood-r2-supp.mjs)
**Backing E2E suite:** `npm run e2e` (full `run-all-e2e.mjs`, all 3 harnesses) — **24/24 ui cases PASS**, **harness-real-cli PASS**, **harness-dnd PASS** at this SHA.

## Summary

| # | Path | Result | Notes | Screenshot |
|---|------|--------|-------|------------|
| 1 | First-launch UX (PR #584 regression) | **PASS** | Pre-hydrate skeleton present: `[data-testid="sidebar-skeleton"]` + `main-skeleton` + `sidebar-skeleton-newsession` + 3 `sidebar-skeleton-row` stubs all observed within ~150ms of paint, then transitions to hydrated UI. NO blank-white frame. | `path-1-skeleton-supplementary.png`, `path-1-first-launch-hydrated.png` |
| 2 | Create new session, send message, get response | **PASS** | New session created via `first-run-empty` CTA, terminal host mounts, `__ccsmTerm` initialised, prompt typed, claude reply observed in xterm buffer. | `path-2-new-session.png` |
| 3 | Multi-session switching, history persists | **PASS** | Created session B alongside A, switched back, A's xterm buffer length preserved (1237b → 1233b — within 1%). pty pid stable across switch (also covered by `pty-pid-stable-across-switch` real-cli case). | `path-3-multi-session.png` |
| 4 | Permission prompts | **PARTIAL** (plumbing only) | No permission state keys exposed on store and no `window.ccsmPermissions` bridge. Live permission dialog requires a real claude tool invocation that hits a non-allowlisted command — not exercised in autonomous run. No regression risk identified; covered indirectly via `harness-real-cli` permission unit tests. | n/a |
| 5 | Slash command / agent invocation | **PASS** | `/help` typed into terminal pty, slash text reaches CLI without renderer interception (CCSM correctly defers to claude TUI for slash UI). | `path-5-slash.png` |
| 6 | Plugin / MCP / skill load | **PARTIAL** | pty count = 2 (sessions A + B), CLAUDE_CONFIG_DIR forwarding verified statically in `electron/agent/sessions.ts`. Live `/plugins` or `/skills` query not driven inside the pty. | n/a |
| 7 | Tray + taskbar unread badge (PR #493 regression) | **PASS** (indirect) | `__ccsmBadgeDebug` seam absent in production build (correctly gated on `CCSM_NOTIFY_TEST_HOOK`). Badge regression VERIFIED via `harness-real-cli` case `notify-fires-on-idle`, which asserts: (a) notification fires on idle transition, (b) `BadgeManager.getTotal() >= 1` after fire, (c) total returns to 0 on re-focus + setActive. That case PASSED in the full e2e run at this SHA. Tray hide-on-close + show-on-restore PASSED (`harness-ui` `tray` case). | `path-7-badge.png` |
| 8 | Restart app, sessions restore | **PASS** | Closed + relaunched with same `--user-data-dir`. Pre-restart: 2 sessions, activeId=`a3fbaa46`. Post-restart: 2 sessions, hydrated=true, activeId=`a3fbaa46`. All sessions restored, active selection preserved. | `path-8-restart.png` |
| 9 | Window controls / shortcuts / settings | **PASS** | `Ctrl+F` opens command palette (1 dialog mounted, `[cmdk-root]` present, body contains palette text). `Ctrl+,` opens Settings (1 dialog, settings text visible). Search + new-session buttons present in DOM. (Initial run had a probe selector-syntax bug; fixed in supplementary probe — verdict reflects supplementary result.) | `path-9-search-palette.png`, `path-9-settings.png` |

**Overall: 7 PASS, 2 PARTIAL, 0 FAIL.** Console errors during all runs: **0** (`pageerror` + `console.error` both empty across 3 launches).

---

## Side-by-side raw `claude` CLI comparison (paths 2–6)

Raw CLI version: 2.1.119 (Claude Code) at `/c/ProgramData/global-npm/claude`. `claude --print --max-turns 1 "say hi in 3 words"` returns "Hi there, friend!" in ~1s.

| Path | Raw CLI | CCSM | UX gap |
|------|---------|------|--------|
| 2 (chat) | one-shot stdout, no history visible without `--resume` | persistent xterm pane, multi-session, history visible inline | None — CCSM clearly better for daily-use |
| 3 (multi-session) | requires juggling `--resume <id>` per terminal | sidebar click switches, pty preserved | None — core differentiator working |
| 4 (permissions) | inline TTY prompt, blocks terminal | same prompt, surfaced inside CCSM pty pane | Behavior parity (both defer to CLI prompt) |
| 5 (slash) | inline `/help` works | inline `/help` works (verified: text reaches pty) | Parity. Could add CCSM-side picker (out of MVP scope §3 "Out") |
| 6 (skills/plugins) | reads `~/.claude/skills/` etc. | same — inherits CLAUDE_CONFIG_DIR | Parity |

---

## Top-3 friction items (UX gaps, not bugs)

1. **Permission prompt visibility** — current behavior defers to CLI's inline TTY prompt inside the pty. There's no CCSM-side permission badge or sidebar indicator when a session is blocked on permission, only the breathing-glow `waiting` state. Users may miss that a backgrounded session needs an allow/deny decision. Suggest: distinguish `waiting (input)` vs `waiting (permission)` in sidebar dot color or icon.
2. **Skill/plugin discoverability** — there's no CCSM-side surface for listing what skills/plugins are loaded; users must type `/plugins` inside the CLI to see them. Out of MVP scope per `docs/mvp-design.md` §3 (no MCP marketplace), but the lack of any visible affordance means users may not realise their `~/.claude/skills/` is even being read.
3. **First-launch onboarding** — after #584's skeleton fix, the white-flash bug is gone. But the first-run-empty CTA goes straight to a blank session with the CLI's own `? for shortcuts` hint and no CCSM-specific onboarding. Tutorial component exists (`probe-e2e-tutorial` PASSES) but is not surfaced on first launch in this run.

---

## Bug list

**P0 (release-blocker):** 0
**P1 (bad):** 0
**P2 (polish):** 1
- **P2-1 (probe quality, not product):** The initial 9-path probe used an invalid CSS selector `button:has-text("New session"), [data-testid*="new-session"]` — `:has-text` is a Playwright pseudo, not a browser CSS selector, so `document.querySelector` rejects it. Fixed inline in supplementary probe by enumerating buttons + filtering on `textContent`. Worth keeping as a lesson for future probes.

No product P0/P1 bugs surfaced by this round. The two recent product fixes regression-verified clean:
- **PR #499/#584** (skeleton): VERIFIED — content-shaped skeleton (sidebar bones + main loading) present pre-hydrate, no blank-white frame. Backed by `harness-ui` `startup-paints-before-hydrate` PASS.
- **PR #493/#572** (tray + badge): VERIFIED — `harness-real-cli` `notify-fires-on-idle` PASS confirms `BadgeManager.incrementSid` fires on idle notification and clears on re-focus + `session:setActive`.

---

## Self-fix PRs filed

None. The only issue found (P2-1) was in my own probe script, not product code; the supplementary probe corrects it.

---

## Release decision

**GO.**

Rationale:
- 7/9 paths PASS, 2 PARTIAL (paths 4 + 6 — both "live behavior not exercised" caveats, not regressions). 0 FAIL on product code.
- 0 console errors across 3 production-bundle launches.
- Both regression targets (#584 skeleton, #493 badge) verified via dedicated probe + backing harness case.
- Full `npm run e2e` suite (3 harnesses, 24 ui cases, real-cli + dnd) PASSES at this SHA.
- Pre-restart / post-restart session restoration works cleanly.
- Build (`npm run make:win`) is clean (exit 0); installer artifact `release/CCSM-Setup-0.1.0-x64.exe` produced.

Caveats for next dogfood round:
- Drive a real permission allow/deny inside the pty (path 4 live coverage gap).
- Drive `/plugins` or `/skills` inside the pty and screenshot the listing (path 6 live coverage gap).
- Consider running the actual Squirrel installer on a fresh VM to exercise the OS-level install path (out of scope for this autonomous run).

---

## Artifacts

- Probes: `scripts/dogfood-r2-9paths.mjs`, `scripts/dogfood-r2-supp.mjs`
- Per-path screenshots: `docs/screenshots/dogfood-r2/path-*.png`
- JSON summaries: `docs/screenshots/dogfood-r2/r2-9paths-summary.json`, `docs/screenshots/dogfood-r2/r2-supp-summary.json`
- Backing e2e: `npm run e2e` — 3/3 harnesses PASS, 24/24 ui cases PASS, ~260s wall.
