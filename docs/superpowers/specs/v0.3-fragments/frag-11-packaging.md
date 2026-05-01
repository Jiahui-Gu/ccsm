## 11. Packaging

> Replaces §11 of `2026-04-30-web-remote-design.md`.
> P0 items: #9 (extraResources wiring), #10 (daemon code-signing), #11 (NSIS uninstall hygiene — reclaimed from frag-6-7 per round-2 P0-1), #12 (`ccsm_native.node` + every native `.node` ships + signs — round-2 P0-2 / round-3 P0-3 rename).
> Source reviews: `~/spike-reports/v03-review-packaging.md` §3 (MUST-FIX 1, 2, 3); `~/spike-reports/v03-r2-packaging.md` (P0-1, P0-2, P1-3..P1-6, S1, S3); `~/spike-reports/v03-r2-security.md` (P0-S3 SLSA provenance, SH2/SH3); `~/spike-reports/v03-r3-packaging.md` (P0-1 install path, P0-2 secret path, P0-3 native rename, P0-4 postrm HOME bug); `~/spike-reports/v03-r3-lockin.md` (ccsm_native vs winjob); `~/spike-reports/v03-r3-resource.md` (uninstall hygiene dedupe); `~/spike-reports/v03-r3-devx.md` (CF-2 devTarget fence).

**Round-3 install-path lock (manager-decided, applies everywhere in this fragment):**
- Install root is **per-user**: `%LOCALAPPDATA%\ccsm\` on Windows, `~/Library/Application Support/ccsm/` on macOS, `~/.local/share/ccsm/` on Linux. **Never `Program Files`.** electron-builder NSIS is configured `perMachine: false` so the installer drops to `%LOCALAPPDATA%\ccsm\` (no UAC, auto-update writes in-place). NSIS `oneClick: false / allowElevation: true / allowToChangeInstallationDirectory: true` per §11.6 r9 lock. [manager r11 lock: r10 packaging P1-A — §11 head paragraph reconciled with §11.6 r9 oneClick lock; the prior "`oneClick: true` is preserved" wording was stale.]
- Data root = same per-user location (no separate `~/.ccsm/` root). All daemon-owned paths (`daemon.secret`, `daemon.lock`, `data/`, `logs/`, `crashes/`) live under that root.
- In-app surface registry (close-to-tray, reset-data, etc.) is owned by **frag-6-7 §6.8** with numeric priority — frag-11 does NOT redefine. Frag-11 §11.6 owns only the disk-removal mechanics (NSIS macro, postrm script, paths table).

**Toolchain check.** v0.2 ships via `electron-builder@^26.8.1` (`package.json:93,112-216`) — no `forge.config.cjs` exists. All extraResources / signing / publish config goes into the `build` block of root `package.json`. v0.3 keeps electron-builder; no migration to forge.

### 11.1 Daemon binary build (`@yao-pkg/pkg`)

Daemon is a separate Node program that must run **outside** Electron's `app.asar` and outside Electron's bundled Node — same machine, independent process. We compile it to a single platform binary so the installer ships one file per OS, not a `node_modules/` tree.

- Tool: **`@yao-pkg/pkg`** (the maintained fork of vercel/pkg; vercel/pkg is archived). Targets Node 22.
- Workspace: `daemon/` (added in plan Task 1, `2026-04-30-v0.3-daemon-split.md:81`).
- Output: `daemon/dist/ccsm-daemon-${platform}${ext}` where platform ∈ {`win-x64.exe`, `macos-x64`, `macos-arm64`, `linux-x64`} — produced by a fresh CI step before electron-builder runs.
- Native modules (`better-sqlite3`, `node-pty`, **plus the in-tree `ccsm_native.node` from frag-3.5.1 §3.5.1.1** — a single N-API addon carrying the **winjob** (Win JobObject), **pdeathsig** (Linux `prctl(PR_SET_PDEATHSIG)`), and **pipeAcl** (Win named-pipe ACL helper used by frag-6-7 §7.M1) exports, ~150 LOC C++ at `daemon/native/ccsm_native/`) are **not** compiled into the pkg blob (V8 snapshot can't embed `.node`). They are listed as pkg `assets` and shipped next to the binary, then `require()`d at runtime via an absolute path resolver. **Round-3 P0-3**: artifact filename is `ccsm_native.node` per the canonical contract in frag-3.5.1 §3.5.1.1; the prior `winjob.node` name is retired and any tooling reference must be updated.
- **Daemon `dependencies` discipline (round-2 C6)**: every runtime daemon dep (`pino`, `pino-roll`, `@sinclair/typebox`, `@octokit/rest`, `proper-lockfile`, `better-sqlite3`, `node-pty`, plus the native helper bindings) MUST appear in `daemon/package.json` `dependencies`, NOT only in root `dependencies`. `pkg` embeds the resolved `require()` graph from the daemon package's own `node_modules`; workspace-hoisted root deps are invisible to `pkg`. The example below shows only `@yao-pkg/pkg` in `devDependencies` for brevity — the actual `dependencies` block is filled by Task 20.

`daemon/package.json` (new, owned by Task 20):

```json
{
  "name": "@ccsm/daemon",
  "version": "0.3.0",
  "main": "dist/index.js",
  "bin": "dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "rebuild:native": "node scripts/rebuild-native-for-node.cjs",
    "package": "npm run build && npm run rebuild:native && pkg . --out-path dist"
  },
  "pkg": {
    "targets": ["node22-win-x64", "node22-macos-x64", "node22-macos-arm64", "node22-linux-x64"],
    "assets": [
      "native/${PLATFORM}-${ARCH}/*.node",
      "native/${PLATFORM}-${ARCH}/*.dll"
    ],
    "outputPath": "dist"
  },
  "devDependencies": {
    "@yao-pkg/pkg": "^6.6.0",
    "node-gyp": "^10.2.0"
  }
}
```

> **Round-3 P1-7**: `pkg.assets` glob is scoped to a single `${PLATFORM}-${ARCH}` per build invocation (driven by `pkg --targets node22-${PLATFORM}-${ARCH}` in CI per matrix leg) so each per-platform daemon binary embeds **only** its own arch's `.node` files. Cross-platform globbing (`native/**/*.node`) wastes ~5 MB per binary on dead-weight `.node` files the pkg-bundled Node could never load. The CI `Build daemon` step in §11.5 step 2 must invoke pkg with the explicit target matching the runner.

> **Round-3 P1-2/P1-3**: pin `NODE_TARGET` to a single value committed to `daemon/.nvmrc` (e.g. `22.11.0`) and have both `setup-node` (`node-version-file: daemon/.nvmrc`) and the rebuild script read the same file. This eliminates drift between the runner's installed Node, `pkg`'s base binary, and the headers `node-gyp` downloads. Cross-compilation between Win/mac/Linux native modules is unsupported — each matrix leg builds only its own platform's targets.

`scripts/rebuild-native-for-node.cjs` rebuilds **every native artifact** the daemon dlopens — npm-installed (`better-sqlite3`, `node-pty`) AND in-tree (`daemon/native/ccsm_native/`) — against **Node 22 ABI** (NOT Electron's V8 ABI — see review §4 SHOULD-FIX #7 + round-2 P0-2) into `daemon/native/<platform>-<arch>/`:

```js
// daemon/scripts/rebuild-native-for-node.cjs (sketch)
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
// Round-3 P1-3: read the single source of truth from daemon/.nvmrc so
// setup-node, pkg, and node-gyp all agree on one Node patch version.
const NODE_TARGET = fs.readFileSync(path.join('daemon', '.nvmrc'), 'utf8').trim();
const outDir = path.join('daemon', 'native', `${process.platform}-${process.arch}`);
fs.mkdirSync(outDir, { recursive: true });

// 1. npm-installed natives
for (const mod of ['better-sqlite3', 'node-pty']) {
  execSync(
    `npm rebuild ${mod} --runtime=node --target=${NODE_TARGET} --build-from-source`,
    { cwd: 'daemon', stdio: 'inherit' }
  );
  // copy build/Release/*.node + winpty*.dll into outDir
}

// 2. In-tree ccsm_native N-API helper (frag-3.5.1 §3.5.1.1) — round-2 P0-2 / round-3 P0-3
//    Single .node carrying winjob + pdeathsig + pipeAcl exports. Builds on all
//    three platforms; non-Win branches stub out winjob/pipeAcl with ENOSYS but
//    still emit ccsm_native.node so the loader doesn't ENOENT.
execSync(
  `node-gyp rebuild --target=${NODE_TARGET} --runtime=node --dist-url=https://nodejs.org/dist`,
  { cwd: 'daemon/native/ccsm_native', stdio: 'inherit' }
);
fs.copyFileSync(
  path.join('daemon', 'native', 'ccsm_native', 'build', 'Release', 'ccsm_native.node'),
  path.join(outDir, 'ccsm_native.node')
);
```

Daemon entry resolves natives via:

```ts
// daemon/src/native.ts
const nativeRoot = process.pkg
  ? path.join(path.dirname(process.execPath), 'native', `${process.platform}-${process.arch}`)
  : path.join(__dirname, '..', 'native', `${process.platform}-${process.arch}`);
