# Spike: `@yao-pkg/pkg` × ESM Connect stubs interop

- **Task:** v0.4 T04 (issue/task `#1078`).
- **Spec:** `docs/superpowers/specs/2026-05-01-v0.4-web-design.md` chapter 02 §5 final paragraph; chapter 09 M1 prerequisite.
- **Date:** 2026-05-01.
- **Verdict:** **NO-GO direct, GO via `esbuild → CJS bundle → pkg`** (fallback A below).
- **T05 unblock:** YES — packaging path is concrete and verified end-to-end on Win 11. T05 worker can assume the daemon binary will be produced by the `esbuild → pkg` two-stage pipeline.

## TL;DR

Feeding the generated ESM stubs in `gen/ts/ccsm/v1/*.ts` (compiled to ESM JS via `tsc`) directly to `@yao-pkg/pkg@6.19.0` produces a binary that **fails at startup** with `Cannot find module '@bufbuild/protobuf/codegenv2'`. Root cause is **`yao-pkg/pkg#215`** — pkg's resolver does not honor package.json `exports` subpath maps for CJS fallback. The generated stubs use `import { ... } from "@bufbuild/protobuf/codegenv2"` and `@bufbuild/protobuf` only exposes that path through `exports`, not a physical `codegenv2/index.js`.

Pre-bundling the entry with `esbuild --bundle --platform=node --format=cjs` resolves all `exports` subpaths into a single CommonJS file (`@bufbuild/protobuf` becomes inlined), and pkg ingests the bundled CJS cleanly. The resulting executable runs and prints the expected service descriptor.

## 1. Test setup

Throwaway scaffold at `daemon/spike-pkg-esm/` (kept in the PR for reproducibility, not wired into the daemon build).

```
daemon/spike-pkg-esm/
├── README.md           # repro recipe
├── package.json        # type=module, deps: @bufbuild/protobuf, devDeps: @yao-pkg/pkg, esbuild, typescript
├── tsconfig.json       # ES2022 / ESNext / bundler resolution / outDir=dist
└── src/
    ├── entry.ts        # imports CcsmService + 2 file descriptors, prints them
    └── gen-v1/         # verbatim copy of gen/ts/ccsm/v1/*.ts
        ├── index.ts
        ├── core_pb.ts
        ├── service_pb.ts
        └── ... (8 domain stubs + service)
```

Why `gen-v1/` is a copy and not a relative import:

- `gen/ts/ccsm/v1/index.ts` lives 5 dirs above `daemon/spike-pkg-esm/src/`.
- TS path aliases (`@ccsm/proto-gen/v1`) work for `tsc --noEmit` but pkg/esbuild need a real on-disk module graph.
- Copying inside `src/` lets one `tsc -p tsconfig.json` emit the entire ESM graph into `dist/` without `rootDir` gymnastics.

The entry exercises the runtime descriptor surface (not just types) so a wrongly-stubbed pkg snapshot would crash, not silent-pass:

```ts
import { CcsmService, file_ccsm_v1_core, file_ccsm_v1_pty } from "./gen-v1/index.js";
console.log("[spike-pkg-esm] OK", JSON.stringify({
  serviceTypeName: CcsmService.typeName,           // "ccsm.v1.CcsmService"
  serviceMethodCount: Object.keys(CcsmService.method).length, // 46
  coreFile: file_ccsm_v1_core.proto.name,          // "ccsm/v1/core.proto"
  ptyFile: file_ccsm_v1_pty.proto.name,            // "ccsm/v1/pty.proto"
}));
```

Repro:

```bash
cd daemon/spike-pkg-esm
npm install
npx tsc -p tsconfig.json                                                      # → dist/entry.js + dist/gen-v1/*.js (ESM)

# --- Path A (NO-GO): pkg directly on the ESM emit ---
mkdir -p out
npx pkg dist/entry.js --targets node22-win-x64 --output out/spike-direct-win-x64.exe
./out/spike-direct-win-x64.exe   # → throws "Cannot find module '@bufbuild/protobuf/codegenv2'"

# --- Path B (GO): pre-bundle with esbuild, then pkg ---
npx esbuild dist/entry.js --bundle --platform=node --target=node22 --format=cjs --outfile=dist-bundle/entry.cjs
node dist-bundle/entry.cjs       # → "[spike-pkg-esm] OK {...}"   (sanity)
npx pkg dist-bundle/entry.cjs --targets node22-win-x64,node22-macos-x64,node22-linux-x64 --output out/spike
./out/spike-win.exe              # → "[spike-pkg-esm] OK {...}"
```

Toolchain pins used: Node v24.14.1 (host), pkg base Node v22.22.2 (bundled in `@yao-pkg/pkg@6.19.0`), TypeScript ^5.6, esbuild ^0.28, `@bufbuild/protobuf@2.12.0` (matches the generator pin).

## 2. Outcome — Path A: `pkg` directly on ESM emit

### Build phase (warnings, no error)

```
> Warning Cannot find module '@bufbuild/protobuf/codegenv2' from '...\dist\gen-v1' in ...\dist\gen-v1\core_pb.js
> Warning Cannot find module '@bufbuild/protobuf/codegenv2' from '...\dist\gen-v1' in ...\dist\gen-v1\import_pb.js
... (repeated for each of 9 *_pb.js files)
```

