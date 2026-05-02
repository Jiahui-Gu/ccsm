# Developing CCSM

## Local environment = CI

Goal: when you run tests locally, they should resolve the **exact same** dependency tree and run on the **exact same** Node version that CI uses. No more "works on my machine".

### One-time setup

1. Install nvm (or [nvm-windows](https://github.com/coreybutler/nvm-windows) on Windows).
2. From the repo root:

   ```bash
   nvm install      # reads .nvmrc
   nvm use          # activates that exact version (currently 22.18.0)
   ```

3. Install dependencies with strict lockfile resolution:

   ```bash
   npm ci --legacy-peer-deps
   ```

   **Do NOT** run `npm install` casually — it can drift the lockfile.

### Before pushing a PR

Simulate CI exactly:

```bash
npm run test:ci
```

That runs `rm -rf node_modules && npm ci && npx vitest run` — same install + test loop CI uses.

### Adding or upgrading a dependency

1. `npm install <pkg>` — `.npmrc` has `save-exact=true`, so it pins the exact version (no `^` / `~`).
2. Commit BOTH `package.json` AND `package-lock.json` in the same commit.
3. Don't bypass `engines.node` — if you need a newer Node, bump `.nvmrc` and `daemon/.nvmrc` together.

### Why this matters

The CI test step previously broke because:

- `.nvmrc` pinned Node 22.11.0 — too old to support `require()` of an ESM module.
- A jsdom transitive dep (`html-encoding-sniffer@6.0.0`) does `require()` of an ESM-only package (`@exodus/bytes`).
- Node 22.12+ added `require(esm)` by default, which fixes the worker bootstrap.

After bumping `.nvmrc` to 22.18.0, freezing the lockfile (no carets), and forcing `npm ci` everywhere, local resolution and CI resolution are guaranteed identical.

### Engines

`package.json` declares `"engines.node": ">=22.12.0"`. Local dev on Node 22 or Node 24 both work; CI is pinned to 22.18.0 via `.nvmrc`.
