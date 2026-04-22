# E2E probe runner

`scripts/run-all-e2e.mjs` runs every `scripts/probe-e2e-*.mjs` serially and
prints a summary table. `npm run probe:e2e` builds the app then invokes it.

## Adding a new probe

1. Create `scripts/probe-e2e-<name>.mjs`. Follow the existing pattern (launch
   Electron via `playwright._electron`, drive the UI, exit non-zero on failure).
2. That's it. The runner picks it up by glob on next run; no registration.

Conventions:
- Exit `0` on success, non-zero on failure.
- Keep total runtime under 30 seconds (per-probe timeout — runner SIGKILLs
  beyond that).
- Don't assume parallel safety. Probes run one at a time.

## Skipping a flaky/known-broken probe

Set `E2E_SKIP` to a comma-separated list of names (the part after
`probe-e2e-`, without `.mjs`):

```bash
E2E_SKIP=streaming,tray npm run probe:e2e
```

Skipped probes are reported as `[--]` in the summary and don't affect the
exit code.

## Running a single probe

The per-file scripts still work directly:

```bash
node scripts/probe-e2e-send.mjs
```

## Exit code

The runner exits with the worst child exit code (or `1` if any probe failed
or timed out). CI can consume it as-is.
