# R-30 Research Report — conpty AttachConsole second-spawn failure

**Task**: #87 (R-30: 修 PTY conpty AttachConsole — Tauri CREATE_NEW_CONSOLE+SW_HIDE)
**Status**: research-pushback. Original spec hypothesis falsified; not shipping.
**Date**: 2026-05-09
**Host**: Windows 11 Enterprise 26200, Node v22.18.0, node-pty 1.1.0

## TL;DR

Implemented spec's recommended Plan A (Tauri `creation_flags` change from
`CREATE_NO_WINDOW` to `CREATE_NEW_CONSOLE`, plus daemon-side koffi
`ShowWindow(GetConsoleWindow, SW_HIDE)` to hide the resulting console
window). **Manual cloud-e2e two-tab harness still fails identically**:
spawn #1 succeeds, spawn #2 throws `AttachConsole failed` at
`conpty_console_list_agent.js:13`. Spec's root-cause hypothesis ("daemon
has no console with CREATE_NO_WINDOW → 1st spawn implicit AllocConsole
binds it; 2nd spawn fails") does not survive the test — daemon now has a
stable own console up front, and the 2nd-spawn failure is bit-identical.

## What was attempted (commit 5aee8576 on this branch)

| File | Change |
|---|---|
| `packages/frontend-tauri/src-tauri/src/daemon_mgr.rs` | `creation_flags(CREATE_NO_WINDOW)` → `creation_flags(CREATE_NEW_CONSOLE)` |
| `packages/daemon/src/hide-console-windows.mts` (new) | koffi-loaded user32!ShowWindow(GetConsoleWindow, SW_HIDE) at daemon startup |
| `packages/daemon/src/index.mts` | invoke hide helper top of `main()` |
| `packages/daemon/package.json` + lockfile | add `koffi ^2.16.2` |

Build: `cargo check` ✓, `pnpm --filter @ccsm/daemon build` ✓.

## Verification — fix did NOT resolve the bug

Manual run: `cd packages/frontend-tauri && pnpm tauri dev` (background),
then `cd tools/cloud-e2e && npx playwright test`.

### Daemon stderr after fix (relevant lines from `/tmp/tauri-dev.log`)

```
[daemon-mgr] spawned daemon pid=22012
[daemon-mgr] assigned pid=22012 to Job Object
[daemon stderr] [ccsm] hide-console: hid console window
[daemon stderr] [ccsm] tunnel: connecting wss://cc-sm.pages.dev/tunnel/default
[daemon-mgr] handshake ok port=56905 token=9a7773…
[daemon stderr] [ccsm] tunnel: connected
[daemon stderr] [ccsm-pty-forensics] spawn={"sid":"9d96ea15-...","mode":"create","cmd":"claude.cmd","stdinIsTTY":false,"stdoutIsTTY":false,"stderrIsTTY":false,"useConpty":true,"pid":22012,"ppid":39244,...}
[daemon stderr] [ccsm-pty-forensics] spawn={"sid":"ae2c773a-...","mode":"create","cmd":"claude.cmd",...}
[daemon stderr] Error: AttachConsole failed
[daemon stderr]     at Object.<anonymous> (...\\node-pty\\lib\\conpty_console_list_agent.js:13:26)
```

- 2 spawns fired, 1 `AttachConsole failed` (on the 2nd) — **same shape as
  the R-29 baseline forensics**.
- Hide-console succeeded (`[ccsm] hide-console: hid console window`), so
  the koffi FFI path is healthy; this is not the cause of the failure.

### cloud-e2e result

`tools/cloud-e2e/specs/two-tab-pairing.spec.ts` — fails at
`tab.page.getByLabel('Terminal input').click()` for the second tab,
15 000 ms timeout, element resolves but is not visible (xterm host pane
never paints because PTY produces no output).

## What the spec hypothesis says (and why it doesn't hold)

