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
| 1 | Electron 41 → 42 (Chromium CVE patches stop arriving on 41) | OPEN | M | HIGH | `package.json:93` |
| 2 | `@anthropic-ai/claude-agent-sdk` 0.2 → 0.3 | OPEN | M | HIGH | `package.json:38` |
| 3 | Renderer bundle 1.24 MB single chunk — add `splitChunks` + lazy-load `ImportDialog`/`CommandPalette`/`SettingsDialog` | OPEN | M | HIGH | `webpack.config.js` |
| 4 | God-files >450 LOC (non-test): `xtermWarmRegistry.ts` (1346), `usePtyAttach.warm.ts` (771), `electron/shared/log.ts` (637), `sessionCrudSlice.ts` (614), `createWindow.ts` (596), `mobileRemoteServer.ts` (535), `sessionTitles/index.ts` (458) | OPEN | L | HIGH | various |
| 5 | Session field "shotgun surgery" — adding one field touches slice + types + preload + IPC + db + components + `i18n/locales/{en,zh}.ts` (duplicated locales are the amplifier) | OPEN | M | HIGH | `src/i18n/locales/*` + chain |
| 17 | No Content-Security-Policy — renderer ships no CSP (no `http-equiv` meta in `src/index.html`, no `onHeadersReceived` in main). Electron emits "Insecure CSP" warning. With `sandbox:false` (#13) the blast radius of any renderer XSS is wider | OPEN | M | HIGH | `src/index.html:3`, `electron/window/createWindow.ts` |
| 18 | `npm audit` (2026-05-29, official registry): 8 prod vulns (1 HIGH, 7 mod). **HIGH** `tmp` <0.2.6 path-traversal ships in product; `@anthropic-ai/sdk` insecure file perms (fixed by SDK 0.3, see #2); `hono`/`ip-address`/`qs`/`fast-uri`/`brace-expansion` mod (mobile-remote web stack). All `npm audit fix`-able. (6 more in dev-only deps: ws/express/webpack-dev-server — not shipped) | OPEN | S | HIGH | `package-lock.json` |

### P2 — MED impact, medium-small

| ID | Item | Status | Effort | Impact | Location |
|---|---|---|---|---|---|
| 6 | Circular dep `store → sessionRuntimeSlice → xtermWarmRegistry → store` — terminal reaching back into store inverts layering | OPEN | S-M | MED | `src/stores/store.ts` etc. |
| 7 | `Sidebar.tsx` has 11 props — extract `SidebarActionsContext` for the 5 `onOpen*`/`onCreate*` callbacks | OPEN | S | MED | `src/components/Sidebar.tsx:47` |
| 8 | `AGENTS.md` + `CLAUDE.md` missing from repo root — new sessions / contributors lack project-level orientation | OPEN | M | MED | repo root |
| 9 | `docs/README.md:8` references `STATUS.md` that does not exist | OPEN | S | LOW | `docs/README.md` |
| 10 | `npm audit` blocked by npmmirror registry — workaround: `npm audit --registry=https://registry.npmjs.org/`. Unblocked 2026-05-29; results captured in #18. Permanent fix: pin audit registry or add an `audit` script | OPEN | S | LOW | `.npmrc` |
| 11 | `webpack.config.js` lacks `performance.hints` / size-limit gate — bundle bloat can land silently | OPEN | S | MED | `webpack.config.js` |
| 12 | `import:scan`, `paths:exist`, `sessionTitles:listForProject` IPC return unbounded arrays — pagination/caps missing | OPEN | M | MED | `electron/ipc/utilityIpc.ts:125,178`, `sessionIpc.ts:76` |
| 13 | `sandbox: false` on BrowserWindow (Sentry preload `require` path) — known tracked security debt | OPEN | M | MED | `electron/window/createWindow.ts:342` |

### P3 — LOW impact / nice-to-have

| ID | Item | Status | Effort | Impact | Location |
|---|---|---|---|---|---|
| 14 | `src/shared/*` exports and preload bridge methods lack consistent JSDoc | OPEN | M | LOW | `src/shared/*`, `electron/preload/bridges/*` |
| 15 | `electron/__tests__/db-hardening.test.ts:172` has `it.todo` placeholder for SCHEMA_VERSION ≥2 migration test — un-block when v2 lands | OPEN | S | LOW | (file) |
| 16 | `vitest.config.ts` lacks `retry: 1` — no flake guard. Currently no observed flakes, so leave as nil-debt; revisit if any case starts to flake | OPEN | S | LOW | `vitest.config.ts` |

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

## Audit history

- **2026-05-29** — refresh via `technical-debt` skill. No new TODO/FIXME/HACK markers (still 0), no `@deprecated` without plan, CI green on typecheck/lint/e2e as of 2026-05-28. Items #1–#3, #5–#16 still OPEN (verified). #4 god-file LOC counts re-measured (all grew slightly; none dropped off as the prior note implied — `createWindow.ts` and `mobileRemoteServer.ts` are still oversized). **New:** #17 missing CSP (HIGH). **#10 unblocked** via `npm audit --registry=https://registry.npmjs.org/` → **#18**: 8 prod vulns (1 HIGH `tmp`, 7 mod incl. `@anthropic-ai/sdk`), 6 more dev-only.
- **2026-05-25** — full audit via `technical-debt` skill (Anthropic Claude harness). 42 rules across 10 categories. 6 items paid down in batch (D1–D6); see commits in week of 2026-05-25.

## How to update this file

- When you fix an item: move its row to the "Done" table with PR # + merge SHA. Don't delete the row.
- When an audit identifies a new item: add to the appropriate priority section. Cite file:line.
- When an item's impact changes (e.g. a dep becomes abandoned): update the row and add a note in audit history.
- Keep `Effort` honest. If S items keep growing, downgrade your estimates.
- This file is for **discoverable, prioritized** debt. Code smells, ad-hoc improvements, and refactor wishes belong in PR comments or issue tracker, not here.
