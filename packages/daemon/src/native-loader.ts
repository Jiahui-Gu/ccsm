// packages/daemon/src/native-loader.ts
//
// Native (.node) addon resolver. Spec ch10 §2.
//
// Why this module exists:
//   Node 22 sea (Single Executable Application) cannot embed `.node` binaries
//   inside the v8 sea blob. The daemon ships native deps (`better-sqlite3`,
//   `node-pty`) as sibling files in `<install-dir>/native/` and resolves them
//   via `createRequire(process.execPath + '/native/')`. This file is the
//   single typed surface the rest of the daemon goes through; no other module
//   may `import 'better-sqlite3'` or `import 'node-pty'` directly.
//
// Dev / test mode:
//   When running under tsc/vitest/`node dist/index.js` (i.e. NOT a sea
//   binary), `process.execPath` is `node` itself, which has no `native/`
//   sibling. We detect sea via `node:sea`'s `isSea()` and fall back to a
//   regular `createRequire` rooted at this file so packages installed under
//   `node_modules/` resolve normally. The fallback path is what every test
//   in CI exercises today; the sea path is exercised by the smoke step in
//   build-sea.sh / build-sea.ps1 once T7.1 wires the .node copy step.
//
// SRP: this is a pure *resolver* (decider + tiny sink for `require`). It owns
// the path math + the sea-vs-dev branch and nothing else.

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { isSea } from 'node:sea';

import type BetterSqlite3 from 'better-sqlite3';
// Task #480 — value import of the better-sqlite3 JS wrapper. esbuild bundles
// this into `dist/bundle.cjs` for the SEA carrier, so the SEA daemon has a
// real `Database` constructor at runtime (the napi `.node` only exposes a
// raw `addon.Database` — without the wrapper `new Database(path)` throws
// `Database2 is not a constructor`, dev report from PR #1066). The wrapper
// itself does NOT load the .node addon at module-eval time — it lazily
// resolves it inside `Database()` only when `nativeBinding == null`. We
// always pass `nativeBinding` in SEA mode (see `loadNative`), so the
// wrapper's `bindings('better_sqlite3.node')` fallback (which fails inside
// SEA — `bindings` walks the FS for `build/Release/`) is never executed.
// In dev/test the same wrapper resolves the .node via `bindings` normally.
import * as betterSqlite3Module from 'better-sqlite3';
// `node-pty` types are not a hard dep yet (T4.2+). Keep the type-side soft so
// this module compiles before that lands.
type NodePtyModule = typeof import('node-pty');

/**
 * Native addons the daemon may load. Forever-stable enum: adding a new
 * addon means shipping a new `.node` file in `<install-dir>/native/` AND
 * teaching the build matrix to prebuild it. Both steps need a spec update,
 * so the union here is the canonical inventory.
 */
export type NativeAddonName = 'better_sqlite3' | 'pty';

/**
 * Returned shape per addon. The mapping mirrors what the upstream packages
 * export so call sites can keep their existing API surface.
 */
export interface NativeAddonMap {
  better_sqlite3: typeof BetterSqlite3;
  pty: NodePtyModule;
}

/**
 * npm package name on disk for each addon. Used by the dev-mode fallback
 * (`createRequire(import.meta.url)`) where addons live under `node_modules/`.
 * The sea-mode path uses the `.node` filenames spec'd in ch10 §2 instead.
 */
const DEV_PACKAGE_NAME: Record<NativeAddonName, string> = {
  better_sqlite3: 'better-sqlite3',
  pty: 'node-pty',
};

/**
 * `.node` filenames that ship in `<install-dir>/native/` next to the sea
 * binary. Spec ch10 §2 example block locks these names.
 *
 * NOTE: in SEA mode `loadNative('better_sqlite3')` returns a wrapped
 * `Database` constructor, NOT this raw napi addon directly — the upstream
 * better-sqlite3 JS wrapper (`lib/database.js`) provides all the user-
 * facing methods (`prepare` / `transaction` / `pragma` / ...). We bundle
 * that JS wrapper into `dist/bundle.cjs` and hand it the raw napi addon
 * via the `nativeBinding` option (see Task #480 / `loadBetterSqlite3Sea`).
 */
const SEA_NATIVE_FILENAME: Record<NativeAddonName, string> = {
  better_sqlite3: './better_sqlite3.node',
  pty: './pty.node',
};

/**
 * Build the sea-mode require: rooted at `<dir-of-execPath>/native/` so
 * relative `./foo.node` paths resolve to `<install-dir>/native/foo.node`.
 *
 * Note the trailing `/` on the `createRequire` argument — Node treats the
 * path as a "filename" and resolves siblings, so we pass a phantom file
 * inside `native/` so that `./foo.node` lands in `native/`.
 */
function makeSeaRequire(): NodeJS.Require {
  const installDir = path.dirname(process.execPath);
  const nativeDir = path.join(installDir, 'native') + path.sep;
  // createRequire wants a filename; use `<nativeDir>__loader__` as the
  // anchor. The file does not need to exist — Node only uses it for
  // relative-path resolution.
  return createRequire(path.join(nativeDir, '__loader__'));
}

/**
 * Build the dev-mode require: rooted at this source file so npm packages
 * under the workspace `node_modules/` resolve normally during tsc / vitest
 * / `node dist/index.js` runs.
 */
function makeDevRequire(): NodeJS.Require {
  return createRequire(import.meta.url);
}

