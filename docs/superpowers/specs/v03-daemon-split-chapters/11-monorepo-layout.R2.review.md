# R2 (Security) review — 11-monorepo-layout

## P1

### P1-11-1 — Generated proto code is gitignored and built per-CI-run; supply-chain risk via remote buf plugins

§4: `buf.gen.yaml` references `remote: buf.build/bufbuild/es:v1.10.0` and `remote: buf.build/connectrpc/es:v1.4.0`. Remote plugins are pulled at codegen time from `buf.build`. If an upstream buf plugin is compromised or version-pinned-by-tag-but-mutated, every CI run pulls fresh malicious codegen output that is inserted directly into the daemon's RPC layer. Mitigations:
- Pin to digest, not version tag.
- Or use local plugins (`@bufbuild/protoc-gen-es` from npm with pinned lockfile).
- Or commit the generated code to the repo and run a lint that compares fresh-gen vs committed (catches drift / supply-chain swaps).

Spec currently mandates "gen/ is gitignored" which removes the diffability that would catch a malicious change.

### P1-11-2 — `pnpm-lock.yaml` is committed but spec doesn't mandate `--frozen-lockfile` for installer build steps

§6 CI sketch uses `pnpm install --frozen-lockfile` for the install step, good. But §1 build steps invoked from `packages/daemon/scripts/build-sea.sh` etc. are not pinned to the same. A build that runs `pnpm install` without `--frozen-lockfile` (e.g., a developer running locally for a release build) can inadvertently bump deps and ship a different binary than CI tested. Mandate `--frozen-lockfile` for every install step in every script.

## P2

### P2-11-1 — ESLint `no-restricted-imports` enforces inter-package boundaries; not equivalent to runtime sandboxing

§5: ESLint catches forbidden imports at lint time. A determined developer can `eval(require('fs').readFileSync(...))` from `@ccsm/electron` to reach into daemon files at runtime. Static lint is fine for accidents; spec should clarify that the boundary is convention, not enforcement.

### P2-11-2 — `tools/lint-no-ipc.sh` lives in `tools/` outside any package; runs unsanitised grep

Minor: shell-script `grep` over `packages/electron/src --exclude-dir=node_modules --exclude-dir=dist`. If a future symlink in the repo points at `/etc/passwd`, the grep follows it. Use `find -xdev` or explicit file enumeration.

No P0 findings; supply-chain risks are P1, defaults are sane.
