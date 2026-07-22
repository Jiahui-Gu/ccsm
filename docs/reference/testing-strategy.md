# Testing strategy

This is the written policy the test-suite-cleanup PRs follow (see the
[test-suite audit](../superpowers/specs/2026-07-21-test-suite-cleanup-consolidation-design.md)
for the analysis that produced it). It's a reference, not a rulebook to
enforce with tooling — use judgment, but deviations should be deliberate
and reviewable.

## Four tiers

| Tier | What it covers | Convention |
|---|---|---|
| **unit** | Pure functions/helpers/reducers, no I/O. | Co-located or in `tests/`; no strict suffix requirement today, but prefer `*.unit.test.ts` for new files that sit next to integration/contract tests in the same directory so the tier is visible from the filename. |
| **integration** | Real module chains behind a faked *boundary* (a `node:sqlite` temp file, the `window.ccsm` stub, fake timers) — e.g. `electron/ptyHost/__tests__/lifecycle.test.ts` (PTY spawn/kill/resize race guards) and `electron/notify/sinks/__tests__/dogfood-idle-confirm.evidence.test.ts` (real notify pipeline under fake timers). | `*.int.test.ts` for new files where the distinction from a pure unit test matters. |
| **contract** | Cross-boundary shape/parity: IPC channel parity, IPC payload shape, relay protocol, persisted-state shape — e.g. `tests/contract/ipc-channel-parity.test.ts`, `tests/contract/renderer-main-payloads.test.ts`. Currently thin (4 files in `tests/contract/`) relative to its ROI — expand this tier before adding more E2E. | `tests/contract/*.test.ts`. |
| **e2e** | Real Electron + built renderer, driven via Playwright. Today: hand-rolled `scripts/harness-*.mjs` + `scripts/run-all-e2e.mjs` (see `docs/reference/e2e-runner.md`). A future migration moves this to `@playwright/test` under a top-level `e2e/` project — out of scope for the surgical-consolidation PRs. | `scripts/harness-*.mjs` today; `e2e/*.spec.ts` after migration. |

Existing tests are not being mass-renamed or mass-moved to fit this table —
new tests should follow it; existing files migrate opportunistically when
touched for an unrelated reason, not in a dedicated sweep.

## Mock policy: boundaries only

Mock **only** at process/IO seams: `electron`, `window.ccsm*` (the preload
bridge), `node:sqlite`, `ws`/WebSocket, `react-virtuoso` (jsdom layout gap,
centralized in `tests/setup.ts`). Mocking an internal app module (e.g. a
sibling store slice, a helper in the same package) requires a one-line
comment justifying why the boundary-only rule doesn't apply here — e.g.
isolating a singleton's boot sequence (`store.test.ts` mocking
`persist`/`drafts` to test `hydrateStore()` without a real persisted-state
round-trip).

## Deterministic seams

- **Time**: drive with `vi.useFakeTimers()`; never `setTimeout`-and-hope in
  a unit/integration/contract test.
- **Platform**: pass as an injected argument or prop (`parseCloseAction('ask',
  'win32')`) or a `window.ccsm.window.platform` stub — never assert on the
  real `process.platform` of the machine running CI.
- **Network**: no real network calls in unit/integration/contract tests.
  E2E's fake Anthropic API (`scripts/fixtures/fake-anthropic-api.mjs`) lets
  E2E drive the *real* `claude` binary reproducibly without a live API key;
  keep using it rather than hitting a real endpoint.

## Exact-value tests are valid when protecting a duplicated cross-runtime contract

The general guidance in this doc (and the audit that produced it) is to
avoid change-detector tests that pin an isolated constant's exact literal
value with no behavioral signal beyond "the constant didn't change." That
guidance does **not** apply when the value is duplicated by hand across
runtimes/systems that can't share an import — e.g. a design-token value
that also exists as a CSS custom property, a Tailwind literal, or an inline
`framer-motion` prop in multiple components. In that case the token module
is the intended source of truth for values that are still manually
mirrored elsewhere, and a literal-value assertion is the only test that
catches the token silently drifting from its CSS/inline copies (an
ordering/shape-only invariant would happily let a typo through). See
`tests/lib-motion.test.ts`'s `EASING.standard`/`enter`/`exit` and
`DURATION.fast`/`standard` pins for worked examples — comment the test to
say *why* it's pinning an exact value so a future reader doesn't "clean it
up" back into a shape-only check.

## Deletion requires a named, already-green replacement

Never delete a test because "the rest of the suite should catch it." Before
deleting file A in favor of file B:

1. Diff every assertion in A against B.
2. Port every case in A that B doesn't already cover.
3. Run B and confirm it's green with the ported cases actually exercising
   the behavior (not accidentally vacuous).
4. Only then delete A.

If A and B are not exact overlaps and full parity can't be established
without expanding scope beyond the current change, leave both in place and
record the partial-overlap finding for a follow-up PR instead of deleting.

## Coverage floors are monotonic

The v8 coverage gate (`vitest.config.ts` thresholds: lines 81 / functions 81
/ branches 70 / statements 79) only ever goes up or stays flat across a PR.
A PR that lowers any of the four numbers needs an explicit, reviewed reason
in the PR description — it is never an incidental side effect of a test
consolidation or rewrite.

## No retries for deterministic Vitest tests

Unit/integration/contract tests run in Vitest are expected to be
deterministic — no `retry` config, no flake tolerance. A test that needs a
retry to pass is a bug in the test (or the code), not a candidate for a
retry knob. Retries are an **E2E-tier** concept (real Electron cold-start,
real subprocess timing) and belong to the future `@playwright/test`
migration's `retries: 2` CI config, not to this project's Vitest config.
