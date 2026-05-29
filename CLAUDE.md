# CLAUDE.md — Instructions for AI coding agents

CCSM (Claude Code Session Manager) is an Electron + React + TypeScript desktop
app for managing many Claude Code sessions. This file is the short "don't break
things" checklist. For the full architecture and module map, read
[`AGENTS.md`](AGENTS.md).

## Non-negotiable rules

- **npm only — never run pnpm or yarn.** Native rebuild (`scripts/postinstall.mjs`)
  and electron-builder packaging depend on npm. Switching managers breaks the
  build.
- **Node >= 22.** `engines.node` is `">=22.0.0"` and `.npmrc` sets
  `engine-strict=true`, so install hard-errors on older Node.
- **Native modules:** `better-sqlite3` and `node-pty` are rebuilt for
  Electron's ABI by `postinstall`. After dependency or Electron version
  changes, re-run `npm install` so the rebuild happens.
- **Renderer (`src/`) must not import from `electron/`.** It talks to the main
  process only via `window.ccsm` (typed in `src/global.d.ts`, exposed by
  `electron/preload/`). Convention from `docs/mvp-design.md` §15 — keep it.

## Commands you will use

```bash
npm install          # deps + native rebuild for Electron ABI
npm run dev          # webpack-dev-server + Electron (run the app)
npm run typecheck    # tsc --noEmit (renderer + electron)
npm run lint         # eslint, --max-warnings 0 (warnings fail)
npm test             # vitest run
npm run coverage     # vitest with coverage
npm run probe:e2e    # build + Playwright e2e harnesses
```

Before claiming work is done, run `npm run typecheck`, `npm run lint`, and
`npm test`. Markdown files are not linted by eslint.

## Where things live (quick map)

- `src/` — React renderer: `components/`, zustand `stores/` (slices),
  `terminal/` (xterm.js), `i18n/` (en + zh locales).
- `electron/` — main process: `window/` (BrowserWindow + CSP), `ipc/` handlers,
  `preload/bridges/` (the `window.ccsm` surface), `ptyHost/` (node-pty),
  `db.ts` (better-sqlite3).
- `scripts/` — `dev.mjs`, `postinstall.mjs`, e2e/`harness-*`/`dogfood-*` runners.
- `docs/` — `mvp-design.md` (frozen scope), `design-system.md`,
  `status/STATUS.md`; index in `docs/README.md`.

## Working norms

- Track and respect technical debt in [`DEBT.md`](DEBT.md). When you fix a
  listed item, update its row (move to Done, add PR + SHA) rather than deleting.
- Add or update tests (in `__tests__/` or `tests/`) for behavioural changes.
- Single maintainer; ownership in [`.github/CODEOWNERS`](.github/CODEOWNERS).
  `main` is the default branch — use PRs, do not commit straight to it.
- Sentry crash reporting is off by default (no hardcoded DSN); opt in via the
  `SENTRY_DSN` env var.
