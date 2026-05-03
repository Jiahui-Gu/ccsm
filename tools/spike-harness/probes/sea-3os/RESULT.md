# T9.9 — Node 22 SEA hello-world matrix

Spike for Task #117. Validates the Node 22 single-executable application
(SEA) toolchain end-to-end on each supported OS so T7.1 (#84 sea pipeline)
can bootstrap with known-working contracts.

## Per-OS results

| OS      | Built? | Ran?  | Exit | Output                  | Binary size | Notes                                    |
|---------|--------|-------|------|-------------------------|-------------|------------------------------------------|
| win32   | yes    | yes   | 0    | `hello-from-sea-win32`  | 87,202,304 B (~83 MiB) | Local run, see `dist/build.log` + `dist/run.log` |
| darwin  | TODO   | TODO  | -    | -                       | -           | Needs self-hosted macOS runner — Task #16 (T0.10) |
| linux   | TODO   | TODO  | -    | -                       | -           | Needs self-hosted Linux runner — Task #16 (T0.10) |

Run host: Windows 11 Enterprise 26200, Node v22.22.2 (cached at
`C:\tmp\node-v22.22.2-win-x64\node.exe`), x64.

## Reproduction

Windows (PowerShell):
```
$env:NODE22 = "C:\path\to\node-v22.22.2-win-x64\node.exe"   # optional; auto-downloads if unset
powershell -ExecutionPolicy Bypass -File ./build.ps1
```

Linux / macOS (bash):
```
NODE22=/path/to/node22  ./build.sh    # or omit NODE22 to auto-download
```

Both scripts:
1. Locate (or download into `.cache/`) the Node 22 binary.
2. Run `node --experimental-sea-config sea-config.json` to produce
   `sea-prep.blob` (`useCodeCache=true`, `useSnapshot=false`,
   `main=hello.js`).
3. Copy the Node binary into `dist/sea-hello-<platform>[.exe]`.
4. (macOS) `codesign --remove-signature` first.
5. `npx postject@1.0.0-alpha.6` injects the blob with the published
   `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2` sentinel.
6. (macOS) `codesign --sign -` ad-hoc re-signs.
7. Executes the binary, captures stdout into `dist/run.log`, asserts the
   exact `hello-from-sea-<platform>` line is present.

Build + run logs live under `dist/` (gitignored).

## Captured win32 output (verbatim)

`dist/run.log`:
```
hello-from-sea-win32
```

Tail of `dist/build.log`:
```
[build] node22=C:/tmp/node-v22.22.2-win-x64/node.exe (v22.22.2)
[build] blob bytes=1169
[build] binary template copied to ...\dist\sea-hello-win32.exe
[build] postject: ...\dist\sea-hello-win32.exe NODE_SEA_BLOB ...\sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --overwrite
[build] final binary bytes=87202304
[build] binary exited rc=0
[build] OK -- output matches 'hello-from-sea-win32'
```

## Findings / blockers / recommendation for T7.1

1. **Node 22 SEA is viable on win32 with no code-signing.** End-to-end
   pipeline `sea-config -> sea-prep.blob -> postject inject -> run`
   succeeded with `useCodeCache=true`. T7.1 can adopt this exact recipe
   for the daemon binary on Windows.
2. **Binary footprint is dominated by Node itself** (~83 MiB). User-code
   blob was 1,169 B. Future size budgeting must work on the Node side
   (custom build / strip / UPX), not on application code.
3. **`postject@1.0.0-alpha.6` is still the only published injector.**
   T7.1 should pin it explicitly and mirror it in our offline cache to
   avoid breakage if the alpha is yanked.
4. **PowerShell stderr trap.** Node writes the "Wrote single executable
   preparation blob to ..." line to stderr. PowerShell 7's default
   `$ErrorActionPreference=Stop` + `$PSNativeCommandUseErrorActionPreference`
   converts that to a fatal RemoteException. T7.1's CI step must set
   `$PSNativeCommandUseErrorActionPreference = $false` (already done in
   `build.ps1`).
5. **darwin / linux not validated locally.** Both OS legs are wired in
   `build.sh` (download URL, postject `--macho-segment-name NODE_SEA`,
   pre-/post- ad-hoc codesign for darwin) but a self-hosted runner is
   required to actually exercise them. Tracked under Task #16 (T0.10).
6. **No blocker for T7.1 bootstrap.** Recommendation: T7.1 starts from
   this probe, swaps `hello.js` for the daemon entrypoint, and adds the
   minisign / notarization stages on top. Forever-stable contract of
   `build.{sh,ps1}` (inputs/outputs/exit) is documented in their headers
   per spec ch14 §1.B.