// Cache the require functions and loaded modules so repeated `loadNative`
// calls do not re-resolve. Native modules are stateful (better-sqlite3
// holds an internal handle table) — loading twice is wrong, not just slow.
let cachedRequire: NodeJS.Require | null = null;
const cache = new Map<NativeAddonName, unknown>();

function getRequire(): NodeJS.Require {
  if (cachedRequire === null) {
    cachedRequire = isSea() ? makeSeaRequire() : makeDevRequire();
  }
  return cachedRequire;
}

/**
 * Load a native addon. Returns the upstream module's default export shape
 * (e.g. `loadNative('better_sqlite3')` returns the `Database` constructor).
 *
 * Throws the underlying require error unchanged so the caller (or the
 * daemon's top-level crash handler) sees the real `MODULE_NOT_FOUND` /
 * dlopen failure rather than a wrapped message — debugging a missing
 * `.node` ABI mismatch in production needs the original stack.
 */
export function loadNative<K extends NativeAddonName>(name: K): NativeAddonMap[K] {
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached as NativeAddonMap[K];
  }
  const req = getRequire();
  let mod: NativeAddonMap[K];
  if (isSea() && name === 'better_sqlite3') {
    // Task #480 — SEA-mode better-sqlite3 wrapper bridge.
    //
    // In SEA mode `req('./better_sqlite3.node')` returns the *raw napi
    // addon* (an object exposing `Database` + `setErrorConstructor` +
    // `isInitialized` flag — NOT a constructor on its own). The user-
    // facing `Database` constructor lives in better-sqlite3's JS wrapper
    // at `lib/database.js` (`new Database(filename, options)` →
    // `new addon.Database(filename, ..., 8 args)`). Without the wrapper,
    // `new Database(...)` throws `Database2 is not a constructor` (Task
    // #463 follow-up: dev report from PR #1066 traced the SEA crash to
    // this exact gap after migrations were unblocked).
    //
    // We bundle the JS wrapper into `dist/bundle.cjs` (esbuild now drops
    // `--external:better-sqlite3`, see `build/bundle-for-sea-spec.mjs` +
    // `build/build-sea.{sh,ps1}`). Here we:
    //   1. Resolve the bundled wrapper via the workspace require — in
    //      SEA this is the bundled-in CJS exports; in dev this is the
    //      installed package (same identity).
    //   2. Force-inject the SEA-loaded raw napi addon as the wrapper's
    //      `nativeBinding` option on every construction. The wrapper's
    //      `bindings('better_sqlite3.node')` fallback (which fails in
    //      SEA — `bindings` package walks the filesystem looking for
    //      build/Release/*.node) is therefore never executed.
    //   3. Preserve the wrapper's static `SqliteError` export so callers
    //      that do `Database.SqliteError` keep working.
    const rawAddon = req(SEA_NATIVE_FILENAME[name]) as object;
    // The wrapper comes from the top-of-file `import * as
    // betterSqlite3Module from 'better-sqlite3'` so esbuild bundles it
    // into `dist/bundle.cjs`. A `req('better-sqlite3')` here would NOT
    // work in SEA: `createRequire` cannot resolve npm packages once
    // postjected (no `node_modules` next to `process.execPath`). The
    // import binding is what threads the wrapper through the bundler.
    // CJS interop: `import * as` of a CJS module yields the namespace
    // whose `default` is the module.exports value (the Database fn). Some
    // bundler/loader combos also expose the function on the namespace
    // itself, so try `default` first, then the namespace.
    type BetterSqlite3Constructor = new (
      filename: string | Buffer,
      options?: { nativeBinding?: object | string } & Record<string, unknown>,
    ) => unknown;
    const ns = betterSqlite3Module as unknown as {
      default?: BetterSqlite3Constructor & { SqliteError?: unknown };
    } & BetterSqlite3Constructor & { SqliteError?: unknown };
    const WrappedDatabase = (ns.default ?? ns) as BetterSqlite3Constructor & {
      SqliteError?: unknown;
    };
    function Database(this: unknown, filename: string | Buffer, options?: Record<string, unknown>) {
      // Always call as `new` — the upstream wrapper auto-news on plain
      // call but going through `Reflect.construct` is cleaner and keeps
      // `new.target` set correctly (matters for the wrapper's own
      // `new.target == null` re-entry guard).
      const merged = { ...(options ?? {}), nativeBinding: rawAddon };
      // Reflect.construct returns the constructed instance.
      return Reflect.construct(WrappedDatabase, [filename, merged], Database);
    }
    // Preserve prototype + static surface so `instanceof Database` and
    // `Database.SqliteError` keep matching the upstream API.
    Database.prototype = WrappedDatabase.prototype;
    if (WrappedDatabase.SqliteError !== undefined) {
      (Database as unknown as { SqliteError: unknown }).SqliteError = WrappedDatabase.SqliteError;
    }
    mod = Database as unknown as NativeAddonMap[K];
  } else {
    const spec = isSea() ? SEA_NATIVE_FILENAME[name] : DEV_PACKAGE_NAME[name];
    mod = req(spec) as NativeAddonMap[K];
  }
  cache.set(name, mod);
  return mod;
}

/**
 * Test-only hook to drop the cached require + module map. Used by the
 * unit tests that flip `isSea` via spy. Not exported from the package
 * barrel; production code never calls this.
 *
 * @internal
 */
export function __resetNativeLoaderForTests(): void {
  cachedRequire = null;
  cache.clear();
}
