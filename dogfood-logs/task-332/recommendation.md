# Task #332 — eslint dependency conflict: recommendation memo

## Root cause (one-liner)
`package.json` pins `eslint@^9.17.0` but `@eslint/js@^10.0.1`, and `@eslint/js@10.0.1` declares `peerDependencies.eslint = "^10.0.0"` — npm 7+ refuses the install without `--legacy-peer-deps`.

## Provenance
The skew was introduced in the **initial commit** `e2da489` (`chore: initial commit`). `git log -S '@eslint/js' -- package.json` shows no later edits to the `@eslint/js` line. At the time the repo was created, `eslint 9.17.0` was the latest stable; `@eslint/js@10.0.1` was almost certainly grabbed via a stale `npm install @eslint/js@latest` or a copy-paste from a newer scaffold. It has been a latent bug ever since — masked because every fresh install used `--legacy-peer-deps` (or older npm) and the lock pinned `eslint@9.39.4`.

Today (2026-04-25): npm `latest` for eslint is **10.2.1**, `maintenance` tag is 9.39.4. ESLint 10 is GA, not pre-release.

## Repo facts
- Uses **flat config** already: `eslint.config.js` at repo root, `import js from '@eslint/js'`, `js.configs.recommended` — no `.eslintrc` anywhere.
- Plugins installed: `@typescript-eslint/{parser,eslint-plugin}@8.58.2`, `eslint-plugin-react@7.37.5`, `eslint-plugin-react-hooks@5.2.0`.
- Plugin peer-dep matrix:
  - `@typescript-eslint/*@8.59.0` → `eslint: ^8.57 || ^9 || ^10` (need a minor bump 8.58 → 8.59).
  - `eslint-plugin-react-hooks@7.1.1` → `^9 || ^10` (need major bump 5 → 7; rule set is the same, repo only consumes `recommended`).
  - `eslint-plugin-react@7.37.5` → `^3..^9.7` — **does NOT yet declare ^10 support**. Will lint fine in practice (it works on flat config + eslint 10 in the wild), but `npm install` will warn / require `--legacy-peer-deps` again unless we wait for a 7.38 with widened peer.
- Local Node = v22.16.0 → satisfies eslint 10's floor of 22.13.0+.
- No transitive dep *requires* `@eslint/js@10`; the only consumer is the `import js from '@eslint/js'` in `eslint.config.js`.

## Option A — upgrade eslint 9 → 10
**Pros:** moves to `latest` tag; fixes root cause; no API changes used by us (we don't author rules; only consume `js.configs.recommended` + plugin rule sets); flat config already in place; new `eslint:recommended` rules (`no-unassigned-vars`, `no-useless-assignment`, `preserve-caught-error`) are net wins.
**Cons:** `eslint-plugin-react@7.37.5` peer is `^9.7`, so we re-introduce a peer-dep ERESOLVE on a different package until upstream widens; new recommended rules may produce a small batch of fresh lint errors to triage; minor bumps to `@typescript-eslint/*` (8.58 → 8.59) and major bump `eslint-plugin-react-hooks` 5 → 7 needed.

## Option B — downgrade `@eslint/js` 10 → 9
**Pros:** smallest diff (one line `"^10.0.1"` → `"^9.39.4"`); zero behavior change (we already run eslint 9.39.4 from the lock); no rule churn; clean `npm install` immediately.
**Cons:** sits on `maintenance` tag; deferred, not solved — same problem the next time anyone bumps via `npm-check-updates`; nothing in the repo actually uses any 10-only feature.

## Option C — pin both to the same family
Same as B (both on 9.x) or same as A (both on 10.x with plugin bumps). Not a distinct path.

## Recommendation: **Option B now, Option A as a tracked follow-up.**

Justification: B is a one-line, zero-risk fix that unblocks every contributor and CI box today; A is the right long-term direction but is gated on `eslint-plugin-react` declaring `^10` peer support (currently still `^9.7`), and bundling a plugin-major + new-rule triage into the same PR turns a 5-minute fix into a multi-hour one. Do B this hour, file follow-up "upgrade eslint to 10 once eslint-plugin-react publishes ^10 peer".

## Effort + risk for Option B
- **Effort:** ~5 min. Edit `package.json` `@eslint/js` `^10.0.1` → `^9.39.4`, run `npm install` (no `--legacy-peer-deps`), commit lockfile.
- **Risk:** essentially zero. The lock already resolves `eslint@9.39.4`; `js.configs.recommended` is identical between 9.39.4 and 10.0.1 for the rules we keep on (we override `no-unused-vars`, `react/*`, etc.). No code changes, no rule changes, no CI changes.