process.env.BETTER_SQLITE3_BINARY = path.join(nativeRoot, 'better_sqlite3.node');
```

Root script: `npm run build:daemon` → `npm -w @ccsm/daemon run package` (added to root `scripts`).

### 11.2 electron-builder `extraResources` wiring

After the daemon binary + native folder are built, electron-builder copies them into the installer payload. **Round-2 S3 correction**: electron-builder does not expand a `${platform}` token in `from` paths; the only supported tokens in `extraResources` paths are `${os}`, `${arch}`, `${ext}`, `${productName}`, `${version}`. The clean approach is to have `before-pack.cjs` stage everything into a fixed dir (`daemon/native-staged/`) and reference that:

```json
"extraResources": [
  { "from": "daemon/dist/ccsm-daemon-staged${ext}", "to": "daemon/ccsm-daemon${ext}" },
  { "from": "daemon/native-staged",                 "to": "daemon/native" }
]
```

`scripts/before-pack.cjs` (new, owned by Task 20a) computes the right per-platform daemon binary + native folder and copies them into the staging paths, then verifies every required artifact is present:

```js
// scripts/before-pack.cjs (new)
const fs = require('node:fs');
const path = require('node:path');
exports.default = async function beforePack(context) {
  const { electronPlatformName, arch } = context;
  // Round-3 P1-1: app-builder-lib's Arch enum is { ia32:0, x64:1, armv7l:2,
  // arm64:3, universal:4 }. v0.3 ships only x64+arm64; universal/armv7l throw.
  const archName = ({ 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' })[arch];
  if (archName === 'universal' || archName === 'armv7l') {
    throw new Error(`[before-pack] arch ${archName} not supported in v0.3 (build x64 + arm64 separately; pkg cannot merge fat Mach-O)`);
  }
  if (!archName) throw new Error(`[before-pack] unknown arch index ${arch}`);
  const map = {
    win32:  { src: 'daemon/dist/ccsm-daemon-win-x64.exe',          dst: 'daemon/dist/ccsm-daemon-staged.exe', natives: `win32-${archName}` },
    darwin: { src: `daemon/dist/ccsm-daemon-macos-${archName}`,    dst: 'daemon/dist/ccsm-daemon-staged',     natives: `darwin-${archName}` },
    linux:  { src: 'daemon/dist/ccsm-daemon-linux-x64',            dst: 'daemon/dist/ccsm-daemon-staged',     natives: `linux-${archName}` },
  }[electronPlatformName];
  if (!fs.existsSync(map.src)) throw new Error(`[before-pack] daemon binary missing: ${map.src}`);
  fs.copyFileSync(map.src, map.dst);

  // Stage native folder
  const srcNatives = path.join('daemon', 'native', map.natives);
  const dstNatives = path.join('daemon', 'native-staged');
  fs.rmSync(dstNatives, { recursive: true, force: true });
  fs.cpSync(srcNatives, dstNatives, { recursive: true });

  // Round-2 P0-2 + round-3 P0-3: every required `.node` MUST exist before electron-builder packs.
  // The single `ccsm_native.node` carries winjob+pdeathsig+pipeAcl per frag-3.5.1 §3.5.1.1.
  const REQUIRED_NATIVES = ['better_sqlite3.node', 'pty.node', 'ccsm_native.node'];
  for (const f of REQUIRED_NATIVES) {
    const p = path.join(dstNatives, f);
    if (!fs.existsSync(p)) throw new Error(`[before-pack] required native missing: ${p}`);
  }
};
```

Electron main resolves the daemon at runtime:

```ts
// electron/daemonClient/spawnOrAttach.ts
const ext = process.platform === 'win32' ? '.exe' : '';
const daemonPath = app.isPackaged
  ? path.join(process.resourcesPath, 'daemon', `ccsm-daemon${ext}`)
  : (() => {
      // Round-3 CF-2 (devx): devTarget() is dev-only and gated behind an
      // explicit env var so a packaged build can never accidentally fall
      // into the dev path. See frag-3.7 §3.7.2.b for env-gate rationale.
      if (process.env.CCSM_DAEMON_DEV !== '1') {
        throw new Error('packaged build expected app.isPackaged=true; set CCSM_DAEMON_DEV=1 only in dev runner');
      }
      return path.join(__dirname, '..', '..', 'daemon', 'dist', `ccsm-daemon-${devTarget()}${ext}`);
    })();
```

`process.resourcesPath` resolves to (per round-3 P0-1, install root is per-user):
- Windows: `%LOCALAPPDATA%\ccsm\resources\daemon\ccsm-daemon.exe`
- macOS: `CCSM.app/Contents/Resources/daemon/ccsm-daemon` (`.app` itself lives under `~/Library/Application Support/ccsm/` per per-user install; user may also drag to `/Applications` — both supported by Gatekeeper)
- Linux: `~/.local/share/ccsm/resources/daemon/ccsm-daemon` (AppImage extracts here; `.deb` / `.rpm` install to the same per-user root via electron-builder's `category=Utility` + post-install symlink in `~/.local/bin`)

Validation: extend `scripts/after-pack.cjs` (today only checks node-pty at `:48-83`) with the explicit post-pack required-files list below — hard-fail the build if any are missing. **[manager r7 lock: r6 packaging P1-A — after-pack.cjs explicit validation list]**

```js
// scripts/after-pack.cjs (extension; per OS)
// Round-3 P0-3: ccsm_native.node carries winjob+pdeathsig+pipeAcl.
// R7 P1-A: explicit list — drift between this list and before-pack.cjs
// REQUIRED_NATIVES + the §11.6.4 helper + §11.2.1 SDK path is a build failure.
// r9 P1-5: SDK entry assertion strengthened — read package.json `module`/`main`
// and assert the resolved JS file exists (not just package.json), on BOTH the
// daemon-side staged copy (primary consumer per r9 P0-1) and the Electron-main
// shim copy (residual sessionTitles consumer).
const REQUIRED_AFTER_PACK = [
  // Daemon binary
  `resources/daemon/ccsm-daemon${ext}`,
  // Every native dlopen'd by the daemon
  'resources/daemon/native/better_sqlite3.node',
  'resources/daemon/native/pty.node',
  'resources/daemon/native/ccsm_native.node',
  // §11.6.4 uninstall helper (Win-only existence; mac/Linux skip)
  ...(process.platform === 'win32' ? ['resources/daemon/ccsm-uninstall-helper.exe'] : []),
  // §11.2.1 claude-agent-sdk staged paths (R7 P0-1; r9 P0-1 dual-consumer)
  // Daemon-side primary copy:
  'resources/daemon/node_modules/@anthropic-ai/claude-agent-sdk/package.json',
  // Electron-main residual copy (sessionTitles shim):
  'resources/sdk/claude-agent-sdk/package.json',
];
// r9 P1-5: also resolve and assert the SDK ESM entry-point JS exists on BOTH
// staged copies. Reading `package.json`'s `module` (preferred for ESM) or
// `main` (CJS fallback) catches the case where before-pack.cjs accidentally
// copies only package.json and skips dist/ — runtime import() would otherwise
// fail with MODULE_NOT_FOUND despite a green after-pack run.
const SDK_PKG_ROOTS = [
  'resources/daemon/node_modules/@anthropic-ai/claude-agent-sdk',
  'resources/sdk/claude-agent-sdk',
];
for (const sdkRoot of SDK_PKG_ROOTS) {
  const pkgPath = path.join(appOutDir, sdkRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) continue;  // covered by REQUIRED_AFTER_PACK above
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const entry = pkg.module ?? pkg.main;
  if (!entry) {
    throw new Error(`[after-pack] SDK package.json at ${pkgPath} has neither module nor main`);
  }
  const entryPath = path.join(appOutDir, sdkRoot, entry);
  if (!fs.existsSync(entryPath)) {
    throw new Error(`[after-pack] SDK entry-point missing: ${entryPath} (resolved from ${pkgPath} ${pkg.module ? 'module' : 'main'} = ${entry})`);
  }
}
// Plus on Win: Get-AuthenticodeSignature on every signtool target (§11.3.1 $targets).
// Plus on mac: codesign -dv --verbose=2 on every codesign target (§11.3.2 loop set).
// Missing or unsigned → throw and fail the electron-builder run.
```

#### 11.2.1 `claude-agent-sdk` packaging contract (R7 P0-1; r9 daemon-primary rewrite)

**[manager r9 lock: r8 packaging P0-1 — daemon owns SDK direct ESM; Electron-main shim residual only]** Per frag-3.7 §3.7.7.b r7 lock ("daemon owns ALL SDK runtime use — agent dispatch, streaming, tool execution, model API calls; new daemon code MUST NOT use the shim; Electron-main `loadSdk` shim retained ONLY for residual session-title/non-daemon SDK calls"), the SDK has **two consumers** in v0.3 with asymmetric primacy:

- **Primary: daemon** — runs as a standalone pkg-bundled Node 22 binary with native ESM support. Imports the SDK directly via `import { ... } from '@anthropic-ai/claude-agent-sdk'`, resolved against the daemon binary's sibling `node_modules/` tree. No shim required (Node 22 ESM is first-class; daemon is not Electron-main CJS).
- **Residual: Electron-main `loadSdk()` shim** — kept only for residual session-title bookkeeping (`getSessionInfo` / `renameSession` / `listSessions` per `electron/sessionTitles/index.ts:59`'s private `loadSdk()` function). Electron-main is CJS so the dynamic-`import()`-via-`new Function` shim stays. Resolves against `process.resourcesPath/sdk/`.

Packaging stages the SDK to **two locations** so each consumer resolves locally:

```json
"extraResources": [
  { "from": "daemon/dist/ccsm-daemon-staged${ext}",        "to": "daemon/ccsm-daemon${ext}" },
  { "from": "daemon/native-staged",                        "to": "daemon/native" },
  { "from": "daemon/sdk-staged",                           "to": "daemon/node_modules/@anthropic-ai/claude-agent-sdk" },
  { "from": "node_modules/@anthropic-ai/claude-agent-sdk", "to": "sdk/claude-agent-sdk" }
]
```

`before-pack.cjs` asserts `node_modules/@anthropic-ai/claude-agent-sdk/package.json` exists, then:
1. Copies the SDK + its resolved transitive `node_modules` closure into `daemon/sdk-staged/` (consumed by the daemon-side `extraResources` row above; the install layout becomes `<resources>/daemon/node_modules/@anthropic-ai/claude-agent-sdk/...` which is a real `node_modules` lookup the pkg-bundled daemon's `require.resolve` walks).
2. Copies the same SDK + closure into `node_modules/@anthropic-ai/claude-agent-sdk/` (already there from `npm install`; the second `extraResources` row stages it under `<resources>/sdk/claude-agent-sdk/` for the residual Electron-main `loadSdk()` shim).
This avoids `MODULE_NOT_FOUND` against hoisted root `node_modules` that won't exist in the packaged app, on either consumer side.

2. **`asarUnpack` rule.** Both consumers resolve from outside `app.asar` (daemon never touches asar at all; Electron-main shim resolves from `process.resourcesPath/sdk/`). For defense-in-depth against a future maintainer accidentally moving the SDK back inside the asar:
   ```json
   "asarUnpack": [
     "node_modules/@anthropic-ai/claude-agent-sdk/**/*",
     "**/*.node"
   ]
   ```
   The `**/*.node` glob is the canonical electron-builder pattern for native addons. The asarUnpack rule applies to both `node_modules/@anthropic-ai/claude-agent-sdk/` (Electron-main shim path, even though it normally resolves via `process.resourcesPath/sdk/`) and the daemon-side staged copy (which is not in asar to begin with — pkg-bundled binaries don't read asar).

3. **Native artifacts in the SDK.** Audit at lock time — `claude-agent-sdk@latest` (npm) ships **no `.node` files** in its dependency closure (verified via `npm ls --all` against the working repo's `node_modules/@anthropic-ai/claude-agent-sdk/` at the version pinned in `package.json`). If a future version adds a native (e.g. tokenizer), it MUST be added to:
   - `before-pack.cjs` `REQUIRED_NATIVES` (so missing → build fails),
   - the §11.3.1 `$targets` signtool array (so it's signed on Win),
   - the §11.3.2 `for node in ...` codesign loop (so it's signed on mac with the daemon entitlements).
   Today the audit is "no `.node`s present"; the spec line above is the contract.

4. **Bundle-size budget contribution.** SDK + transitive deps measure ~6 MB **per consumer copy**, ~12 MB total because both the daemon-side and Electron-main-side staging rows ship a full closure (no dedupe — the two consumers must resolve via independent `node_modules` trees because their require/import resolvers walk from different roots and an asarUnpack-shared copy would couple Electron-main upgrades to daemon resolution). This is folded into the §11.5 installer-size budget below (the 145 MB / 160 MB / 140 MB ceilings include the duplicated SDK).

5. **Load-path resolution (per consumer).** **[manager r9 lock: r8 packaging P0-1 — daemon-primary, Electron-main residual]**

   **Daemon (primary).** Direct ESM, no shim:
   ```ts
   // daemon/src/<wherever the SDK is first used>.ts
   import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
   // resolves via daemon binary's sibling node_modules:
   //   <resources>/daemon/node_modules/@anthropic-ai/claude-agent-sdk/...
   // (pkg-bundled binary's require.resolve walks from path.dirname(process.execPath))
   ```
   No `app.isPackaged` branch — the daemon runs only as a packaged binary in production; in dev (`CCSM_DAEMON_DEV=1`, see §11.2 `devTarget()` gate) the daemon resolves via the workspace's hoisted `node_modules` like any other Node process.

   **Electron-main (residual, sessionTitles only).** The `loadSdk` shim is a private async function inside `electron/sessionTitles/index.ts` (private `async function loadSdk(): Promise<SdkExports>` at `electron/sessionTitles/index.ts:59` on working tip — NOT a standalone module). Per the project memory lock, NEW code MUST go through the daemon path above; the shim is retained ONLY for the existing session-title bookkeeping calls already wired through it. The shim's resolution path under packaged builds:
   ```ts
   // resolution path INSIDE the loadSdk function in electron/sessionTitles/index.ts:59
   // (not a separate file — the patch lives where loadSdk is defined)
   const sdkRoot = app.isPackaged
     ? path.join(process.resourcesPath, 'sdk', 'claude-agent-sdk')
     : path.join(__dirname, '..', '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
   const sdkPkg = require(path.join(sdkRoot, 'package.json'));
   const sdkEntry = sdkPkg.module ?? sdkPkg.main;
   const sdk = await import(pathToFileURL(path.join(sdkRoot, sdkEntry)).href);
   ```
   `process.resourcesPath` is the per-user install root from §11.2 (Win: `%LOCALAPPDATA%\ccsm\resources\`, mac: `CCSM.app/Contents/Resources/`, Linux: `~/.local/share/ccsm/resources/`). Dev branch resolves from hoisted root `node_modules` (no asar in dev). Once the residual sessionTitles calls are migrated to the daemon (post-v0.3 deferred), the entire `electron/sessionTitles/` SDK code path can be deleted along with the second `extraResources` row above.

### 11.3 Code-signing (daemon BEFORE installer)

The installer signature does **not** propagate inward. electron-builder signs the outer `.exe` / `.app` after `extraResources` are copied in, but it does **not** re-sign nested binaries. An unsigned `ccsm-daemon.exe` inside a signed installer triggers SmartScreen on every spawn; an unsigned Mach-O inside a signed `.app` fails `codesign --verify --deep` and Gatekeeper kills the app. So: **daemon binary must be signed before electron-builder packages it**.

Same cert as the app. v0.2 release.yml uses `CSC_LINK` + `CSC_KEY_PASSWORD` for both Win and macOS (`.github/workflows/release.yml:143-144,162-164`); macOS adds `APPLE_ID` / `APPLE_ID_PASSWORD` / `APPLE_TEAM_ID` for notarization (`:145-147`). Daemon reuses all of them.

#### 11.3.1 Windows (`signtool`)

After `npm run build:daemon`, before electron-builder. **Round-2 P0-2** mandates signing every `.node` next to the daemon (an unsigned `.node` dlopen'd from a signed exe trips Defender / SmartScreen on hardened systems). **Round-2 P1-6** says don't hardcode the Win SDK path — let the GHA `windows-latest` PATH resolve `signtool.exe` (Microsoft.WindowsAppSDK + .NET workloads put it on PATH). **Round-2 SH3** adds explicit `signtool verify /pa /v` after sign.

```yaml
# release.yml (new step, runs only on windows-latest, after Build daemon)
- name: Sign daemon binary + every .node (Windows)
  if: matrix.platform == 'win' && steps.secrets.outputs.signed == 'true'
  shell: pwsh
  run: |
    $pfx = "$env:RUNNER_TEMP\csc.pfx"
    [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String("${{ secrets.CSC_LINK }}"))

    # Find signtool on PATH (round-2 P1-6: do NOT hardcode 10.0.22621.0)
    $signtool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
    if (-not $signtool) {
      $signtool = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin\*\x64\signtool.exe" |
                  Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
    }
    if (-not $signtool) { throw "signtool.exe not found" }

    # Sign daemon + every .node we ship (round-2 P0-2)
    $targets = @('daemon\dist\ccsm-daemon-win-x64.exe') +
               (Get-ChildItem -Recurse 'daemon\native\win32-x64\*.node' | ForEach-Object { $_.FullName })
    foreach ($t in $targets) {
      & $signtool sign /f $pfx /p "${{ secrets.CSC_KEY_PASSWORD }}" `
        /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 `
        /d "CCSM Daemon" $t
      # Round-2 SH3: verify and fail the build if signature isn't trusted
      & $signtool verify /pa /v $t
      if ($LASTEXITCODE -ne 0) { throw "signtool verify failed: $t" }
    }
    Remove-Item $pfx
```

Notes:
- Same SHA-256 timestamp server (`http://timestamp.digicert.com`) used implicitly by electron-builder's nsis signer — keeps both signatures verifiable side-by-side.
- `CSC_LINK` is a base64 PFX (electron-builder convention); decode to a temp file, use, delete. Don't keep on disk.
- If `secrets.signed != 'true'` (PR builds, forks): **skip signing, do not fail**. Mirrors v0.2 behavior (release.yml:104-123, "builds MUST continue unsigned if absent").

#### 11.3.2 macOS (`codesign` + hardened runtime + entitlements)

pkg-bundled Node uses V8 JIT, so the daemon needs hardened-runtime entitlements that allow JIT. `build/entitlements.daemon.plist` (new):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
```

Sign step (runs on macos-latest, before electron-builder). **Round-2 P0-2** loops over every `.node` in addition to the daemon Mach-O — `codesign` does not recurse into dlopen'd `.node` files. **Round-2 SH2** moves the keychain unlock password to a `MACOS_KEYCHAIN_PW` secret (avoids fixed `actions` literal appearing in CI logs).

```yaml
- name: Sign daemon binary + every .node (macOS)
  if: matrix.platform == 'mac' && steps.secrets.outputs.signed == 'true'
  shell: bash
  run: |
    # Import cert into a temp keychain (same pattern electron-builder uses internally).
    KC="$RUNNER_TEMP/build.keychain"
    KC_PW="${{ secrets.MACOS_KEYCHAIN_PW }}"   # round-2 SH2
    security create-keychain -p "$KC_PW" "$KC"
    security default-keychain -s "$KC"
    security unlock-keychain -p "$KC_PW" "$KC"
    echo "${{ secrets.CSC_LINK }}" | base64 --decode > "$RUNNER_TEMP/csc.p12"
    security import "$RUNNER_TEMP/csc.p12" -k "$KC" -P "${{ secrets.CSC_KEY_PASSWORD }}" -T /usr/bin/codesign
    security set-key-partition-list -S apple-tool:,apple: -s -k "$KC_PW" "$KC"

    IDENTITY="Developer ID Application: ${{ secrets.APPLE_TEAM_ID }}"
    for arch in x64 arm64; do
      # r9 P1-3: codesign loop iterates BOTH the daemon Mach-O AND the
      # uninstall-helper Mach-O per arch. Spec §11.6.4 requires the helper
      # signed for future tray-driven "Reset CCSM" flows; the previous
      # iteration only covered the daemon binary. Helper Mach-O is produced
      # by pkg-bundling on macOS regardless of whether the v0.3 macOS tray
      # currently invokes it (§11.6.2 documents no native uninstaller today).
      # Sign every .node first (inside-out, round-2 P0-2)
      for node in daemon/native/darwin-$arch/*.node; do
        [ -f "$node" ] || continue
        codesign --force --timestamp --options runtime \
          --entitlements build/entitlements.daemon.plist \
          --sign "$IDENTITY" "$node"
        codesign --verify --strict --verbose=2 "$node"
      done
      # Sign daemon binary AND uninstall-helper Mach-O for this arch.
      for bin in "daemon/dist/ccsm-daemon-macos-$arch" "daemon/dist/ccsm-uninstall-helper-macos-$arch"; do
        [ -f "$bin" ] || continue
        codesign --force --timestamp --options runtime \
          --entitlements build/entitlements.daemon.plist \
          --sign "$IDENTITY" "$bin"
        codesign --verify --strict --verbose=2 "$bin"
      done
    done
    rm "$RUNNER_TEMP/csc.p12"
```

Notarization: the daemon is embedded in `.app/Contents/Resources/daemon/`, so notarytool's submission of the outer `.dmg` (electron-builder's existing flow) covers it — *provided* it was signed first with hardened runtime + same Developer ID. Standalone daemon binary published to GitHub Releases (for the daemon-only updater channel, §11.6) is notarized separately:

```yaml
- name: Notarize standalone daemon binary (macOS)
  if: matrix.platform == 'mac' && steps.secrets.outputs.signed == 'true'
  shell: bash
  run: |
    for arch in x64 arm64; do
      ditto -c -k --keepParent "daemon/dist/ccsm-daemon-macos-$arch" "daemon/dist/ccsm-daemon-macos-$arch.zip"
      xcrun notarytool submit "daemon/dist/ccsm-daemon-macos-$arch.zip" \
        --apple-id "${{ secrets.APPLE_ID }}" \
        --password "${{ secrets.APPLE_ID_PASSWORD }}" \
        --team-id "${{ secrets.APPLE_TEAM_ID }}" \
        --wait
    done
```
(Stapling not applicable to standalone Mach-O; notarization ticket is fetched online by Gatekeeper.) **[manager r7 lock: r6 packaging P1-C — DMG stapling explicitly asserted]** The outer `.dmg` IS stapled (offline Gatekeeper requires it on first launch with no network). electron-builder calls `xcrun stapler staple` automatically only when its `mac.notarize` config is truthy — the spec asserts this explicitly:

```json
"build": {
  "mac": {
    "notarize": { "teamId": "${env.APPLE_TEAM_ID}" }
  }
}
```

Plus an explicit post-build verification in the macOS leg of `release.yml` to fail loud if electron-builder regresses on the implicit stapling:

```yaml
- name: Assert DMG is stapled (R7 P1-C)
  if: matrix.platform == 'mac'
  shell: bash
  run: |
    for dmg in release/*.dmg; do
      xcrun stapler validate "$dmg" || { echo "::error::DMG not stapled: $dmg"; exit 1; }
    done
```

**Standalone-daemon zip naming convention (R7 P1-E).** **[manager r7 lock: r6 packaging P1-E — standalone daemon zip naming]** The `ditto -c -k --keepParent` form above produces zips named `ccsm-daemon-macos-${arch}.zip` whose top-level entry is the per-arch unique Mach-O leaf (`ccsm-daemon-macos-x64` or `ccsm-daemon-macos-arm64`). The naming convention is locked at:
- macOS: `ccsm-daemon-macos-${arch}.zip` (arch ∈ {x64, arm64}); top-level = single Mach-O of the same name.
- Windows standalone (future daemon-only updater): `ccsm-daemon-win-${arch}.zip`; top-level = `ccsm-daemon-win-${arch}.exe`.
- Linux standalone: `ccsm-daemon-linux-${arch}.tar.gz` (no zip — Linux convention); top-level = single ELF `ccsm-daemon-linux-${arch}`.

These names are referenced by the daemon-only updater feed (§11.5(4) deferred sketch) and by the SHA256SUMS / SLSA subject-path globs in §11.4. Any rename requires a spec edit because the updater feed URL pattern is derived from these names.

#### 11.3.3 Linux

No signing infrastructure today (review §4 implicit). Linux daemon binary ships unsigned; integrity via SHA256SUMS only.

### 11.4 SHA256SUMS.txt manifest

Published alongside release artifacts. Auto-updater (Electron + daemon) downloads + verifies before applying.

> **Round-2 S1 correction**: per-platform SHA computation cannot see other platforms' daemon binaries. Compute SHAs in the **merge `release-publish` job** after downloading every platform's artifacts, so one manifest covers everything (installers + standalone daemons + updater feed YMLs).

Per-platform job uploads the raw artifacts (already done by electron-builder + the new `Build daemon` step). Final `release-publish` job (new, `needs: [build]`):

```yaml
- uses: actions/download-artifact@v4
  with: { path: dist-all }   # pulls every matrix leg's artifacts
- name: Compute SHA256 (round-2 S1 — single source of truth)
  shell: bash
  run: |
    cd dist-all
    : > ../SHA256SUMS.txt
    # Installers + daemons + electron-updater feed YMLs (round-2 §6 manifest scope)
    find . -type f \( \
        -name '*.exe' -o -name '*.dmg' -o -name '*.zip' \
        -o -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \
        -o -name 'ccsm-daemon-*' \
        -o -name 'latest*.yml' \
      \) -print0 | sort -z | xargs -0 sha256sum >> ../SHA256SUMS.txt
- uses: softprops/action-gh-release@v2
  with:
    files: |
      SHA256SUMS.txt
      provenance.intoto.jsonl
```

#### 11.4.1 SLSA-3 build provenance (round-2 P0-S3 / security)

SHA256 alone gives integrity vs network corruption, NOT authenticity (round-1 S5, round-2 security P0-S3). A pipeline-secret compromise replaces both binary and `SHA256SUMS.txt` in one push. v0.3 closes this with a free, GitHub-native SLSA-3 attestation — no sigstore key infrastructure required:

```yaml
# In the release-publish job, AFTER all artifacts downloaded
- name: Generate SLSA build provenance
  uses: actions/attest-build-provenance@v1
  with:
    subject-path: |
      dist-all/**/*.exe
      dist-all/**/*.dmg
      dist-all/**/*.AppImage
      dist-all/**/*.deb
      dist-all/**/ccsm-daemon-*
      dist-all/SHA256SUMS.txt
```

`actions/attest-build-provenance@v1` writes a signed `provenance.intoto.jsonl` whose signing identity is GitHub's OIDC root (Fulcio-anchored). The Electron + daemon updater verifies the attestation before swap using **`@sigstore/verify` 1.x** (pure-JS, ~2 MB add to the Electron bundle, handles in-toto SLSA v1.0 bundles via Rekor lookup) — short-circuits the manual-update prompt if attestation absent or signing identity mismatched. The verifier library choice is locked here per round-3 CF-4; the actual verify call lives in frag-6-7 §6.4 step 2. Linux additionally publishes a minisign signature (one-time keypair, `MINISIGN_KEY` secret, ~30 LOC):

```yaml
- name: Sign Linux artifacts (minisign — round-2 P0-S3)
  if: matrix.platform == 'linux'
  run: |
    echo "${{ secrets.MINISIGN_KEY }}" > /tmp/minisign.key
    for f in release/*.AppImage release/*.deb release/*.rpm daemon/dist/ccsm-daemon-linux-x64; do
      [ -f "$f" ] && minisign -S -s /tmp/minisign.key -m "$f"
    done
    shred -u /tmp/minisign.key
```

This makes the v0.4 sigstore plan a strict superset rather than "we shipped insecure on purpose for one release." Public minisign verify key shipped in the installer + documented in release notes.

### 11.5 CI changes (release.yml)

Net diff vs current `.github/workflows/release.yml`:

0. **`actions/setup-node` bumped from `node-version: '20'` to `'22'`** in both `verify` (`:33`) and `build` (`:84`) jobs (round-2 P1-3). **Electron is exact-pinned to `41.3.0`** in root `package.json` `devDependencies.electron` (no caret, no tilde). Electron 41 ships its own Node 20.x at runtime — they are separate processes, no compat conflict. Bumping the toolchain Node lets `@yao-pkg/pkg` resolve its base binary from the local install instead of fetching ~30 MB on every CI run, and matches the daemon's Node 22 ABI target. [manager r7 lock: r6 lockin P0 — Electron version pinned to 41.3.0 per pool-1/package.json check on 2026-05-01.] **[manager r10 lock: T61/PR #704 ESCALATE → exact-pin]** The original r7 lock and r9 recalibration paragraph used a `^41.3.0` caret with "lockfile is the authoritative version-of-record." After T61 (PR #704) shipped, the policy was tightened to **exact pin**: caret/tilde drift on Electron is forbidden because (a) the size baseline file (see "Baseline file format" callout below) records a single `electronVersion` string that must match `package.json` byte-for-byte, and (b) any minor jump within 41.x can add ~3 MB to the installer and silently shift the §11.5(6) budget. Drift is enforced by `scripts/check-electron-pin.cjs` (wired to `npm run check:electron-pin` and `pretest`); the guard fails the build if `devDependencies.electron` is not an exact semver, or if `installer/electron-baseline.json` `electronVersion` disagrees with `package.json`. `package.json` is now the version-of-record; `package-lock.json` and `installer/electron-baseline.json` derive from it.

   **Electron upgrade plan**: v0.3 ships on Electron `41.3.0` (exact). Even patch-level moves within 41.x require an explicit PR that bumps `package.json`, regenerates `package-lock.json`, and updates `installer/electron-baseline.json` (`electronVersion` + `nodeAbi` + `expectedInstallerMB`) in the same commit. The next major bump (Electron 42+) is **deferred until post-v0.3 ship**; bumping is a separate scoped task that must (a) re-verify the `loadSdk()` shim contract for `claude-agent-sdk` (Electron-main is CJS, SDK is ESM-only — see frag-3.5.1 for the canonical lock and shim ownership), (b) re-run the per-`.node` ABI rebuild matrix (`better_sqlite3`, `pty`, `ccsm_native`), (c) re-validate `before-pack.cjs` / `after-pack.cjs` against the new electron-builder + Electron pair. No Electron major bump is in v0.3 scope.

   **Baseline file format (canonical, all baselines unified to JSON).** Every recurring CI baseline in this spec is stored as a single JSON file under either `installer/` (packaging) or the workspace it pertains to. JSON is the canonical schema across all baselines (was previously inconsistent — some prose said YAML, some said free-form). Each baseline file MUST be a single JSON object with: a leading `_comment` string explaining ownership and the spec section that owns it; the measured/recorded values as typed fields (numbers in MB or bytes — never strings; versions as exact semver strings); a `specRef` field pointing back to the owning spec section; and a `policy` field stating the drift-guard rule and the script that enforces it. Reference shape (the Electron baseline shipped by T61 / PR #704 — `installer/electron-baseline.json`):

   ```json
   {
     "_comment": "T61 (#1018) — informational baseline for Electron pinning. Enforcement of installer size lives in T58 (#1015). Recompute on every minor Electron bump per frag-11 §11.5(6).",
     "electronVersion": "41.3.0",
     "nodeAbi": "137",
     "expectedInstallerMB": { "win": 124, "dmg": 140, "appImage": 120, "deb": 105 },
     "specRef": "docs/superpowers/specs/v0.3-fragments/frag-11-packaging.md#11.5",
     "policy": "package.json devDependencies.electron MUST be an exact version (no ^/~). Drift guard: scripts/check-electron-pin.cjs runs in pretest."
   }
   ```

   Other baselines in this spec adopt the same shape (see §11.5(6) installer-size budget, frag-3.4.1 envelope perf baseline, frag-8 SQLite migration baseline, frag-12 traceability index): JSON object, `_comment` + typed fields + `specRef` + `policy`. No YAML, no `.txt`, no per-line key=value files. Any new baseline introduced by a follow-up PR MUST land alongside (or extend) a JSON file matching this shape and a check script that fails CI on drift.

   **SDK loading discipline (cross-ref)**: this section addresses packaging only. For the `loadSdk()` shim contract that Electron-main consumers MUST go through (`claude-agent-sdk` is ESM-only, Electron 41 main is CJS), see frag-3.5.1's loadSdk ownership lock; frag-11 enforces packaging (extraResources + signing) without re-litigating shim discipline.
0a. **`hashFiles`-cache key extended to include `daemon/package-lock.json`** so daemon workspace installs are cached separately from root.
1. **`verify` job (`:26-47`)**: add `npm -w @ccsm/daemon run build` AND `npm -w @ccsm/daemon run test` after `npm test` — daemon TS compiles + daemon unit tests run in pre-flight (round-2 P1-3 + frag-3.5.1 §3.5.1.6 acceptance criteria).
2. **`build` job (`:49-179`)**: new step `Build + sign daemon binary` runs **before** "Package (Linux/macOS/Windows)" steps (`:132-164`):
   - `npm run build:daemon` (compiles + rebuilds natives incl. `ccsm_native.node` + pkg-bundles, no GZip)
   - Sign step per platform (§11.3.1 covers daemon exe + every `.node`; §11.3.2 mac codesigns same set)
   - Then existing `npx electron-builder` step picks up signed binary + signed natives via `extraResources` (which `before-pack.cjs` stages)
3. **Daemon binary uploaded as separate release asset** (for future daemon-only updater) by extending the upload globs at `:170-178` and `:192-200`:
   ```yaml
   files: |
     release/*.exe
     ...
     daemon/dist/ccsm-daemon-*
     SHA256SUMS.txt
     provenance.intoto.jsonl
     *.minisig
   ```
4. **Single tag (`v*`) for v0.3.0** — no separate `daemon-v*` tag yet (review §4 SHOULD-FIX #6: first ship has no install base; reserve `daemon-v*` for v0.3.1+ daemon-only patches). When v0.3.1 ships, a separate matrix that builds **only** the daemon (skips electron-builder) is required — sketched in §11.6 deferred so it isn't a panic-rewrite at v0.3.1 release time.
5. **Cert-missing handling**: if `steps.secrets.outputs.signed != 'true'`, skip daemon-sign step with a `::warning::` (matches v0.2 line `:152-156`). PR builds + forks must continue producing unsigned artifacts; only tag pushes from `Jiahui-Gu/ccsm` get the secrets.
6. **Installer size budget + CI guard (R7 P1-B).** **[manager r7 lock: r6 packaging P1-B — installer size ceiling + CI assertion]** Target sizes (uncompressed installer; measured at release-publish merge job, fail the build over):
   - Windows NSIS `*.exe`: **≤ 145 MB** (Electron 41 ~95 MB + bundled Chromium fonts, daemon pkg ~50 MB incl. Node 22 base + better-sqlite3 + node-pty + ccsm_native, claude-agent-sdk ~6 MB per §11.2.1, uninstall-helper ~5 MB, headroom ~5 MB).
   - macOS DMG: **≤ 160 MB** (Electron Mach-O is fatter; daemon ships per-arch but DMG carries one arch).
   - Linux AppImage: **≤ 140 MB**; `.deb` / `.rpm`: **≤ 125 MB**.

   Standalone daemon binary (`ccsm-daemon-${platform}-${arch}`): **≤ 60 MB** per arch.

   CI assertion in `release-publish` job (after artifacts downloaded, before `gh release upload`):
   ```yaml
   - name: Assert installer size budgets (R7 P1-B)
     shell: bash
     run: |
       declare -A LIMIT_MB=(
         [exe]=145 [dmg]=160 [AppImage]=140 [deb]=125 [rpm]=125
       )
       fail=0
       for f in dist-all/**/*.{exe,dmg,AppImage,deb,rpm}; do
         [ -f "$f" ] || continue
         ext="${f##*.}"
         size_mb=$(( $(stat -c%s "$f") / 1024 / 1024 ))
         lim="${LIMIT_MB[$ext]}"
         echo "$f -> ${size_mb} MB (limit ${lim} MB)"
         if [ "$size_mb" -gt "$lim" ]; then
           echo "::error::$f exceeds ${lim} MB budget (got ${size_mb} MB)"
           fail=1
         fi
       done
       # Standalone daemon binaries
       for f in dist-all/**/ccsm-daemon-*; do
         [ -f "$f" ] || continue
         size_mb=$(( $(stat -c%s "$f") / 1024 / 1024 ))
         if [ "$size_mb" -gt 60 ]; then
           echo "::error::$f exceeds 60 MB budget (got ${size_mb} MB)"; fail=1
         fi
       done
       exit $fail
   ```
   Budget changes require a spec-edit + reviewer sign-off (no silent CI bumps); the rationale is that uncontrolled growth turns the per-user installer into a "do I really want to install this 200 MB thing" friction point that competitors (raw CLI, plain VSCode) don't have. The hard ceilings above are the **outer guard**; the per-platform `expectedInstallerMB` field in `installer/electron-baseline.json` (see §11.5(0) "Baseline file format" callout) is the **inner reference value** and tracks the shipped installer size at the currently exact-pinned Electron version. When Electron is bumped, both `electronVersion` and `expectedInstallerMB` are updated atomically in the same PR; the drift guard in `scripts/check-electron-pin.cjs` fails CI if the baseline JSON disagrees with `package.json`.

### 11.6 NSIS uninstall hygiene (round-2 P0-1 — reclaimed from frag-6-7; round-3 P0-1/P0-2/P0-4 path corrections)

**Why frag-11 owns this.** Round-1 packaging review §3.4 demanded an NSIS `customUnInstall` script. Frag-11 originally punted to "lifecycle / frag-6-7 §3.1," but frag-6-7 covers daemon shutdown RPC + lockfile semantics — it does NOT define an NSIS macro, electron-builder `nsis.include` wiring, `.deb` postrm, or `.rpm` %preun scripts. NSIS scripts + electron-builder config are pure packaging concerns and belong here. Cross-frag rationale (§ Cross-frag rationale at bottom) coordinates the seam with frag-6-7's `daemon.shutdown` RPC and proper-lockfile cleanup (round-2 P1-5).

**Surface vs disk-mechanics split (round-3 X3 dedupe).** The in-app surface that *triggers* uninstall-style cleanup (close-to-tray menu item, "Reset CCSM…" tray menu, post-uninstall toast, etc.) is owned by **frag-6-7 §6.8** with a numeric priority registry. Frag-11 §11.6 owns only the disk-removal *mechanics*: NSIS `customUnInstall`, `.deb` postrm, `.rpm` %preun, the canonical paths table, and the `ccsm-uninstall-helper.exe` orchestration shim. Cross-ref: see frag-6-7 §6.8 for the in-app surface registry; frag-11 §11.6 owns disk-removal mechanics on each OS.

**Per-user install root (round-3 P0-1; r9 oneClick reconciled with working tip).** **[manager r9 lock: r8 packaging P0-2 — keep working-tip `oneClick: false` / `allowElevation: true` / `allowToChangeInstallationDirectory: true` for v0.3 freeze; assisted-mode installer wizard preserved; user can change install dir; no UX migration friction; updater compatible.]** electron-builder NSIS is configured with:

```json
"build": {
  "nsis": {
    "include": "build/installer.nsh",
    "perMachine": false,
    "oneClick": false,
    "allowElevation": true,
    "allowToChangeInstallationDirectory": true,
    "deleteAppDataOnUninstall": false
  }
}
```

Rationale for keeping `oneClick: false` (not flipping to `oneClick: true`):
- **No UX migration friction**: working tip already ships the assisted-mode wizard; v0.3 keeps it. `oneClick: true` would silently strip the install-path picker, the finish page, and the "Run CCSM" checkbox — a UX regression on every existing user's upgrade.
- **`allowToChangeInstallationDirectory: true` survives**: power users who keep `%LOCALAPPDATA%` on a smaller SSD can redirect to a different drive at install time. `oneClick: true` would have forced this off.
- **`allowElevation: true` is harmless under `perMachine: false`**: when the chosen install dir is `%LOCALAPPDATA%` no UAC fires; if the user redirects to an elevation-required path (e.g. `D:\Program Files\ccsm`) UAC prompts and the install proceeds. The `perMachine: false` lock keeps the auto-update-without-UAC contract for the default install location.
- **Updater-compatible**: electron-updater works identically with assisted-mode NSIS; the upgrade-in-place flow in §11.6.5 is unaffected.
- **`customUnInstall` macro stays silent**: with `oneClick: false` the installer/uninstaller has its own first-class UI. The previously-proposed `MessageBox MB_YESNO` in §11.6.1 is dropped (see §11.6.1 below) — modal dialogs from inside `customUnInstall` are inappropriate for the assisted-mode uninstaller flow which already has its own progress UI; it would also auto-default to "No" under silent (`/S`) updater-driven uninstall paths, silently skipping user-data cleanup. The macro now performs the always-safe disk-removal mechanics (kill daemon, drop install root) and leaves opt-in user-data cleanup to a separate user-initiated flow (frag-6-7 §6.8 in-app "Reset CCSM…" surface).

`perMachine: false` makes NSIS install to `%LOCALAPPDATA%\ccsm\` (i.e. `$LOCALAPPDATA\ccsm` in NSIS variables) under the invoking user's profile — no UAC prompt, no `Program Files` write, auto-update can write in-place from a non-elevated Electron process. This is the gate that satisfies frag-6-7 §7.4 T9/T14 "user-only ACL" claim: the install root inherits `%LOCALAPPDATA%`'s default ACL (owner = user, no Authenticated-Users read+execute). On macOS the per-user analog is `~/Library/Application Support/ccsm/`; on Linux `~/.local/share/ccsm/` (AppImage extraction target; `.deb`/`.rpm` install symlinks from the same root via `category=Utility`).

**v0.3 daemon-owned paths** (canonical list — single source of truth; round-3 P0-2 reconciles every row to per-user OS-native roots, NOT `~/.ccsm/`):

| Path (Windows) | Path (macOS) | Path (Linux) | Owner | Cleanup default | Opt-in cleanup |
|---|---|---|---|---|---|
| `%LOCALAPPDATA%\ccsm\resources\daemon\` | `~/Library/Application Support/ccsm/resources/daemon/` | `~/.local/share/ccsm/resources/daemon/` | installer | always (uninstaller wipes install root) | n/a |
| `%LOCALAPPDATA%\ccsm\daemon.lock` | `~/Library/Application Support/ccsm/daemon.lock` | `~/.local/share/ccsm/daemon.lock` | proper-lockfile (frag-6-7 §6.4) | always (stale PID) | always |
| `%LOCALAPPDATA%\ccsm\daemon.secret` | `~/Library/Application Support/ccsm/daemon.secret` | `~/.local/share/ccsm/daemon.secret` | Electron-main (frag-6-7 §7.2) | retained (rollback) | deleted |
| `%LOCALAPPDATA%\ccsm\data\` | `~/Library/Application Support/ccsm/data/` | `~/.local/share/ccsm/data/` | daemon SQLite (frag-8 §8.3) | retained | deleted |
| `%LOCALAPPDATA%\ccsm\logs\` | `~/Library/Application Support/ccsm/logs/` | `~/.local/share/ccsm/logs/` | pino-roll (frag-6-7 §6.6) | retained | deleted |
| `%LOCALAPPDATA%\ccsm\crashes\` | `~/Library/Application Support/ccsm/crashes/` | `~/.local/share/ccsm/crashes/` | crash dumps (security T13) | retained | deleted |
| Named pipe / Unix socket | (same) | (same) | daemon at runtime | always (OS cleans on process exit) | always |

"Opt-in cleanup" = user checked "Also delete my CCSM data" in the uninstaller. On opt-in, the uninstaller removes the per-user data root **recursively** — every daemon-owned path goes (round-2 P1-5: spell out the full set, don't leave subdirs behind). Every row uses the OS-native per-user data root; the legacy `~/.ccsm/` root is retired in v0.3.

#### 11.6.1 Windows: `build/installer.nsh`

**[manager r9 lock: r8 packaging P0-2 — silent macro, no MessageBox; `oneClick: false` assisted-mode installer owns the user-facing UI; user-data opt-in cleanup is an in-app flow per frag-6-7 §6.8, not an NSIS modal.]**

```nsis
; build/installer.nsh — wired via package.json build.nsis.include (round-2 P0-1)
; All paths use $LOCALAPPDATA per round-3 P0-1/P0-2; never $PROGRAMFILES.
; Silent uninstall macro per r9 P0-2: no MessageBox modal. The assisted-mode
; (oneClick: false) NSIS uninstaller has its own UI; modal dialogs from inside
; customUnInstall would either fight that UI or auto-default to "No" under the
; silent (/S) updater-driven path, silently skipping cleanup. User-data opt-in
; deletion is performed in-app via the frag-6-7 §6.8 "Reset CCSM…" surface
; BEFORE the user invokes the uninstaller; this macro only does the always-safe
; mechanics: stop the daemon, release the lockfile.
!macro customUnInstall
  ; 1. Stop the running daemon (frag-6-7 §6.4 daemon.shutdown RPC unreachable post-install).
  ;    The §11.6.4 helper handles graceful-shutdown-via-RPC first; this taskkill
  ;    is the safety net.
  nsExec::ExecToLog 'taskkill /IM ccsm-daemon.exe /F /T'
  Sleep 500   ; let OS release file handles
  Delete "$LOCALAPPDATA\ccsm\daemon.lock"

  ; 2. The install root ($INSTDIR under %LOCALAPPDATA%\ccsm) is wiped by the
  ;    standard NSIS uninstall sequence. User data subdirs (data/, logs/,
  ;    crashes/, daemon.secret) are NOT touched here — they are retained by
  ;    default per the §11.6 paths table. Opt-in cleanup happens in-app
  ;    (frag-6-7 §6.8) before uninstall, OR the user manually deletes
  ;    %LOCALAPPDATA%\ccsm\ post-uninstall (release-notes documented).
!macroend
```

(`deleteAppDataOnUninstall: false` keeps electron-builder's automatic deletion off — user data survives uninstall by default, matching the §11.6 paths table "retained" cleanup default. The full `nsis` block including `oneClick: false / perMachine: false / allowElevation: true / allowToChangeInstallationDirectory: true` is shown above the paths table.)

#### 11.6.2 macOS: no native uninstaller

macOS apps have no uninstaller. The user drags `CCSM.app` to Trash; `~/Library/Application Support/ccsm/` survives. v0.3 ships:

- Release notes that document the manual cleanup steps: drag `CCSM.app` to Trash, then optionally `rm -rf ~/Library/Application\ Support/ccsm` in Terminal.

[manager r7 lock: cut as polish — N1# from r6 feature-parity. The "Reset CCSM…" tray-menu item is DELETED entirely (formerly called `daemon.shutdown` then prompted for `shell.trashItem` of `~/Library/Application Support/ccsm/`). v0.3 macOS tray menu stays at working's `[Show CCSM | Quit]`; uninstall is "drag to Trash" + release-notes guidance only. No new tray entries — v0.3 is refactor scope. The corresponding §6.8 in-app surface contract entry is also deleted by fixer A.]

#### 11.6.3 Linux: `.deb` postrm + `.rpm` %preun

```sh
# build/linux-postrm.sh (electron-builder injects via deb.postrm / rpm.scripts.preUninstall)
#!/bin/sh
set -e
# Round-3 P0-4: postrm/%preun runs as root with HOME=/root, so the legacy
# `${HOME:-/root}/.ccsm` expansion was a tautology that never touched real
# user data. The correct daemon-owned root is per-user (~/.local/share/ccsm)
# and root cannot enumerate users safely from a maintainer script. We do the
# minimum safe thing: kill the running daemon and remove the install-root
# resources (which dpkg/rpm already own). User-data cleanup is documented as a
# per-user manual step.
case "$1" in
  remove|purge)
    pkill -f /usr/lib/ccsm/resources/daemon/ccsm-daemon || true
    if [ "$1" = "purge" ] && [ -n "${SUDO_USER:-}" ]; then
      # Best-effort: if `sudo apt-get purge` was used, we know the invoking
      # user and can clean their data root. If apt was run as root directly
      # (no SUDO_USER), skip — release notes tell the user to run the
      # manual cleanup command below.
      user_home=$(getent passwd "$SUDO_USER" | cut -d: -f6)
      if [ -n "$user_home" ] && [ -d "$user_home/.local/share/ccsm" ]; then
        rm -f  "$user_home/.local/share/ccsm/daemon.lock"
        rm -rf "$user_home/.local/share/ccsm"
      fi
    fi
    ;;
esac
# NOTE: `apt-get purge` without sudo (root login) leaves user data behind by
# design. Release notes include: `rm -rf ~/.local/share/ccsm` for full cleanup.
```

(`.rpm` lacks a "purge" mode — document in release notes that user data survives `rpm -e`; user runs `rm -rf ~/.local/share/ccsm` for full cleanup.)

#### 11.6.4 Daemon-shutdown RPC integration (cross-ref frag-6-7)

The hardstop `taskkill` / `pkill` is the safety net. Preferred path: when the user clicks Uninstall, the v0.3 installer first attempts `daemon.shutdown` over the named pipe / Unix socket (frag-6-7 §6.4) for graceful flush — a 2 s timeout, then fall back to kill. This is implemented in the daemon shutdown RPC (frag-6-7 owns the RPC); the NSIS macro orchestrates it via a tiny helper `ccsm-uninstall-helper.exe` shipped in `extraResources`.

```nsis
; In customUnInstall, before taskkill. Round-3 P1-6: copy the helper to $TEMP
; first so the in-progress uninstall main loop can RMDir $INSTDIR without
; tripping a Windows file-lock on the helper exe.
SetOutPath "$TEMP"
CopyFiles /SILENT "$INSTDIR\resources\daemon\ccsm-uninstall-helper.exe" "$TEMP\ccsm-uninstall-helper.exe"
nsExec::ExecToLog '"$TEMP\ccsm-uninstall-helper.exe" --shutdown --timeout 2000'
Sleep 500
Delete "$TEMP\ccsm-uninstall-helper.exe"
```

The helper is a 2-file Node script that pkg-bundles to ~5 MB; reuses the daemon's RPC client. Owned by Task 20e (new). **[manager r7 lock: r6 packaging P1-F — `ccsm-uninstall-helper.exe` is a first-class signed packaging artifact]** It MUST appear in:
- `before-pack.cjs` staging — copied into `daemon/dist/` next to the daemon binary so electron-builder's `extraResources` `daemon/` glob picks it up at the same `resources/daemon/` path.
- §11.3.1 signtool `$targets` array on Windows — the helper is invoked at uninstall time from `$TEMP`; an unsigned helper trips Defender / SmartScreen on the same hardened machines that would block an unsigned daemon. The §11.3.1 step is amended: `$targets = @('daemon\dist\ccsm-daemon-win-x64.exe', 'daemon\dist\ccsm-uninstall-helper.exe') + (Get-ChildItem -Recurse 'daemon\native\win32-x64\*.node' | …)`.
- §11.3.2 codesign loop on macOS — even though macOS does not ship the helper today (no native uninstaller — see §11.6.2), the cross-platform pkg-bundling produces a Mach-O for completeness and the codesign loop signs it (`codesign … "$bin"` step extended to also iterate `daemon/dist/ccsm-uninstall-helper-macos-$arch`) so future tray-driven "Reset CCSM" flows on mac can shell out to it without Gatekeeper rejection.
- `after-pack.cjs` `REQUIRED_AFTER_PACK` list above (Win-only existence check).

#### 11.6.5 Upgrade-in-place flow (R7 P0-2)

`ccsm-uninstall-helper.exe --shutdown` covers the **uninstall** path; **upgrade-in-place** (electron-updater applying a downloaded `.exe` / `.dmg` over the live install) needs a separate ordering contract because the Electron app's `quitAndInstall` does NOT know about the daemon process (separate PID, separate lockfile). Without an explicit shutdown, the just-upgraded electron-main launches and either (a) attaches to the OLD pre-upgrade daemon via `daemon.lock` (no upgrade actually applied) or (b) NSIS fails to overwrite `ccsm-daemon.exe` due to a Windows file-lock from the running daemon. **[manager r7 lock: r6 packaging P0-2 — upgrade-in-place daemon-shutdown contract]**

Sequence (Electron-main owns the orchestration; cross-ref frag-6-7 §6.4 for the RPC):

1. **Trigger.** `electron-updater` emits `update-downloaded`. Electron-main intercepts BEFORE calling `autoUpdater.quitAndInstall()`.
2. **Graceful shutdown RPC.** Electron-main sends `daemon.shutdownForUpgrade` over the named pipe / Unix socket (RPC defined in frag-6-7 §6.4). Daemon writes a shutdown marker to `<dataRoot>/daemon.shutdown` (so the next-launched daemon can distinguish upgrade-shutdown from crash recovery), flushes pino buffers, releases the `proper-lockfile` lock on `daemon.lock`, then `process.exit(0)`.
3. **Ack window.** Electron-main awaits ack with a **5 s timeout** (longer than the 2 s uninstall timeout in §11.6.4 because upgrade flush includes any in-flight session writes; uninstall is destructive so a quick kill is fine). **[manager r9 lock: r8 packaging P1-1 — explicit ack source]** Ack = the unary RPC reply envelope on the control socket (same channel as `daemon.hello`); the timer starts when Electron-main writes the `daemon.shutdownForUpgrade` envelope and stops on receipt of the reply envelope. Socket-EOF and process-handle wait (`WaitForSingleObject` on Win, `waitpid` on POSIX) are NOT used as ack signals — Win can take 100ms+ to reap a process after exit, falsely tripping the force-kill on slow Windows hosts. If no reply within 5 s after sending `daemon.shutdownForUpgrade`, force-kill via OS process handle (`taskkill /F /PID <daemonPid> /T` on Windows, `process.kill(daemonPid, 'SIGKILL')` on POSIX) per step 4.
4. **Race fallback (no ack within 5 s).** Electron-main force-kills:
   - Windows: `taskkill /F /PID <daemonPid> /T` (the daemon PID is known from frag-6-7 §6.4 spawn handle; `/T` covers any child processes the daemon spawned).
   - macOS / Linux: `process.kill(daemonPid, 'SIGKILL')` (POSIX `kill -KILL`).
   Then unlinks `<dataRoot>/daemon.lock` (proper-lockfile leaves a stale lock dir on `SIGKILL`; the next-start stale-PID recovery in frag-6-7 §6.4 would handle it but unlinking explicitly here is faster and removes the race window described in the next paragraph).
5. **Proceed with upgrade.** Electron-main calls `autoUpdater.quitAndInstall(isSilent=true, isForceRunAfter=true)`. NSIS / DMG / AppImage installer overwrites the install root (no file-lock now that the daemon is dead).
6. **New electron-main spawns fresh daemon.** On post-upgrade launch, the new electron-main runs the standard `spawnOrAttach` flow (§11.2): `proper-lockfile` sees no live PID (we unlinked it; or proper-lockfile's stale-PID recovery handles it), `<dataRoot>/daemon.shutdown` marker is consumed (signalling clean upgrade — no crash-loop counter increment), and the new electron-main spawns the new daemon binary from the new bundle path.

**Why lockfile-only is insufficient.** A naive "lockfile gates new daemons" assumption fails the upgrade case: if the old daemon happens to still hold the lock through the upgrade window (electron-updater swap is fast, but daemon process death from `quitAndInstall`-induced Electron exit is racy on Windows since the daemon is a separate process), the upgraded electron-main will see a held lock and ATTACH to the old daemon instead of spawning a new one — running the OLD bundle's daemon code against the NEW bundle's electron-main. The shutdown-marker + explicit-kill + lock-unlink sequence above closes this race window deterministically: the upgraded electron-main always sees no lock and always spawns from the new bundle.

### 11.7 Out of scope (deferred)

- **SmartScreen reputation reset risk on path / scope change (R7 P1-D; r9 P1-4 mitigation honesty fix).** **[manager r9 lock: r8 packaging P1-4 — no EV-cert lock present in §11.3.x; v0.3 ships with standard OV cert + SmartScreen reputation accepted as known cost; EV cert deferred to v0.3+ post-ship if SmartScreen reset becomes a release-blocker.]** The v0.3 install-path lock moved from `Program Files\ccsm\` (any v0.2 path) to `%LOCALAPPDATA%\ccsm\` and from per-machine to per-user. The SmartScreen reputation tuple is `(signer cert, file SHA, install path, scope)` — changing install path AND scope simultaneously resets reputation, so first-launch users on Windows 10/11 with SmartScreen enabled may see "Windows protected your PC" even though the binary is signed with the same Authenticode cert. Mitigation status: §11.3.x specifies `CSC_LINK` + `CSC_KEY_PASSWORD` (a base64 PFX) without locking cert type, and no EV-policy OID is asserted in CI. The v0.3 release ships with the standard OV (Organization Validation) code-signing cert already in use — SmartScreen reputation reset on first-launch is accepted as a known cost, documented in release notes ("expect a 'Windows protected your PC' prompt the first few times after upgrading; click 'More info' → 'Run anyway'; reputation accrues over ~10k installs"). EV cert acquisition is **deferred to a post-v0.3 release** if SmartScreen reset turns out to be a release-blocker in field telemetry; a future EV migration would add a CI-time `signtool verify /v` assertion that the cert carries an EV-policy OID such as `2.23.140.1.3` and remove the release-notes warning.

- Daemon auto-update channel (separate `daemon-v*` tag, daemon-only updater) — covered in §7 / plan Task 23. v0.3.1+ requires a daemon-only build matrix that skips electron-builder; sketch noted in §11.5(4).
- macOS notarization rate-limit mitigation — accepted as **5 submissions per release** (1 outer `.dmg` via electron-builder + 2 standalone-daemon zips × 2 archs per round-3 P1-5 correction; review §5 OPEN; round-2 packaging S2 confirmed acceptable). All 5 run in parallel `notarytool submit --wait` calls; Apple's documented soft cap is 75/day per Apple ID.
- GPG / sigstore signing of `SHA256SUMS.txt` — round-2 P0-S3 closed via `actions/attest-build-provenance@v1` (SLSA-3) + Linux minisign for v0.3; v0.4 migrates to full sigstore (cosign keyless).
- Truly-reproducible pkg builds (byte-identical between runs) — defer to v0.4 native SEA, which produces deterministic single-static binaries by Node design. v0.3 ships with `pkg` (no GZip) and SHA256+SLSA as the integrity story; the reproducible-build CI step in frag-6-7 §7.3 / Task 26 is demoted to "produce + archive SHA256, do not require byte-identical re-runs" (round-2 P1-4 option 1+3).

---

## Plan delta

Insert after plan Task 20 (`2026-04-30-v0.3-daemon-split.md:1474`) and before Task 21 (`:1529`); update Task 24 (`:1628`) accordingly.

- **Task 20 (existing) — `pkg`-bundle the daemon**: keep, but expand step 3 to explicitly rebuild natives against **Node 22 ABI** (`npm rebuild ... --runtime=node --target=22.x`, version pinned via `daemon/.nvmrc` per round-3 P1-3) into `daemon/native/<platform>-<arch>/`, NOT reuse Electron-ABI copy. Also rebuild the in-tree `ccsm_native.node` (single addon carrying winjob+pdeathsig+pipeAcl, frag-3.5.1 §3.5.1.1) in the same loop (round-2 P0-2 / round-3 P0-3 rename). Drop `--compress GZip` (round-2 P1-4). Fill `daemon/package.json` `dependencies` with every runtime dep — no workspace hoisting (round-2 C6). +1.5h.
- **Task 20a (new) — electron-builder `extraResources` + `beforePack` wiring** (§11.2): add staged-dir `extraResources` block (round-2 S3 token-fix) to `package.json` `build`; add `scripts/before-pack.cjs` to select per-platform daemon binary AND validate every required `.node` (`better_sqlite3`, `pty`, `ccsm_native`); extend `scripts/after-pack.cjs` to verify daemon + natives present. +3h.
- **Task 20b (new) — Windows signtool integration** (§11.3.1): add sign step to release.yml; loop over daemon exe + every `.node` (round-2 P0-2); use PATH-discovered signtool with newest-SDK fallback (round-2 P1-6); add `signtool verify /pa /v` (round-2 SH3); PR-build skip path. +2.5h.
- **Task 20c (new) — macOS codesign + hardened-runtime entitlements** (§11.3.2): add `build/entitlements.daemon.plist`; per-arch sign loop over daemon Mach-O + every `.node` (round-2 P0-2); switch keychain unlock to `MACOS_KEYCHAIN_PW` secret (round-2 SH2); standalone-binary notarytool submission. +3.5h.
- **Task 20d (new) — SHA256SUMS.txt + SLSA provenance + Linux minisign** (§11.4): single-source-of-truth SHA computation in `release-publish` merge job (round-2 S1); `actions/attest-build-provenance@v1` for SLSA-3 (round-2 security P0-S3); Linux minisign signature with `MINISIGN_KEY` secret. +2h (SLSA + minisign add ~1h vs the original Plan delta).
- **Task 20e (new) — NSIS uninstall hygiene** (§11.6, round-2 P0-1 — reclaimed from frag-6-7; per-user paths per round-3 P0-1/P0-2): `build/installer.nsh` with `customUnInstall` macro (taskkill + opt-in per-user data-root recursive cleanup covering `data/`, `logs/`, `crashes/`, `daemon.lock`, `daemon.secret` under `%LOCALAPPDATA%\ccsm\` / `~/Library/Application Support/ccsm/` / `~/.local/share/ccsm/`); `nsis.include` wiring with `perMachine:false`; Linux `.deb` postrm + `.rpm` %preun scripts; macOS tray "Reset CCSM…" item (surface owned by frag-6-7 §6.8); small `ccsm-uninstall-helper.exe` for graceful daemon shutdown via RPC (cross-ref frag-6-7 §6.4 `daemon.shutdown`). +4h spec-coordinated, +0h frag-6-7 (RPC already specified).
- **Task 20f (new) — CI Node 22 bump + daemon test job** (§11.5, round-2 P1-3): bump `setup-node` from 20 to 22 in both `verify` and `build`; extend cache key with `daemon/package-lock.json`; add `npm -w @ccsm/daemon run test` to `verify`. +0.5h.
- **Task 24 (existing) — Release pipeline integration**: drop the proposed `daemon-v*` trigger; v0.3.0 ships single `v*` tag carrying both installer (with daemon embedded) + standalone daemon binary as separate asset. Reserve `daemon-v*` for v0.3.1+; sketch the daemon-only matrix in spec deferred list to avoid v0.3.1 panic-rewrite. +0h (scope reduction).

**Total packaging block: ~17h** (vs frag-11 r1's ~10h; the new ~7h covers round-2 P0-1 NSIS reclaim, P0-2 native signing across platforms, SLSA provenance, CI node bump). Round-3 deltas land separately in the "Plan delta (r3)" block below.


## Cross-frag rationale

This block records ownership decisions for round-2 cross-fragment items where multiple fragments could plausibly own a fix.

**Owned by frag-11 (this file):**

- **NSIS uninstall hygiene (round-2 P0-1)** — TAKEN. Round-1 traceability matrix mapped this to "§11"; frag-11 r1 punted to "§3.1 in lifecycle / frag-6-7"; frag-6-7 never picked it up. Frag-11 reclaims because (a) NSIS scripts + electron-builder `nsis.include` + `.deb` postrm + `.rpm` %preun are pure packaging-toolchain mechanics, (b) the scope spans all three OSes' installer contracts which is exactly frag-11's remit, (c) the daemon-side dependency (graceful `daemon.shutdown` RPC) is already specified in frag-6-7 §6.4 — frag-11 only needs the orchestration shim (`ccsm-uninstall-helper.exe`). Specified in §11.6 with the canonical daemon-owned-paths table.
- **`ccsm_native.node` packaging + signing (round-2 P0-2 / round-3 P0-3 rename)** — TAKEN. frag-3.5.1 §3.5.1.1 introduces the helper as a single .node carrying winjob+pdeathsig+pipeAcl exports; frag-11 §11.1/11.2/11.3 now lists it explicitly under the canonical name in `pkg.assets`-affecting rebuild loop, in `before-pack.cjs` validation set, and in both signtool/codesign loops. The previous `winjob.node` filename is fully retired — any tooling reference is a bug.
- **SLSA-3 build provenance (round-2 security P0-S3)** — TAKEN. The CI mechanism (`actions/attest-build-provenance@v1` + Linux minisign) lives in release.yml which frag-11 owns. The verifier side (updater checks attestation before swap) is owned by frag-6-7 §6.4 step 2 — flagged below as a frag-6-7 follow-up.
- **CI Node 22 bump + cache key + daemon test job (round-2 P1-3)** — TAKEN. release.yml-only change; frag-11 §11.5(0)(0a)(1).
- **`pkg --compress GZip` removal (round-2 P1-4)** — TAKEN. Single-line change in `daemon/package.json` `scripts.package`; documented note in §11.1.
- **signtool path hardcode fix (round-2 P1-6)** — TAKEN. §11.3.1 step.
- **SHA256SUMS computation moved to merge job (round-2 S1)** — TAKEN. §11.4.
- **`extraResources` `${platform}` token correction (round-2 S3)** — TAKEN. §11.2 staged-dir pattern.
- **macOS keychain unlock secret (round-2 SH2)** — TAKEN. §11.3.2 uses `MACOS_KEYCHAIN_PW`.
- **`signtool verify /pa /v` post-sign (round-2 SH3)** — TAKEN. §11.3.1.
- **Daemon `dependencies` discipline (round-2 C6)** — TAKEN. §11.1 prose.

**Punted to frag-6-7 (reliability/security):**

- **`pino-roll` not abstraction-wrapped, `proper-lockfile` directly imported (round-2 lockin P1)** — out of §11 scope. These are runtime architecture choices in daemon code; frag-6-7 §6.4 / §6.6 owns the wrapper-vs-direct decision. Frag-11 only ensures both modules ship as `daemon/package.json` `dependencies` (round-2 C6).
- **`daemon.secret` lifecycle: installer-time generation, atomic ACL set, rotation on update, redact list (round-2 security P0-S1 / round-3 CF-2 resolved)** — owned **entirely** by frag-6-7 §7.2. The generator runs in **Electron-main**, NOT the installer (cleaner: no NSIS DACL juggling, no Linux postinst equivalent). Frag-11 does NOT add a `customInstall` block; the prior round-2 sub-bullet is retracted in round-3. Frag-11 only specifies the on-disk path (per round-3 P0-2 paths table) and the uninstall delete in §11.6.
- **SLSA attestation **verifier** (round-2 security P0-S3 verifier half / round-3 CF-4)** — frag-6-7 §6.4 step 2 (auto-update verify) owns the verify call. Frag-11 generates the attestation and locks the verifier library to **`@sigstore/verify` 1.x** (round-3 §11.4.1).
- **Stream `fromSeq` token + handler-arg schema + traceId validation (round-2 security P1-S1/S2/S3)** — entirely out of §11 scope; frag-3.4.1 / frag-3.5.1 / frag-6-7 own.
- **Single-instance lock vs uninstall ordering (round-2 P1-5)** — partly TAKEN by §11.6 (the per-user `daemon.lock` row in the canonical paths table + the always-delete behaviour). The runtime stale-PID recovery + `OpenProcess` semantics remain frag-6-7 §6.4.
- **Migration env-var trust boundary, network-FS / symlink rejection (round-2 security P0-S2)** — frag-8 owns; nothing for frag-11 to package-side.
- **Threat-model rows T12-T16 (round-2 security)** — frag-6-7 §7.4 owns; frag-11 only contributes the T13 crash-dump path location (per round-3 paths table: `%LOCALAPPDATA%\ccsm\crashes\` etc., included in the §11.6 cleanup table).

**Punted to frag-3.7 (dev workflow):**

- **Prod log surfacing regression (round-2 devx)** — out of §11 packaging scope. Concerns the dev-time `nodemon` log-level mapping vs prod pino config; frag-3.7 §3.7.6 owns.

**No-op for frag-11 (already addressed elsewhere):**

- Round-1 MUST-FIX 1/2/3 (extraResources, daemon signing, mac entitlements) — addressed in r1, retained.
- macOS notarization rate-limit (round-2 packaging S2) — accepted as-is (§11.7).

---

## Plan delta (r3)

Round-3 fixer changes layered on top of the round-2 plan delta above:

- **Task 20a (extend) — `before-pack.cjs` arch map + per-platform pkg target.** Add round-3 P1-1 arch map (`{0:'ia32',1:'x64',2:'armv7l',3:'arm64',4:'universal'}`) with an explicit throw on `universal`/`armv7l`. In §11.5 step 2, document `pkg --targets node22-${PLATFORM}-${ARCH}` per matrix leg so each binary embeds only its own arch's `.node` files (round-3 P1-7). +0.5h.
- **Task 20b (extend) — Windows install path = `%LOCALAPPDATA%\ccsm\` (round-3 P0-1).** NO package.json change required; working tip already matches the §11.6 r9 lock (`oneClick: false / allowElevation: true / allowToChangeInstallationDirectory: true`). Rewrite `installer.nsh` paths to `$LOCALAPPDATA\ccsm\…` (no `$PROGRAMFILES`, no `$PROFILE\.ccsm`). Update auto-update reference docs to note in-place writes are no-UAC. [manager r11 lock: r10 packaging P1-B — Plan delta r3 stale `oneClick: true / allowElevation: false` proposal retracted; §11.6 r9 lock is the canonical NSIS posture and no package.json edit is needed.] +1h.
- **Task 20c (extend) — macOS daemon.secret path + notarize count.** macOS data root locked at `~/Library/Application Support/ccsm/` per round-3 P0-2; standalone-daemon notarytool block stays as 2 submissions (x64+arm64), §11.7 corrected to total 5 submissions/release per round-3 P1-5. +0h spec, doc-only.
- **Task 20d (extend) — SLSA verifier locked to `@sigstore/verify` 1.x; SHA256SUMS in subject-path (round-3 CF-4 + P1-8).** Update §11.4.1 attest step to include `dist-all/SHA256SUMS.txt`; lock the verifier library name in the spec so frag-6-7 §6.4 step 2 implementer doesn't re-pick. Document one-time minisign keypair generation as a release prerequisite (round-3 P1-9: `minisign -G`, store `MINISIGN_KEY` secret, commit `build/minisign.pub`). +0.5h.
- **Task 20e (extend) — Linux postrm correction + uninstall-helper $TEMP copy (round-3 P0-4 + P1-6).** Replace `${HOME:-/root}/.ccsm` with `getent passwd "$SUDO_USER"` lookup that only fires on `purge` AND when `SUDO_USER` is set; document `rm -rf ~/.local/share/ccsm` as the documented user-step fallback. NSIS `customUnInstall` copies `ccsm-uninstall-helper.exe` to `$TEMP` before invoking, so the in-flight uninstall main loop can RMDir `$INSTDIR` without a Windows file-lock collision. +0.75h.
- **Task 20f (extend) — `daemon/.nvmrc` single-source-of-truth for Node target (round-3 P1-3).** Commit `daemon/.nvmrc` with the exact patch (`22.11.0`); have `setup-node` read `node-version-file: daemon/.nvmrc` and the rebuild script read the same file. Removes drift between `setup-node` (`'22'` any-minor), `pkg` base binary, and `node-gyp` headers. +0.25h.
- **Task 20g (new) — ccsm_native rename sweep (round-3 P0-3).** Mechanical rename of `winjob.node` → `ccsm_native.node` in `pkg.assets` rebuild script, `before-pack.cjs` `REQUIRED_NATIVES`, `after-pack.cjs` validation list, codesign/signtool target sets, and the `daemon/native/winjob/` source directory → `daemon/native/ccsm_native/`. Coordinated with frag-3.5.1 §3.5.1.1 + frag-6-7 §7.3 (which still reference the old name). +0.5h.

**Round-3 packaging delta total: ~3.5h** on top of round-2's ~17h. New packaging block estimate: **~20.5h**.

---

## Cross-frag rationale (r3)

Round-3-specific ownership notes (deltas on top of the round-2 cross-frag block above):

**Reclaimed / clarified by frag-11:**

- **NSIS `perMachine: false` + per-user install root (round-3 P0-1)** — TAKEN. Sole owner. The choice spans every paragraph in this file that previously said "Program Files" or `$INSTDIR` semantics; all are now scoped to `$LOCALAPPDATA\ccsm\`.
- **`ccsm_native.node` canonical name (round-3 P0-3)** — TAKEN. Frag-11 picks up the rename sweep across `pkg.assets`, `before-pack.cjs`, `after-pack.cjs`, signtool/codesign loops. Frag-3.5.1 §3.5.1.1 already specifies the addon export shape; frag-11 follows.
- **Linux postrm `${HOME:-/root}` bug (round-3 P0-4)** — TAKEN. Replaced with `SUDO_USER`-gated `getent passwd` lookup; documented manual `rm -rf ~/.local/share/ccsm` fallback in §11.6.3.
- **Uninstall-hygiene disk mechanics dedupe (round-3 X3)** — TAKEN by §11.6 with explicit cross-ref. The in-app surface (close-to-tray, "Reset CCSM…", post-uninstall toast, etc.) and its numeric-priority registry are owned by **frag-6-7 §6.8**; frag-11 §11.6 owns only the disk-removal mechanics (NSIS macro / postrm / paths table / shutdown helper).
- **`devTarget()` env-gate fence (round-3 CF-2 / devx)** — TAKEN. The `app.isPackaged === false` branch in §11.2 now requires `CCSM_DAEMON_DEV=1` to even compute a dev daemon path; cross-ref frag-3.7 §3.7.2.b for env-gate convention.

**Punted to frag-6-7:**

- **`daemon.secret` generator (round-3 CF-2 resolution)** — frag-6-7 §7.2 "Electron-main, NOT installer" wins; frag-11's prior `customInstall` proposal is retracted. Frag-11 only owns the on-disk path (per round-3 P0-2 paths table) and the uninstall delete in §11.6.
- **In-app surface registry for cleanup-style UI (close-to-tray, reset-data, post-uninstall toast)** — frag-6-7 §6.8 owns. Frag-11 references but does not redefine. Reason: numeric-priority registry is a UX/state-machine concern, not a packaging concern.

**Punted to frag-12 (traceability):**

- **frag-12 packaging M4 / ux M2 stale-OPEN flags (round-3 CF-1 + CF-3)** — frag-11 cannot edit frag-12; flagged here for the frag-12 fixer to re-audit and close.

**Punted to frag-3.5.1:**

- **`ccsm_native.node` source layout** — frag-3.5.1 §3.5.1.1 is the canonical contract for the addon's export surface (winjob + pdeathsig + pipeAcl). Frag-11 only consumes the artifact name and packages it.

**Acknowledged but no spec edit needed:**

- **CF-5 Linux initial-install integrity honesty** — agreed; the wording fix lives in frag-6-7 §7.3 "Initial-install integrity" paragraph (Win/mac via signtool/codesign; Linux via documented `slsa-verifier` + minisign manual step). Flagged for frag-6-7 fixer.
- **P1-2 `pkg.targets` per matrix leg** — covered by Task 20a extend above (`pkg --targets node22-${PLATFORM}-${ARCH}`).
- **P1-4 `${ext}` token in `from`** — already correct; pinned `electron-builder@^26.x`.
