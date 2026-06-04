# Technical Debt Register

Living document of known technical debt in ccsm, ranked by impact + effort.
Refreshed by the `technical-debt` skill audit (see Anthropic harness).

Format:
- **Status**: `OPEN` / `IN PROGRESS` / `DONE` / `WONTFIX`
- **Effort**: `S` (<1 day) / `M` (1–5 days) / `L` (>1 week)
- **Impact**: `LOW` / `MED` / `HIGH` / `CRITICAL`
- **Priority** is `effort × impact`; cheap+high-impact items first.

Audit history is appended to the bottom — this register reflects current
state, not history. When a debt item lands a PR, mark it `DONE` with the
merge SHA and short note rather than deleting the row (so the ledger
shows what got paid down).

---

## Open debt (as of 2026-05-25 audit)

### P1 — HIGH impact, large

| ID | Item | Status | Effort | Impact | Location |
|---|---|---|---|---|---|
| 1 | Electron 41 → 42 (Chromium CVE patches stop arriving on 41) — **BLOCKED upstream**: held at `^41.3.0` until the `node-pty`/`better-sqlite3` native ABI rebuild (`scripts/postinstall.mjs`) is verified against Electron 42's ABI. Tracking; not yet actionable. | OPEN | M | HIGH | `package.json` |
| 2 | `@anthropic-ai/claude-agent-sdk` 0.2 → 0.3. **DONE** ([#1421](https://github.com/Jiahui-Gu/ccsm/pull/1421), `db9584a`): bumped to `^0.3.156`. | DONE | M | HIGH | `package.json` |
| 3 | Renderer bundle 1.24 MB single chunk — lazy-load `ImportDialog`/`CommandPalette`/`SettingsDialog`. **DONE** ([#1417](https://github.com/Jiahui-Gu/ccsm/pull/1417), `39138a8`): 3 dialogs converted to `React.lazy` + `Suspense`, code-split out of the initial parse (3 async chunks confirmed in dist). The originally-listed `splitChunks` vendor grouping is **WONTFIX**: this is an Electron renderer loaded from `file://` (local disk, no network, no HTTP cache, no return-visit), so splitting `bundle.js` into a vendor chunk reorganizes bytes on disk without reducing startup parse or total load. The positive-ROI portion (deferring parse via lazy-load) is the part that landed. | DONE | M | HIGH | `src/App.tsx` |
| 4 | God-files >500 LOC — all 5 split into siblings behind a facade (verbatim moves, no behaviour change). **DONE**: `createWindow.ts` 717→434 ([#1428](https://github.com/Jiahui-Gu/ccsm/pull/1428), `ab60c0c`) → `csp.ts`/`contextMenu.ts`/`closeDialog.ts`; `shellRegistry.ts` 686→473 ([#1429](https://github.com/Jiahui-Gu/ccsm/pull/1429), `c395351`) → `shellAppearance.ts`/`shellInput.ts`/`shellTypes.ts`; `log.ts` 637→399 ([#1430](https://github.com/Jiahui-Gu/ccsm/pull/1430), `bc62cdc`) → `logRuntime.ts`/`logState.ts`/`logFormat.ts`/`logRotation.ts`; `mobileRemoteServer.ts` 580→155 ([#1432](https://github.com/Jiahui-Gu/ccsm/pull/1432), `b189692`) → `wsProtocol.ts`/`remoteHttp.ts`/`remoteMessages.ts`/`mobilePage.ts`; `sessionCrudSlice.ts` 622→63 ([#1431](https://github.com/Jiahui-Gu/ccsm/pull/1431), `b20c9da`) → `lib/sessionCrudHelpers.ts`/`sessionCreateSlice.ts`/`sessionMutationSlice.ts`/`sessionArchiveSlice.ts`. `madge --circular` clean after each. | DONE | L | HIGH | various |
| 5 | Session field "shotgun surgery" — adding one field touches slice + types + preload + IPC + db + components + `i18n/locales/{en,zh}.ts` (duplicated locales are the amplifier) | OPEN | M | HIGH | `src/i18n/locales/*` + chain |
| 17 | No Content-Security-Policy — renderer ships no CSP. **DONE** ([#1413](https://github.com/Jiahui-Gu/ccsm/pull/1413), `78bd564`): CSP set via `onHeadersReceived` response header, dev/prod aware | DONE | M | HIGH | `electron/window/createWindow.ts` |
| 18 | `npm audit` (2026-05-29, official registry): 8 prod vulns (1 HIGH, 7 mod). **DONE** ([#1412](https://github.com/Jiahui-Gu/ccsm/pull/1412), `5c8589a`): `npm audit fix` cleared all 8 prod vulns | DONE | S | HIGH | `package-lock.json` |

### P2 — MED impact, medium-small

| ID | Item | Status | Effort | Impact | Location |
|---|---|---|---|---|---|
| 6 | Layering inversion: terminal modules read store state directly — a real cycle existed: `store.ts → sessionCrudSlice → terminal/shellRegistry → store.ts` (shellRegistry statically imported `useStore` for appearance defaults). **DONE** (this PR): broke the `shellRegistry → store` edge via a registered appearance provider (`setShellAppearanceProvider`, store wires it at boot); `madge --circular` now clean. Remaining terminal→store reads are one-directional (permitted). | DONE | S-M | MED | `src/stores/store.ts`, `src/terminal/shellRegistry.ts` |
| 7 | `Sidebar.tsx` had 11 props — extracted `SidebarActionsContext` for the 5 `onOpen*`/`onCreate*` callbacks (now 6 props). **DONE** ([#1411](https://github.com/Jiahui-Gu/ccsm/pull/1411), `399225d`) | DONE | S | MED | `src/components/Sidebar.tsx` |
| 8 | `AGENTS.md` + `CLAUDE.md` missing from repo root — new sessions / contributors lack project-level orientation. **DONE** ([#1416](https://github.com/Jiahui-Gu/ccsm/pull/1416)): added root `AGENTS.md` (broad map) + `CLAUDE.md` (don't-break checklist) | DONE | M | MED | repo root |
| 9 | `docs/README.md:8` references `STATUS.md` — resolved: `docs/status/STATUS.md` exists, link is valid | DONE | S | LOW | `docs/README.md` |
| 10 | `npm audit` blocked by npmmirror registry — workaround: `npm audit --registry=https://registry.npmjs.org/`. Unblocked 2026-05-29; results captured in #18. Permanent fix: added `audit`/`audit:fix` npm scripts that pin the official registry | DONE | S | LOW | `package.json`, `.npmrc` |
| 11 | `webpack.config.js` lacked `performance.hints` / size-limit gate — bundle bloat could land silently. **DONE** ([#1410](https://github.com/Jiahui-Gu/ccsm/pull/1410), `aa342c0`): prod budget warns at 1.6 MiB asset/entrypoint | DONE | S | MED | `webpack.config.js` |
| 12 | `import:scan`, `paths:exist`, `sessionTitles:listForProject` IPC returned/consumed unbounded arrays. **DONE**: defensive hard caps with silent-with-a-warn truncation — `import:scan` ≤2000 sessions, `paths:exist` ≤5000 probes (`electron/ipc/utilityIpc.ts`), `listProjectSummaries` ≤2000 (`electron/sessionTitles/index.ts`). `paths:exist` caps the *work* (slices before the `fs.existsSync` loop); `import:scan` + `listProjectSummaries` cap the *IPC payload* only (the upstream scan / SDK `listSessions` still enumerate the full tree). Caps far above any real workload; only bound pathological/hostile input. No return-shape change — every consumer reads a shorter list as "fewer items", never an error | DONE | M | MED | `electron/ipc/utilityIpc.ts`, `electron/sessionTitles/index.ts` |
| 13 | `sandbox: false` on BrowserWindow (Sentry preload `require` path) — known tracked security debt | OPEN | M | MED | `electron/window/createWindow.ts:353` |
| 22 | ccsm launches every `claude` child process with `--dangerously-skip-permissions` unconditionally (no toggle). Deliberate stance: sessions run through ccsm's own pty pane, where an interactive per-action permission gate would stall the pty on input the UI doesn't surface. Trade-off: claude tool calls (file writes, shell commands) run without per-action confirmation for ALL ccsm sessions, including directories the user didn't explicitly grant blanket trust. Acceptable for a single-maintainer tool; documented here as a conscious stance rather than an implicit default. Revisit if a per-session opt-out is ever wanted. | WONTFIX | S | MED | `electron/ptyHost/entryFactory.ts` |

### P3 — LOW impact / nice-to-have

| ID | Item | Status | Effort | Impact | Location |
|---|---|---|---|---|---|
| 14 | `src/shared/*` exports and preload bridge methods lack consistent JSDoc | OPEN | M | LOW | `src/shared/*`, `electron/preload/bridges/*` |
| 15 | `electron/__tests__/db-hardening.test.ts:172` has `it.todo` placeholder for SCHEMA_VERSION ≥2 migration test — un-block when v2 lands | OPEN | S | LOW | (file) |
| 16 | `vitest.config.ts` lacks `retry: 1` — no flake guard. Currently no observed flakes, so leave as nil-debt; revisit if any case starts to flake | OPEN | S | LOW | `vitest.config.ts` |
| 19 | `npm audit` (2026-05-29, official registry): 3 moderate vulns, all **dev-only** — `uuid` <11.1.1 (buffer bounds) via `sockjs` → `webpack-dev-server`. Not in the production dependency tree (does not ship in the packaged app). Fix requires `npm audit fix --force` (breaking `webpack-dev-server` downgrade), so deferred until a webpack-dev-server major bump clears it cleanly | OPEN | S | LOW | `package-lock.json` (devDeps) |
| 20 | `ci.yml` `paths-ignore: ['**.md', ...]` skipped required status checks for doc-only PRs, but branch protection requires those same checks → doc-only PRs hit a permanent merge deadlock. **DONE** (this PR): removed `paths-ignore` from `ci.yml` so the three required `lint + typecheck + test (*)` contexts always report; doc-only PRs run against the warm `node_modules` cache so the cost is just the cheap lint/type/test pass. | DONE | S | LOW | `.github/workflows/ci.yml` |
| 21 | Reload while the assistant is **mid-stream** silently drops that in-flight turn: the soft SIGINT interrupts generation, claude writes `[Request interrupted by user]` and discards the unfinished reply, so `--resume` rebuilds context without it. This is **by design** at the transcript layer (identical to Esc/Ctrl+C in a normal claude session) — not a flush race, characterised via `scripts/dogfood-jsonl-tail-loss-on-reload.mjs` ([#1449](https://github.com/Jiahui-Gu/ccsm/pull/1449)). The only fix is product-layer: warn / confirm before reload when the active session's assistant is still streaming. | OPEN | S | LOW | `src/stores/slices/sessionRuntimeSlice.ts` (`reloadSession`) |

---

## Done (paid down in audit batch 2026-05-25)

| ID | Item | PR | Merge SHA |
|---|---|---|---|
| D1 | `engines.node` field missing + CI on Node 20 (EOL Apr 2026) | [#1372](https://github.com/Jiahui-Gu/ccsm/pull/1372) | `7093869` |
| D2 | `npm run lint` had no `--max-warnings 0` — 114 dead `eslint-disable` directives accumulated | [#1373](https://github.com/Jiahui-Gu/ccsm/pull/1373) | `a2317b4` |
| D3 | `engines.node` was advisory only — add `engine-strict=true`; fix `e2e.yml` cache key `node20`→`node22` | [#1375](https://github.com/Jiahui-Gu/ccsm/pull/1375) | `f240978` |
| D4 | `pty:input` / `pty:resize` IPC handlers trusted TS signatures — added runtime typeof + range guards + 3 tests | [#1376](https://github.com/Jiahui-Gu/ccsm/pull/1376) | `df461a9` |
| D5 | Coverage thresholds were ~8pp below baseline (silent regression headroom) — tightened to ~3pp | [#1377](https://github.com/Jiahui-Gu/ccsm/pull/1377) | `a426f53` |
| D6 | No `CODEOWNERS` / no debt register | (this PR) | — |

---

## Done (paid down in audit batch 2026-05-29)

| ID | Item | PR | Merge SHA |
|---|---|---|---|
| 11 | `webpack.config.js` lacked bundle-size budget — added prod `performance` gate (warn at 1.6 MiB) | [#1410](https://github.com/Jiahui-Gu/ccsm/pull/1410) | `aa342c0` |
| 7 | `Sidebar.tsx` 11 props → 6 via `SidebarActionsContext` | [#1411](https://github.com/Jiahui-Gu/ccsm/pull/1411) | `399225d` |
| 18 | 8 prod `npm audit` vulns (1 HIGH `tmp`) — cleared via `npm audit fix`; added `audit`/`audit:fix` scripts | [#1412](https://github.com/Jiahui-Gu/ccsm/pull/1412) | `5c8589a` |
| 17 | No Content-Security-Policy — set via `onHeadersReceived` response header (dev/prod aware) | [#1413](https://github.com/Jiahui-Gu/ccsm/pull/1413) | `78bd564` |
| 8 | `AGENTS.md` + `CLAUDE.md` missing from repo root — added both orientation docs | [#1416](https://github.com/Jiahui-Gu/ccsm/pull/1416) | (squash) |
| 6 | Terminal↔store circular dep (`store → sessionCrudSlice → shellRegistry → store`) — broke `shellRegistry → store` edge via registered appearance provider; `madge --circular` clean | [#1418](https://github.com/Jiahui-Gu/ccsm/pull/1418) | `ca7ab2f` |
| 3 | Renderer bundle — lazy-load 3 dialogs via `React.lazy` + `Suspense` (3 async chunks). Vendor `splitChunks` portion closed **WONTFIX** (no value for a `file://` Electron renderer) | [#1417](https://github.com/Jiahui-Gu/ccsm/pull/1417) | `39138a8` |

---

## Done (paid down in audit batch 2026-05-30)

| ID | Item | PR | Merge SHA |
|---|---|---|---|
| 2 | `@anthropic-ai/claude-agent-sdk` 0.2 → 0.3.156 | [#1421](https://github.com/Jiahui-Gu/ccsm/pull/1421) | `db9584a` |
| 4 | God-file split: `createWindow.ts` 717→434 | [#1428](https://github.com/Jiahui-Gu/ccsm/pull/1428) | `ab60c0c` |
| 4 | God-file split: `shellRegistry.ts` 686→473 | [#1429](https://github.com/Jiahui-Gu/ccsm/pull/1429) | `c395351` |
| 4 | God-file split: `log.ts` 637→399 | [#1430](https://github.com/Jiahui-Gu/ccsm/pull/1430) | `bc62cdc` |
| 4 | God-file split: `mobileRemoteServer.ts` 580→155 | [#1432](https://github.com/Jiahui-Gu/ccsm/pull/1432) | `b189692` |
| 4 | God-file split: `sessionCrudSlice.ts` 622→63 | [#1431](https://github.com/Jiahui-Gu/ccsm/pull/1431) | `b20c9da` |
| 20 | `ci.yml` `paths-ignore` deadlocked doc-only PRs against required checks — removed the filter | (this PR) | — |

---

## Audit history

- **2026-05-30 (new debt #21)** — investigated the user-reported "right-click reload loses a bit of tail context" (long assumed a JSONL flush race). Reproduced/characterised against the native `claude.exe` 2.1.146 via `scripts/dogfood-jsonl-tail-loss-on-reload.mjs` ([#1449](https://github.com/Jiahui-Gu/ccsm/pull/1449)): user messages always survive; a completed assistant turn is written as a single atomic JSONL entry and survives `--resume`; only an **in-flight (still streaming)** assistant turn is lost, because the soft SIGINT interrupts generation and claude discards the unfinished reply (`[Request interrupted by user]`). This is **by design** at the transcript layer — not recoverable by a longer `KILL_EXIT_TIMEOUT_MS`. Filed #21 (P3, product-layer mid-stream-reload warning) as the only viable mitigation. PR #1449 corrects the now-known-wrong root-cause comments in `electron/ptyHost/lifecycle.ts` (comments only, no logic change).
- **2026-05-30 (paydown)** — DEBT #4 god-files fully paid down: all 5 files split into siblings behind a facade via verbatim moves — `createWindow.ts` ([#1428](https://github.com/Jiahui-Gu/ccsm/pull/1428), `ab60c0c`), `shellRegistry.ts` ([#1429](https://github.com/Jiahui-Gu/ccsm/pull/1429), `c395351`), `log.ts` ([#1430](https://github.com/Jiahui-Gu/ccsm/pull/1430), `bc62cdc`), `sessionCrudSlice.ts` ([#1431](https://github.com/Jiahui-Gu/ccsm/pull/1431), `b20c9da`), `mobileRemoteServer.ts` ([#1432](https://github.com/Jiahui-Gu/ccsm/pull/1432), `b189692`). One file per PR; each independently reviewed by a fresh cold reviewer + CI-green before the parent merged. `madge --circular` confirmed clean after each. DEBT #2 (SDK 0.2→0.3.156) also DONE ([#1421](https://github.com/Jiahui-Gu/ccsm/pull/1421), `db9584a`). DEBT #1 (Electron 41→42) re-classified **upstream-blocked**: held until the `node-pty`/`better-sqlite3` native ABI rebuild is verified against Electron 42's ABI — not yet actionable. **Process note (new debt → see PR-E / row below):** `ci.yml` uses `paths-ignore: ['**.md', ...]`, so a doc-only PR (e.g. a DEBT.md-only update) skips the required status checks and can never satisfy branch protection — a permanent merge deadlock. Workarounds: merge with `--admin`, or fold the doc change into a code-bearing PR. The repeated branch-protection "head not up to date with base" churn during the god-file batch (each merge forced the trailing PRs to re-run full CI) is the same up-to-date gate; serializing merges newest-ready-first kept it bounded.

- **2026-05-29 (refresh)** — verification pass via `technical-debt` skill. Confirmed still-OPEN: #1 (Electron installed 41.x, latest 42.3.0), #2 (SDK installed 0.2.119, latest 0.3.156), #12 (IPC unbounded arrays, input boundary still validated via `isSafePath`/`fromMainFrame`). `madge --circular` clean (re-confirmed #6 fix holds). Source still 0 TODO/FIXME/HACK; no hardcoded secrets. Corrections to ledger: #4 god-file LOC refreshed (`createWindow.ts` 596→717, `shellRegistry.ts` 650→686, added `log.ts` 637) — files grew since last count. New #19: `npm audit` now shows 3 **dev-only** moderate vulns (uuid→sockjs→webpack-dev-server), distinct from the 8 prod vulns closed in #18; LOW because not in the shipped tree.

- **2026-05-29 (closeout)** — #3 renderer bundle closed out. The lazy-load half (#1417, `39138a8`) is the positive-ROI part and is DONE: 3 dialogs deferred via `React.lazy`/`Suspense`, removing them from the startup parse. The originally-listed `splitChunks` vendor grouping is marked **WONTFIX** — ccsm's renderer loads from `file://` (local disk: no network, no HTTP cache, no return-visit), so a vendor chunk only reorganizes bytes on disk without cutting startup parse or total load. Splitting would add config surface for no measurable user-visible win. #6 merge SHA backfilled (`ca7ab2f`).
- **2026-05-29 (paydown)** — #6 terminal↔store circular dependency. `madge --circular` confirmed a real cycle: `store.ts → stores/slices/sessionCrudSlice.ts → terminal/shellRegistry.ts → store.ts` (shellRegistry statically imported `useStore` to read `scrollbackLines`/`terminalFontSizePx` for `createShell`). Fixed minimally by inverting that one edge: shellRegistry now exposes `setShellAppearanceProvider`, and `store.ts` registers a lazy provider at boot — so the static graph is one-directional (store → terminal). `madge --circular --extensions ts,tsx src/` now reports "No circular dependency found". The `sessionCrudSlice → shellRegistry` (`disposeShell`) edge and other terminal→store reads are permitted one-way reads.
- **2026-05-29 (paydown)** — debt-paydown batch landed 4 items: #11 webpack bundle budget ([#1410](https://github.com/Jiahui-Gu/ccsm/pull/1410)), #7 SidebarActionsContext ([#1411](https://github.com/Jiahui-Gu/ccsm/pull/1411)), #18 npm audit-fix + audit scripts ([#1412](https://github.com/Jiahui-Gu/ccsm/pull/1412)), #17 CSP response header ([#1413](https://github.com/Jiahui-Gu/ccsm/pull/1413)), #8 root AGENTS.md + CLAUDE.md ([#1416](https://github.com/Jiahui-Gu/ccsm/pull/1416)). Remaining HIGH: #1 Electron 41→42, #2 SDK 0.2→0.3, #3 bundle splitChunks (lazy-load half in flight), #4 god-files, #5 shotgun surgery.
- **2026-05-29** — refresh via `technical-debt` skill. Still 0 TODO/FIXME/HACK markers. New: #17 missing CSP (HIGH, in flight). #9 resolved (STATUS.md exists). #10 unblocked — `npm audit` via official-registry workaround surfaced #18: 8 prod vulns (1 HIGH `tmp`, 7 mod), all `npm audit fix`-able; added `audit`/`audit:fix` scripts.
- **2026-05-25** — full audit via `technical-debt` skill (Anthropic Claude harness). 42 rules across 10 categories. 6 items paid down in batch (D1–D6); see commits in week of 2026-05-25.

## How to update this file

- When you fix an item: move its row to the "Done" table with PR # + merge SHA. Don't delete the row.
- When an audit identifies a new item: add to the appropriate priority section. Cite file:line.
- When an item's impact changes (e.g. a dep becomes abandoned): update the row and add a note in audit history.
- Keep `Effort` honest. If S items keep growing, downgrade your estimates.
- This file is for **discoverable, prioritized** debt. Code smells, ad-hoc improvements, and refactor wishes belong in PR comments or issue tracker, not here.
