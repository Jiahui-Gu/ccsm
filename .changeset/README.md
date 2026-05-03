# Changesets

This directory holds [Changesets](https://github.com/changesets/changesets) — small markdown files describing user-visible changes that get rolled into the release notes / version bumps.

## Workflow

```bash
pnpm changeset             # create a new changeset (interactive)
pnpm version-packages      # apply pending changesets: bump versions + sync to packages
pnpm release               # build (turbo) + publish (no-op for private packages)
```

The actual publish target for v0.3 is the Electron installer (not npm) — every workspace package is `private: true` (see spec ch11 §7). Changesets is used to:

1. Drive the root `package.json` `version` (which feeds the Electron installer / auto-update metadata).
2. Generate `CHANGELOG.md` from per-PR changeset files.
3. Mirror the root version into `packages/{daemon,electron,proto}/package.json` via `scripts/sync-version.mjs` so internal `--version` strings agree.

## PROTO_VERSION is independent

The wire-protocol minor (`PROTO_VERSION` in `packages/proto/src/version.ts`) is **not** managed by Changesets. Bump it manually IF AND ONLY IF a `.proto` file changes the wire. CI enforces non-regression via `pnpm --filter @ccsm/proto run version-drift-check` (spec ch11 §7).
