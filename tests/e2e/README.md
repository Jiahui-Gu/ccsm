# tests/e2e — L8 probe harness

This directory hosts end-to-end probes for the v0.3 daemon-split work (L8 surface). Drop a probe file at `tests/e2e/probes/<name>.probe.test.ts` and it will be auto-discovered by `tests/e2e/run-all.ts` (invoked via `npm run e2e`); each probe is executed serially via `tsx`, results are printed in a one-line-per-probe summary, and any non-zero probe exit causes the harness to exit non-zero. Probes are plain TypeScript files that own their own setup/teardown (spawn daemon, open IPC, etc.) and signal failure with a thrown error or `process.exit(1)`.
