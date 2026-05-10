# cloud-e2e

Standalone Playwright harness that exercises the **deployed** cloud SPA at
`https://ccsm-worker.jiahuigu.workers.dev` end-to-end. Built for Task #82 so manager (or any
maintainer) can verify "real users on two machines" scenarios without
hand-clicking a browser.

## Why standalone (not under `packages/`)

`pnpm-workspace.yaml` only globs `packages/*`. Keeping this tool outside
the workspace means:

- Installing `@playwright/test` and downloading the Chromium binary does
  not touch the monorepo lockfile (avoids hot-file mutex contention when
  manager runs it ad-hoc).
- `pnpm install` at the repo root never recurses here, so the heavy browser
  download only happens when a maintainer explicitly opts in.

## Setup

```bash
cd tools/cloud-e2e
pnpm install        # or: npm install
pnpm install:browsers   # downloads Chromium (~150 MB, one-time)
```

## Run

```bash
cd tools/cloud-e2e
pnpm test                       # headless, default base = https://ccsm-worker.jiahuigu.workers.dev
pnpm test:headed                # eyeballs mode for debugging
CCSM_CLOUD_BASE_URL=https://my-preview.pages.dev pnpm test  # custom origin
```

Failure artifacts:

- `test-results/` — per-test trace.zip + screenshot + video on failure.
- `playwright-report/` — HTML report (`npx playwright show-report` to view).

Both are gitignored.

## Specs

### `specs/two-tab-pairing.spec.ts`

Opens **two browser contexts** (each context = isolated cookies + storage,
so it simulates two physically distinct machines), navigates each to `/`,
clicks New Session, asserts the WS reaches `data-ws-state="open"`, types a
unique `echo cloud-e2e-<uuid>`, and asserts that:

1. Both tabs get **distinct** sids.
2. Each tab's `terminal-pane` contains its own uuid.
3. Neither tab contains the other tab's uuid (no cross-contamination).

This is the acceptance test for **R-27** (multi-client cloud pairing).
Before R-27 lands, the second tab is expected to fail (one tab will time
out waiting for `data-ws-state="open"` or the wrong uuid will appear in
the wrong terminal). After R-27, both tabs go green.

## Maintenance

Selectors mirror `packages/smoke/tests/s3-happy-path.spec.ts`. If that
spec changes selectors, update this one too — they target the same
`@ccsm/ui` `data-testid`s (`session-list`, `sidebar-new-session`,
`terminal-pane`, `Terminal input`).