Spec (Task #87 description, Phase 2 修法 A):

> 第 1 spawn: daemon 进程没 attach 任何 console (Tauri Rust 用 CREATE_NO_WINDOW), AttachConsole 时隐式触发 AllocConsole, 成功
> 第 2 spawn: daemon 进程已 attached 到 conpty1 的 console, AttachConsole(conpty2 shell) 被拒
> ... daemon 有 console (CREATE_NEW_CONSOLE+SW_HIDE) → helper 继承 console → helper detach OK → attach OK

If that mechanism were correct, switching to CREATE_NEW_CONSOLE would
make spawn #2 succeed. It doesn't. Therefore the differentiator between
spawn #1 (works) and spawn #2 (fails) is **NOT** "daemon has/has-no
console at process startup". It is some state mutation inside the daemon
process **between spawn #1 returning and spawn #2 starting**, that
poisons the 2nd helper's console-attach attempt.

## Source-level evidence

`node-pty/src/win/conpty_console_list.cc` lines 18–22 (helper
subprocess body):

```cpp
if (!FreeConsole()) {
    throw Napi::Error::New(env, "FreeConsole failed");
}
if (!AttachConsole(pid)) {
    throw Napi::Error::New(env, "AttachConsole failed");   // ← thrown
}
auto processList = std::vector<DWORD>(64);
auto processCount = GetConsoleProcessList(...);
FreeConsole();
```

Helper inherits the daemon's console state via `child_process.fork`,
runs FreeConsole (releases inherited binding), runs
AttachConsole(targetPid) (binds to the conpty shell). The throw is on
`AttachConsole`, not `FreeConsole` — i.e. the inherited state was
released cleanly, but the new attach to the conpty shell is rejected.

`node-pty/src/win/conpty.cc` (daemon-side, called by `pty.spawn()`)
calls `CreatePseudoConsole`/`ConptyCreatePseudoConsole`. It does NOT
call AttachConsole/FreeConsole on the daemon directly. **However**, the
Microsoft pseudo-console API documentation
(<https://learn.microsoft.com/en-us/windows/console/createpseudoconsole>)
implies the HPCON handle ties the daemon to the conpty's session in some
opaque way that affects subsequent AttachConsole calls. The exact
mechanism is undocumented; the failure mode is consistent with "process
that has spawned at least one HPCON cannot AttachConsole to any other
HPCON's shell pid until it disposes the first HPCON".

## Real root-cause hypothesis (NOT YET CONFIRMED — needs R-31 forensics)

**H1 (most likely)**: After the daemon calls `CreatePseudoConsole` for
spawn #1, the daemon process is implicitly bound to that HPCON's
console group. Helpers forked thereafter inherit that binding. The
helper's `FreeConsole` releases the inherited handle but does **not**
sever the deeper HPCON↔daemon linkage; subsequent `AttachConsole(pid2)`
where pid2 is owned by HPCON#2 returns ERROR_ACCESS_DENIED because the
calling helper's parent (daemon) is still associated with HPCON#1.

**H2 (less likely)**: It's not HPCON binding but `getConsoleProcessList`
itself that is destructive — running the helper for spawn #1 leaves
side-effects in the daemon's console state. Less plausible because the
helper is a separate process; whatever it does to its own console
shouldn't propagate back to daemon. But not impossible if conhost shares
state across the process group.

H1 vs H2 cannot be distinguished without measuring `GetConsoleWindow`
and `GetConsoleProcessList` from inside the daemon (not the helper)
**before** and **after** each `pty.spawn()`. That is the R-31 ask.

## Candidate fixes (≥2, with risks) — DO NOT IMPLEMENT YET

### A. Daemon-side `FreeConsole()` before each `pty.spawn()` (workaround)

In `packages/daemon/src/runtime.mts` `defaultPtyFactory`, on Windows,
call `kernel32!FreeConsole()` via koffi immediately before
`nodePty.spawn`. Goal: reset the daemon's console attachment so the
helper inherits a clean "no console" each spawn, equivalent to the
post-startup baseline-spawn-#1 condition.

- **Risk H1-true**: H1 says the binding is HPCON-level, not console-handle-level —
  FreeConsole won't break it. Then this is a no-op and spawn #2 still fails.
- **Risk H1-false**: it works, but introduces ~1 ms latency per spawn and
  a koffi call from a hot path; also FFI failure modes leak into PTY
  spawn pipeline.
- **Already prototyped this on this branch as a separate uncommitted
  change** (saved at `/tmp/task-87-runtime-mts-uncommitted-attempt2.patch`);
  not tested manually because manager halted further attempts. Would be
  the test-once-and-decide path R-32 if R-31 confirms H1 is wrong.
- **Layer**: Layer 4 glue per memory `feedback_fix_arch_not_glue.md`
  reading. Not preferred unless higher-layer fix is infeasible.

### B. Patch / vendor node-pty `conpty.cc` to dispose HPCON properly (root-cause fix if H1)

Modify `node-pty/src/win/conpty.cc`'s lifecycle to ensure the daemon is
not bound to HPCON#N's console after spawn return — possibly by spawning
the conpty in an isolated process group, or by closing the HPCON handle
on the daemon side once the shell has detached.

- **Risk**: requires deep understanding of Microsoft's HPCON internals
  that are not publicly documented; likely needs new conpty API
  (`ClosePseudoConsole` is called but apparently not enough).
- **Risk**: vendoring node-pty (or maintaining a local fork / patch-package)
  adds maintenance debt; CI builds need a custom build step for the
  native module.
- **Layer**: Layer 2 (the actually-broken layer). Memory-aligned.
- **Cost**: high — needs spike, repro on minimal example, MS-team
  consultation likely.

### C. Single-conpty model: serialize all PTYs through one HPCON

Architectural change: the daemon owns a single HPCON and multiplexes
multiple "logical" sessions over it. No second `CreatePseudoConsole`
ever, so the binding-cross-conpty problem cannot manifest.

- **Risk**: very large refactor. Each session's stdout/stderr/exit needs
  re-multiplexing in JS layer; ANSI state isolation is non-trivial.
  Spec explicitly rejects this (`不必要`).

### D. Switch to winpty fallback (`useConpty: false`)

- Spec rejected this (perf + Win 11 unsupported). Not viable.

## Recommended next actions (manager's call, NOT mine)

1. **R-31** (forensics-only): instrument `defaultPtyFactory` with koffi
   FFI probes for `GetConsoleWindow()` and `GetConsoleProcessList(0)` on
   the daemon process **before** and **after** each `pty.spawn()`. Log
   the deltas. Run cloud-e2e two-tab harness; capture stderr. This is
   the only way to distinguish H1 from H2 before committing to fix
   layer.
2. **R-32**: depending on R-31 result, implement A (cheap, Layer 4
   glue) or B (correct, Layer 2, expensive). Document layer choice in
   PR body.
3. Decide whether to keep this branch's koffi setup + hide-console as
   prerequisite scaffolding for R-32, or revert and let R-32 reintroduce
   the FFI dep itself.

## Pushback

I am pushing back per dev role §5 (cannot reach a working fix without
more evidence) and per memory `feedback_log_until_certain.md` (証拠
不足时不许猜着改). Halting changes here. Manager: please file R-31
or override with new spec.

## Branch artifacts

- HEAD commit `5aee8576`: R-30 attempt (Tauri CREATE_NEW_CONSOLE + daemon
  hide-console-windows.mts via koffi). Build green; fix non-functional.
- Saved patch (not committed): `/tmp/task-87-runtime-mts-uncommitted-attempt2.patch`
  — daemon-side FreeConsole-before-spawn (Plan A above), unverified,
  recoverable for R-32.
- Logs: `/tmp/tauri-dev.log` on dev host (ephemeral; key lines quoted
  above).
