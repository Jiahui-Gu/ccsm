# pkg-ESM-interop spike (Task #1078, v0.4 T04)

This directory is a throwaway scaffold to verify whether `@yao-pkg/pkg` can
ingest the generated ESM Connect stubs in `gen/ts/ccsm/v1/` and produce a
working single-file executable.

It is intentionally **not** wired into the daemon build. It exists only so
the spike is reproducible.

See `docs/spikes/2026-05-pkg-esm-connect.md` for the verdict and
recommendation.

## Repro

```bash
cd daemon/spike-pkg-esm
npm install
npm run build         # tsc -> dist/entry.js (ESM)
npm run pkg           # @yao-pkg/pkg dist/entry.js --targets ...
./out/spike-<host-target>     # should print the CcsmService descriptor name
```