Build still produces `out/spike-direct-win-x64.exe` (~55 MB). Warnings are non-fatal at build time.

### Runtime (fatal)

```
pkg/prelude/bootstrap.js:1756
      throw error;
      ^
Error: Cannot find module '@bufbuild/protobuf/codegenv2'
    ...
    at Function._resolveFilename (pkg/prelude/bootstrap.js:1850:46)
    ...
  code: 'MODULE_NOT_FOUND',
  requireStack: [
    'C:\\snapshot\\dist\\gen-v1\\core_pb.js',
    'C:\\snapshot\\dist\\gen-v1\\index.js',
    'C:\\snapshot\\dist\\entry.js'
  ],
  pkg: true
}
Node.js v22.22.2
```

Pkg has transformed the ESM imports to `require()` calls (per its >=6.13.0 ESM-to-CJS guide), but the `require()` for the **subpath** `@bufbuild/protobuf/codegenv2` cannot resolve because pkg's resolver ignored the `exports` field in `node_modules/@bufbuild/protobuf/package.json` and the package has no physical `codegenv2/index.js` — only `dist/cjs/codegenv2/index.js` aliased through `exports["./codegenv2"].require`.

### Root cause — `yao-pkg/pkg#215`

`@bufbuild/protobuf@2.12.0` `package.json`:

```json
{
  "type": "module",
  "main": "./dist/cjs/index.js",
  "exports": {
    ".":           { "import": "./dist/esm/index.js",            "require": "./dist/cjs/index.js" },
    "./codegenv2": { "import": "./dist/esm/codegenv2/index.js",  "require": "./dist/cjs/codegenv2/index.js" }
  }
}
```

pkg `#215` ("Subpath exports resolved correctly but result discarded for CJS files", filed Feb 2026, **unresolved**) documents three compounding bugs:

1. `follow.ts` gates resolution on `result.isESM` instead of "the exports-aware resolver succeeded", so the CJS variant returned by the exports-aware resolver is discarded.
2. The legacy `resolve` package fallback only understands `main`, not `exports` subpaths.
3. The synthetic-main patching does not handle nested condition objects or subpath exports.

