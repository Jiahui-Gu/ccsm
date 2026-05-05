# Contributing to ccsm

## Local development

- Use **Node 22.x** for local builds (pinned in `.nvmrc`, currently `22.18.0`). CI runs the same version via `actions/setup-node` with `node-version-file: .nvmrc`.
- Recommended: install [nvm](https://github.com/nvm-sh/nvm) (macOS/Linux), [nvm-windows](https://github.com/coreybutler/nvm-windows), or [fnm](https://github.com/Schniz/fnm), then run `nvm use` / `fnm use` in the repo root — both auto-pick up `.nvmrc`.
- `engine-strict=true` is set in repo `.npmrc`, so `pnpm install` will **abort** (not just warn) on a Node major outside `>=22.0.0 <23`. This prevents the `better-sqlite3` `NODE_MODULE_VERSION` mismatch that hits Node 24 users (Task #445).
- On Windows, native modules require VS Build Tools with C++/CX SDK (full VS 2022, not just BuildTools).
