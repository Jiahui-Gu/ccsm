# Notify E2E r1 verification report

Task: prove that PR #415 (`fix(notify): ship native notifications module in installer`) actually ships a working Adaptive Toast pipeline in a real installer end-to-end.

Worktree: `C:/Users/jiahuigu/ccsm-worktrees/pool-1`
Branch under test: `origin/working` @ `2a9592e` (HEAD includes PR #415).

## 1. Verdict

**FAIL — blocked, no runtime evidence collected.**

The local Windows build environment cannot compile the `@nodert-win10-au/*` C++/CX native chain that PR #415 promotes from `optionalDependencies` to `dependencies`. As a result `npm ci` itself aborts before `electron-builder` is ever invoked, so the installer cannot be produced and Phases 2 / 3 / 4 cannot be exercised honestly. The pre-existing installer artifacts in sibling pool worktrees were inspected and do not constitute a valid PR-#415 build (details in section 4 below).

This is a real environment / verification-infrastructure blocker for #415, not a green light. Manager should route to a properly-equipped builder before declaring the fix shipped.

## 2. Build phase result

### Node version
- Default shell node: `v24.14.1` (would hit the documented `/std:c++20` vs `/ZW` clash).
- Resolved by downloading the official Node 20 portable distribution to
  `C:\temp\node20\node-v20.18.1-win-x64\` and prepending to `PATH`. Verified:
  ```
  $ node --version
  v20.18.1
  $ npm --version
  10.8.2
  ```
- `nvm-windows` (`C:\nvm\nvm.exe`) is installed but `nvm install 20.18.0` produced no output and no `v20*` directory under `C:\nvm`; the installer requires elevation and silently no-ops in this non-elevated shell. Falling back to a portable zip was the clean path.

### npm ci
Command: `npm ci --legacy-peer-deps` (full log: `C:\temp\npm-ci.log`, exit 1, 546 lines).

Failed during the package's own `node-gyp rebuild` install hook (well before `postinstall.mjs` / `electron-builder install-app-deps`). The compiler error, identical for every `@nodert-win10-au/*` package attempted:

```
@nodert-win10-au\windows.applicationmodel\_nodert_generated.cpp(1,1):
  error C1107: could not find assembly 'platform.winmd':
  please specify the assembly search path using /AI or by setting
  the LIBPATH environment variable
```

Root cause: `_nodert_generated.cpp` is C++/CX (uses `Platform::String^` / `Platform::Object^`), which requires `platform.winmd`. That file ships only with the legacy Visual Studio 2015 C++/CX SDK at:

```
C:\Program Files (x86)\Microsoft Visual Studio 14.0\VC\lib\store\references\platform.winmd
```

This box has only **VS 2022 BuildTools** (not full VS 2022). VS 2022 BuildTools does not include legacy C++/CX, and the `Microsoft Visual Studio 14.0` directory does not exist:

```
$ ls "/c/Program Files (x86)/Microsoft Visual Studio 14.0/"
ls: cannot access ...: No such file or directory
```

Windows SDK `UnionMetadata` does ship `Windows.winmd` (`C:\Program Files (x86)\Windows Kits\10\UnionMetadata\10.0.26100.0\Windows.winmd`) but no `platform.winmd`.

GitHub Actions `windows-latest` images include the full Visual Studio 2022 enterprise tooling and so do not hit this — that is why the release CI is presumably green while every local dev machine without legacy C++/CX is silently broken for `npm ci`. This is itself a follow-up worth surfacing: the project's contributor environment has an undocumented dependency on full VS 2022 (not BuildTools) or on the standalone VS 2015 build tools, neither of which is mentioned in `docs/packaging.md` or the postinstall hint output.

### Postinstall log tail / after-pack output
**Not reached.** `postinstall.mjs` never executed because `npm ci` aborted earlier in the install graph.

## 3. Asar verification results

**Not reached.** Build did not produce a `release/` directory in `pool-1`. See section 4 for what was found in sibling pool worktrees and why it is not a valid #415 build.

## 4. Runtime toast results

**Not reached.** Without an installer this phase cannot run.

### Inspection of sibling pre-built installers (NOT valid as #415 evidence)

Three pre-existing installers were located on disk:

```
pool-2/release/CCSM-Setup-0.1.0-x64.exe   (built 04-27 01:27)
pool-6/release/CCSM-Setup-0.1.0-x64.exe   (built 04-27 14:54)
pool-7/release/CCSM-Setup-0.1.0-x64.exe   (built 04-27 13:11)
```

Most recent is `pool-6`. Its current `git HEAD` is `9aadc26` (= the squashed PR #415 commit on a private branch), so on first glance it appears to be a #415 build. However, file timestamps disprove this:

```
release/CCSM-Setup-0.1.0-x64.exe   Modify: 2026-04-27 14:54:15
scripts/after-pack.cjs             Modify: 2026-04-27 15:42:17
                                   Birth:  2026-04-27 15:37:55
node_modules/.package-lock.json    Modify: 2026-04-27 13:31:46
```

The installer was produced (14:54) **before** PR #415's `after-pack.cjs` notifications check landed in the worktree (15:37 birth, 15:44 commit), and against a `node_modules` last touched at 13:31 — i.e. the `node_modules` predates the dependency promotion in #415. Direct check on the unpacked tree confirms the modules are absent from the installer:

```
$ ls release/win-unpacked/resources/app.asar.unpacked/node_modules/
@anthropic-ai
better-sqlite3
                      # no electron-windows-notifications, no @nodert-win10-au

$ npx asar list release/win-unpacked/resources/app.asar | grep -iE 'electron-windows-notifications|nodert'
                      # no matches inside the asar either
```

So the notifications native chain is **completely missing** from this installer. That is the failure mode #415 was meant to prevent, and an installer in this state would silently emit zero OS toasts in production.

This is not, however, evidence against #415 itself — pool-6's installer was built before #415 was applied and against a stale `node_modules`. A real #415 build (with #415's `after-pack.cjs` guard active and a fresh `npm ci`) would either succeed end-to-end (success path: modules present in `app.asar.unpacked`) or fail loudly at the after-pack stage (designed failure path: hard build error). Both are improvements over the current silent-failure mode shown here.

### PowerShell `GetHistory` smoking gun
**Not collected.** No installed CCSM exists yet from a verified #415 build. The currently-installed `C:\Users\jiahuigu\AppData\Local\Programs\CCSM\CCSM.exe` predates #415 and querying its toast history would not say anything about the fix.

## 5. Issues / nits / follow-ups

1. **`docs/packaging.md` does not document the legacy C++/CX requirement.** The `@nodert-win10-au` chain needs `platform.winmd`, which ships only with VS 2015 C++/CX or full VS 2022 (not VS 2022 BuildTools). The current `postinstall.mjs` hint says "Visual Studio Build Tools (C++ workload) + Python 3 on PATH" — that is **insufficient** on this kind of machine. Either pin a tested VS install path in docs, or add a preflight check in `postinstall.mjs` that probes for `platform.winmd` before delegating to `electron-builder install-app-deps`.

2. **`build.files` in `package.json` may not include the notifications chain.** Current allow-list is:
   ```json
   "files": [
     "dist/**/*",
     "package.json",
     "node_modules/@anthropic-ai/claude-agent-sdk/**",
     "node_modules/@anthropic-ai/claude-agent-sdk-*/**",
     "!**/*.map", "!**/*.ts",
     "!**/__tests__/**", "!**/tests/**"
   ]
   ```
   electron-builder normally auto-includes production dependencies regardless of `files`, but the explicit `@anthropic-ai/...` lines suggest someone has needed to manually opt-in dependencies before. Worth verifying in a real build that `electron-windows-notifications` and `@nodert-win10-au/*` (now in `dependencies`, not `optionalDependencies`) are picked up automatically. If not, `files` needs the same opt-in lines, or the after-pack guard will fire as a false positive on a properly-installed tree.

3. **Verification environment is single-point.** Right now the only way to validate notify changes is to wait for release CI. There is no local equivalent. Either provision one dev box with full VS 2022 + verify the docs cover it, or move asar/runtime verification into a scheduled CI job that runs on every `working` push so this kind of regression is caught without manual local builds.

4. **Pre-existing installers should be cleaned up or labelled.** Three stale installers in `pool-{2,6,7}` look authoritative but are pre-#415. A reviewer doing the same investigation could easily mistake `pool-6` for "the #415 build" because its `git HEAD` matches. Recommend a `release/.built-from` marker file written by `make:win` recording `git rev-parse HEAD + ISO timestamp` so artifacts can be unambiguously attributed to a commit.

## Summary

PR #415's intent is correct and the after-pack guard logic, asarUnpack patterns, and dependency promotion are all readable in source and look right. None of that is verified to actually produce a working installer because no working installer was producible in this environment. Re-run on a box with full Visual Studio 2022 (or VS 2015 C++/CX) before accepting #415 as shipped.
