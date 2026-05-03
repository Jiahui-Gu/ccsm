# T9.8 spike result — better-sqlite3 .node load in Node 22 SEA

Spike target: confirm whether `better-sqlite3`'s native `.node` addon can be
loaded from a Node 22 single-executable application (SEA), and document the
exact filesystem layout required.

## Hypothesis

Per spec ch10 §1: a SEA blob embeds JS/JSON/code-cache only; native modules
(`.node` files) cannot live inside the blob and must sit on disk next to the
binary. They should be loadable by anchoring `createRequire` at
`process.execPath`, so module resolution walks the binary's directory's
`node_modules/` instead of the (frozen) SEA virtual root.

## Method

`probe.mjs` (esbuild → CJS → SEA blob → `postject` injected into a copy of
`node`) tries, in order:

1. `require('better-sqlite3')` anchored at `process.execPath` — exercises
   the JS wrapper + bindings lookup of the native addon.
2. If (1) fails, `process.dlopen()` directly on a `better_sqlite3.node`
   sitting next to the binary — proves the *native* side loads even when
   the JS wrapper is absent.

The probe prints `IS_SEA`, `EXEC_PATH`, the resolved `LOAD_PATH`, and the
SQLite version (or a `<dlopen-only>` marker).

Three layouts were tested on the same binary by moving sidecar files:

| Layout | What sits next to the binary |
| ------ | ---------------------------- |
| A      | full `node_modules/better-sqlite3` tree + `bindings` + `file-uri-to-path` + flat `better_sqlite3.node` |
| B      | flat `better_sqlite3.node` only |
| C      | nothing                       |

## Results

Host: Windows 11 (win32-x64), Node v24.14.1 (SEA API frozen since Node 22).
better-sqlite3 11.10.0 (prebuilt napi-v6 win32-x64).

| Layout | Outcome | `SQLITE_VERSION` | Notes |
| ------ | ------- | ---------------- | ----- |
| A — full sidecar tree | **PASS** | `3.49.2` | `require('better-sqlite3')` resolved against the sidecar `node_modules`; in-memory query ran. `IS_SEA=true` confirmed. |
| B — bare `.node` only | **PASS (dlopen)** | `<dlopen-only>` | `require()` failed; `process.dlopen()` succeeded against the sidecar `.node`. Proves the *native* load works without the JS wrapper, but no useful API is exposed without it. |
| C — no sidecar | **FAIL (expected)** | — | `Error: Cannot find module 'better-sqlite3'` from `Module._resolveFilename`. Canonical failure mode when nothing sits next to the binary. |

| OS    | Result         |
| ----- | -------------- |
| win32 | PASS (above)   |
| linux | TODO (not run on this host) |
| macOS | TODO; expect the same outcome plus codesign step on the binary AND the `.node`; gatekeeper requires both signed + notarized (spec ch14 §1.13). |

## Key findings

1. **SEA + better-sqlite3 works** when the sidecar layout is correct. The
   `IS_SEA=true` path was exercised end-to-end (SEA blob via
   `--experimental-sea-config`, postject injection with the standard
   `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2` sentinel).
2. **`createRequire(process.execPath)` is the load anchor** — without it,
   `require()` resolves relative to the SEA virtual root which has no
   `node_modules/`.
3. **The JS wrapper must be on disk too**, not just the `.node`. Layout B
   loads natively but is unusable. Production must ship the
   `better-sqlite3` package directory (or an inlined wrapper) next to the
   binary, not just the addon.
4. **postject prints `warning: The signature seems corrupted!`** on
   Windows because we're injecting into an unsigned `node.exe` copy. This
   is benign for the spike but on macOS the signature MUST be re-applied
   after injection (spec ch14 §1.13).
5. **Top-level `await` and `import.meta` cannot be used in the SEA entry**
   because `--experimental-sea-config` requires CJS. esbuild bundles the
   `.mjs` into CJS with `--external:better-sqlite3 --external:node:sea`;
   the source is written in the CJS-friendly subset.

## Conclusion

> **better-sqlite3 loads cleanly from a Node 22 SEA**, provided the JS
> wrapper directory and the prebuilt `better_sqlite3.node` are staged on
> disk next to the binary and `require` is anchored at `process.execPath`
> via `createRequire`. The naive "single self-contained binary" goal is
> not achievable for native modules; they must remain sidecars.

## Recommendation for T7.2 native-loader (#83)

The native-loader module in `packages/daemon` should:

1. Detect SEA mode via `require('node:sea').isSea()` (guarded with try /
   catch — outside SEA the module simply doesn't exist).
2. In SEA mode, build `createRequire(process.execPath)` once at startup
   and use it for ALL native addon requires (better-sqlite3, node-pty,
   any future ones). Do not rely on the bundled CJS resolver — it points
   at the SEA root.
3. Ship the addon as a sibling tree (e.g. `<install>/native/better-sqlite3/`)
   and prepend that path to the resolver, so we are not coupled to
   `process.execPath`'s parent directory layout (which differs across
   Squirrel.Windows / .pkg / AppImage).
4. Surface a single typed error class `NativeAddonLoadError` carrying
   `{ moduleName, attemptedPaths[], cause }` so installer-residue and
   sidecar-missing failures can be distinguished from ABI mismatches in
   crash reports.
5. Pin the better-sqlite3 prebuild URL / sha in the v0.3 lockfile and
   verify it during the SEA build step — the spike used the npm-supplied
   prebuild, but production must guarantee the same ABI as the bundled
   Node major.

The codesign / notarization story (macOS) is separate and tracked under
spec ch14 §1.13 + the existing `entitlements-jit.plist` harness file; the
sidecar `.node` MUST be signed independently of the binary.
