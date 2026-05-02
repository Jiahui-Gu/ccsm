# 11 — Monorepo Layout — R4 (Testability + Ship-Gate Coverage)

## P1 — CI matrix §6 is a "sketch" and several testability holes follow

§6 explicitly says "sketch" — ok for spec, but the sketch leaves operationally important things undefined:

1. **`needs: install`** — no `install` job is fully specified (the sketch starts but doesn't show artifacts upload/download). Other jobs need the lockfile + node_modules; how is that shared? Per-job re-install (slow) or upload as cached artifact?
2. **Turborepo cache** — `uses: actions/cache@v4` with what key? Turborepo cache hashes vary between PRs in subtle ways. Pin the key strategy.
3. **`e2e-soak-1h`** and **`e2e-installer-win`** are gated by `[soak]` / `[installer]` in commit message OR schedule. There is no nightly schedule defined (no `cron:` block). Pin.
4. **Self-hosted runner labels** (`self-hosted-win11-25h2-vm`) not provisioned (per chapter 10 R4). Same gap surfaces here.

P1 because phase 11 ship-gates ride on these CI jobs; the sketch leaves room for jobs to never actually run.

## P1 — ESLint forbidden-imports rule (§5) is described but not specified

§5: "The 'forbidden' column is enforced by ESLint's `no-restricted-imports` rule wired into each package's eslint config; CI lint catches violations."

No example config is shown. Three packages × three forbidden-relations (proto can't import others; daemon can't import electron; electron can't import daemon AND can't open SQLite/spawn etc.). The "spawn subprocesses" forbidden in electron is NOT expressible as `no-restricted-imports` (spawn comes from `child_process`, not from a workspace package — and spawning is sometimes legitimate in Electron main, e.g., for the test `claude-sim` launcher in dev). Pin the actual rules; reviewer needs to check whether they're achievable.

## P1 — Versioning via Changesets (§7) has no test that proto + daemon + electron versions don't drift incompatibly

§7: "Single repo-wide version ... synced ... via Changesets." Daemon-Electron compat is via `Hello.proto_version` (chapter 04 §3). Untested invariant: after a Changeset bumps the version, `proto_version` constant in daemon source is bumped too. Otherwise a release ships with daemon claiming a stale proto_version, Electron's `proto_min_version` rejects it, all installs break. Add a tiny CI check: `daemon's PROTO_VERSION constant >= last release's PROTO_VERSION`. Or pin a single source of truth (auto-derive from package version).

## P2 — Workspace dep graph (§3): `@ccsm/proto`'s `gen/` is gitignored AND consumed via package.json `"exports"`. Test for the export resolution exists nowhere

If `gen/ts/index.ts` (or whatever exports point at) is missing because `pnpm run gen` didn't run before consumer build, daemon/electron `import` fails. Pin: turbo.json's `dependsOn: ["^build"]` ensures `gen` runs first — as long as proto's `build` script invokes `gen`. Confirm this is wired and add a test "fresh checkout → `pnpm install && pnpm build` succeeds without manual `gen` step."

## Summary

P0: 0 / P1: 3 / P2: 1
Most-severe: **CI matrix is a sketch with no nightly cron, no self-hosted runner provisioning, and no spec for the install/cache job — phase 11 gates won't run on schedule as written.**