Net effect: any package that uses `exports` subpaths (which `@bufbuild/protobuf` does, and which Connect-ES's `@bufbuild/protobuf/codegenv2` codegen uses) is unreachable through pkg's ESM-to-CJS path. Downgrading to pkg <6.13.0 (pre-ESM-support) is not viable since v0.4 explicitly needs ESM for Connect-ES.

This is a hard, library-level blocker for "feed pkg the generated stubs as-is" — not something that can be worked around by tweaking our code.

## 3. Outcome — Path B: `esbuild → CJS bundle → pkg`

### Build

```
$ npx esbuild dist/entry.js --bundle --platform=node --target=node22 --format=cjs --outfile=dist-bundle/entry.cjs
  dist-bundle/entry.cjs  133.3kb
  Done in 220ms
```

esbuild fully resolves the `exports` map (it has first-class support, since it's the modern web bundler), inlines `@bufbuild/protobuf/codegenv2` into the bundle, and emits a single 133 KB CommonJS file with no remaining `require()` calls into the dependency tree. Sanity-runs under raw Node:

```
$ node dist-bundle/entry.cjs
[spike-pkg-esm] OK {"serviceTypeName":"ccsm.v1.CcsmService","serviceMethodCount":46,"coreFile":"ccsm/v1/core.proto","ptyFile":"ccsm/v1/pty.proto"}
```

### pkg ingest of the bundled CJS

```
$ npx pkg dist-bundle/entry.cjs --targets node22-win-x64,node22-macos-x64,node22-linux-x64 --output out/spike
> pkg@6.19.0
> Fetching base Node.js binaries to PKG_CACHE_PATH
$ ls out/
spike-linux        74,581,006
spike-macos        65,473,342
spike-win.exe      57,797,167
```

No warnings during build. Win 11 host runs the win-x64 artifact:

```
$ ./out/spike-win.exe
[spike-pkg-esm] OK {"serviceTypeName":"ccsm.v1.CcsmService","serviceMethodCount":46,"coreFile":"ccsm/v1/core.proto","ptyFile":"ccsm/v1/pty.proto"}
```

macos/linux artifacts produced (size sane, ~65/75 MB which matches the bundled-Node-runtime+gzip-snapshot pattern); cannot be executed on Win 11 host but were verified by file size + pkg exit code 0. CI matrix legs (per `frag-11-packaging.md` §11.5 step 2) will run each platform's artifact natively.

## 4. Recommendation

**Adopt Fallback A: `esbuild → CJS bundle → pkg` two-stage daemon build.**

### Why this fallback over the others

| Option | Verdict | Notes |
|---|---|---|
| **A. esbuild → CJS bundle → pkg** | **Recommended** | Verified end-to-end on Win 11. Adds ~1 s to the daemon build. Source maps available via esbuild's `--sourcemap` (mitigates pkg's lossiness). Keeps the existing pkg-based shipping pipeline (`frag-11-packaging.md` §11.1 unchanged in shape). |
| B. Ship daemon as bare ESM (no pkg) | Rejected for v0.4 | Forces shipping a full `node_modules/` tree per platform, breaking the "single file per OS" invariant locked in `frag-11-packaging.md` §11.1. Reopens the install-path / signing / `extraResources` glob problems already solved for pkg. |
| C. Node 22 SEA (Single Executable Application) | Defer to v0.5+ | The locked `frag-6-7-reliability-security.md` line 348 already flags "True reproducibility deferred to v0.4 native SEA". SEA is the strategically correct destination but switching now means rewriting the native-rebuild + asset-copy pipeline (`scripts/rebuild-native-for-node.cjs`, `pkg.assets`, the `process.pkg`-vs-`__dirname` dual path in `daemon/src/native.ts`) **plus** designing a fresh signing story. Out of scope for v0.4 M1; Fallback A keeps the pkg-shaped pipeline intact so a v0.5 SEA migration is a one-component swap, not a packaging rewrite. |
| D. Regenerate-at-install (CI-only) | Rejected | Spec §5 already names this as the ultimate fallback if pkg cannot ingest `gen/`. Fallback A is strictly better: same vendoring story, smaller install footprint, no `npm install`-on-end-user-machine attack surface. |
| E. Wait for pkg #215 fix | Rejected | Issue is unresolved 2.5 months in on a fork repo with no assignee. Cannot block M1. |

### Wiring plan for T05 / M1

T05 (`Connect server bind on daemon data socket`) does **not** need to change anything in this spike — it just writes the daemon code. The packaging change lands in T-pkg-build (a follow-up that owns `frag-11-packaging.md` §11.1 wiring):

1. `daemon/scripts/build-with-pkg.ts` (or whatever script lives at the corresponding location post-M1) gains an esbuild step **before** the pkg invocation:

   ```ts
   // pseudocode
   await esbuild.build({
     entryPoints: ['dist-daemon/index.js'],
     bundle: true,
     platform: 'node',
     target: 'node22',
     format: 'cjs',
     outfile: 'dist-daemon-bundle/index.cjs',
     sourcemap: true,
     external: [
       // Native modules — pkg.assets must still ship these as .node files.
       'better-sqlite3', 'node-pty',
       // The in-tree N-API helper — resolved at runtime from path.dirname(process.execPath).
       /* ccsm_native is loaded via absolute path, no need to mark external */
     ],
   });
   ```

   `external` keeps native `.node` modules and any other non-bundleable artifacts at their existing pkg-asset paths (per `frag-11-packaging.md` §11.1 native-rebuild flow); they still ride alongside the binary, not inside the snapshot.

2. `daemon/package.json` `"pkg"` block points at the bundled CJS:

   ```json
   "bin": "dist-daemon-bundle/index.cjs",
   "pkg": {
     "scripts": ["dist-daemon-bundle/index.cjs"],
     "assets": ["native/${PLATFORM}-${ARCH}/*.node", "native/${PLATFORM}-${ARCH}/*.dll"],
     ...
   }
   ```

3. CI build-step ordering becomes: `tsc -p daemon/tsconfig.json` → `esbuild bundle` → `pkg --targets node22-${platform}-${arch}` → output to `daemon/dist/ccsm-daemon-${platform}${ext}`. Total added time: ~1-2 s for esbuild on a ~50-file daemon tree.

4. Source maps: emit `dist-daemon-bundle/index.cjs.map` alongside; ship in CI artifacts but **not** in the installer (size). Crash uploader (Sentry) consumes the map server-side.

5. `frag-11-packaging.md` §11.1 needs a one-paragraph note added about the esbuild pre-bundle — owned by the T-pkg-build worker, not by this spike.

### Honesty caveats

- macOS and Linux pkg artifacts were produced on a Win 11 host and not executed. pkg cross-target build success + matching artifact sizes is a strong signal but **not** a guarantee. The first CI run of T-pkg-build on the macOS / Linux runners will be the real verification; if either fails at startup with a different `MODULE_NOT_FOUND`, the fix is the same shape (add it to esbuild's resolution).
- Native modules (`better-sqlite3`, `node-pty`, `ccsm_native.node`) were not exercised in this spike — the entry only imports protobuf/Connect surface. The native-loading path is already proven in v0.3 (it uses `process.pkg ? path.dirname(process.execPath) : __dirname`) and Fallback A leaves that path untouched, so this is not new risk.
- Local Node is v24; pkg's bundled Node is v22.22.2 (matches the v0.4 daemon target per `frag-11-packaging.md` §11.1 "Targets Node 22"). Spike runs on Node 22 inside the pkg snapshot.

## 5. Files in this PR

- `docs/spikes/2026-05-pkg-esm-connect.md` — this report.
- `daemon/spike-pkg-esm/` — repro scaffold (gitignored build artifacts: `dist/`, `dist-bundle/`, `out/`, `node_modules/`).
- `docs/superpowers/specs/2026-05-01-v0.4-web-design.md` — DAG appendix T04: verdict line appended.
