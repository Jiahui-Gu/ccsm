# R5 review — 11-monorepo-layout.md

## P0
(none)

## P1

### P1-11-1. `tools/lint-no-ipc.sh` mentioned in §2 but its CI wiring is in chapter 08 / 12
Chapter 08 §5h declares `npm run lint:no-ipc` script; chapter 12 §4.1 sources `tools/lint-no-ipc.sh`. Chapter 11 §2 lists `tools/lint-no-ipc.sh`. Pick which one is canonical (suggest: tools/ + npm script wraps it). See cross-chapter P0-08-1.

### P1-11-2. Workspace dep graph diagram lists `@ccsm/proto`, `@ccsm/daemon`, `@ccsm/electron`
Chapter 04 §1 says proto package is at `packages/proto/` with no scoped name shown there. Chapter 11 §2 names it `@ccsm/proto`. Consistent. ✓

### P1-11-3. Generated proto code path
§3 "pnpm symlinks `node_modules/@ccsm/proto` to `packages/proto`, which exposes its `gen/ts` output via its `package.json` `"exports"` field". `gen/` is gitignored (§2). CI build order: `pnpm --filter @ccsm/proto run gen` MUST run before any consumer build. Turborepo `dependsOn: ["^build"]` only works if `gen` is in the consumer chain. §4 turbo.json shows `"build": { "dependsOn": ["^build"] }` and `"gen": { "outputs": ["gen/**"] }` separately — but `gen` is not part of the dep chain of `build`. Pin: either include `gen` as a dependency of `build` or document that `pnpm run gen` is invoked at workspace root before `pnpm run build`.

CI sketch (§6) does `proto-gen-and-lint` as a job that other jobs `needs:`. OK at CI level. But local-dev `pnpm run build` from a fresh checkout will fail because gen hasn't run. Document the local-dev bootstrap.

### P1-11-4. ESLint `no-restricted-imports` rule
§5 mentions it. No actual rule body shown. Rule MUST disallow:
- `@ccsm/electron` from importing `@ccsm/daemon` and vice versa.
- `@ccsm/proto` from importing anything internal.

A reviewer / downstream worker can't verify a missing rule. Inline the rule snippet in §5 or add a sub-section.

### P1-11-5. `e2e-soak-1h` job opt-in mechanism
§6 "if: github.event_name == 'schedule' || contains(github.event.head_commit.message, '[soak]')". Opt-in via commit message is fine. But chapter 12 §4.3 says "Non-blocking for PRs (regressions caught the next morning); blocking for release tags." The CI sketch doesn't have a "block on release tag" wire. Add `|| github.ref_type == 'tag'` to the if.

### P1-11-6. Vague verbs
- §1 "great deps" "fast install" — marketing-speak; pinned by table.
- §2 "fast and deterministic" — fine.

### P1-11-7. `Changesets` mentioned in §7
§7: "We pick **Changesets**". Chapter 13 phase 0 acceptance criteria don't list Changesets setup. Add to phase 0.

## Scalability hotspots

### S1-11-1. Turborepo cache key
§6 mentions `actions/cache@v4` for Turborepo cache. No cache key strategy. Turborepo uses file content hashing internally; CI cache key needs `pnpm-lock.yaml` hash + `turbo.json` hash. Pin.

## Markdown hygiene
- §2 directory tree: long lines OK, used backticks-comment style.
- §6 YAML block tagged `yaml`. Good.
- §4 code block tagged `json` for turbo.json — good.
