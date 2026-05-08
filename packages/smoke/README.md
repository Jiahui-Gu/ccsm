# @ccsm/smoke

Local-only S3 cloud-mode happy-path smoke. Not run in CI.

## R-9 v3.A — build vs runtime split (Task #15)

Smoke build (cargo + vite) is split from smoke runtime (spawn `.exe`):

- `pnpm smoke:build` — one-shot release build. Produces:
  - `packages/daemon/dist/index.mjs` (tsc)
  - `packages/frontend-tauri/dist/` (vite)
  - `packages/smoke/.fixtures/cargo-target/release/ccsm-tauri.exe`
    (cargo --release with isolated `--target-dir`)
  - copied to `packages/smoke/.fixtures/bin/ccsm-tauri.exe`
- `pnpm smoke:run` — spawn the prebuilt `.exe`. Does NOT run cargo, vite,
  or `tauri dev`.

The cargo target dir is intentionally isolated from
`packages/frontend-tauri/src-tauri/target/` (the developer's day-to-day
build output). A zombie `ccsm-tauri.exe` holding a file lock under the
user's normal `target/` therefore cannot wedge smoke (LNK1104 root cause —
see project memory `project_smoke_windows_zombie_lock_2026_05_08.md`).

## Workflow

First time on a machine, or after changing product source:

```bash
pnpm smoke:build   # 5-10 min cold; incremental afterwards
```

Day-to-day (test iteration):

```bash
pnpm smoke:run
```

`.fixtures/bin/` and `.fixtures/cargo-target/` are gitignored.
