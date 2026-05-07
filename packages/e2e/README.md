# @ccsm/e2e-web

End-to-end test rig for **ccsm**. Built on Playwright (headless Chromium)
with a daemon child-process fixture and a custom screenshot helper that emits
both a `.png` and a `.txt` per snap.

## Why both PNG and TXT

The manager driving this repo (Claude) cannot reliably view rendered pixels.
**All acceptance evidence for ccsm tasks lives here as PNG + TXT pairs.**
The TXT contains page title, URL, visible text, the inventory of
`data-testid` attributes, and any captured console warnings/errors — enough
for the manager to `Read` and verify a feature without a human in the loop.
The PNG stays available for human spot-checks and is uploaded as a CI
artifact.

## Layout

```
packages/e2e/
  fixtures/
    daemon.ts       # spawns ../daemon, parses ready URL+token, exposes as test fixtures
    screenshot.ts   # snap(page, testInfo, name) → { pngPath, txtPath }
  tests/
    smoke.spec.ts   # rig self-test (about:blank, no daemon, no frontend)
  snapshots/        # gitignored; per-test PNG+TXT pairs land here
  playwright-report/
  test-results/
  playwright.config.ts
```

## Local usage

```sh
pnpm -F @ccsm/e2e-web install-browsers   # one-time, ~150MB chromium download
pnpm -r build                        # build daemon + frontend (T3/T5)
pnpm e2e                             # run the suite from repo root
```

The smoke test does NOT need T3 or T5 merged — it only validates the rig
itself. Real product tests (T7) consume the `daemonUrl` / `token` fixtures.

## Daemon fixture contract

```ts
import { test, expect } from '../fixtures/daemon.ts';

test('hits a real daemon', async ({ page, daemonUrl, token }) => {
  await page.goto(daemonUrl);   // already includes ?token=…
  // …
});
```

The fixture spawns `node packages/daemon/dist/index.mjs` (or, in dev,
`node --import tsx packages/daemon/src/index.mts` as a fallback when no
build artifact exists), waits up to 10s for the
`ccsm ready: http://127.0.0.1:<port>/?token=<token>` line on stdout, and
shuts the child down on worker teardown via SIGINT (SIGKILL after 3s grace).

## CI

The `e2e` job in `.github/workflows/ci.yml` runs after `build` on
`ubuntu-latest` only. Windows is opt-in (T12 owns cross-platform stress).
Both `snapshots/` and `playwright-report/` are uploaded as artifacts.

## Boundaries

- This package does NOT import from `@ccsm/daemon` / `@ccsm/frontend-web` —
  it only spawns the daemon binary and drives the frontend over HTTP.
- Visual regression diffing is out of scope (no pixelmatch / percy).
- Vitest browser mode, Cypress, Storybook, and Chromatic are explicitly
  not used.
