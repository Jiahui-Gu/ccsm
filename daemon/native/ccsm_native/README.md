# ccsm_native

In-tree N-API helper for the CCSM daemon.

## Spec

- `docs/superpowers/specs/v0.3-fragments/frag-3.5.1-pty-hardening.md`
  - §3.5.1.1   Win JobObject wiring
  - §3.5.1.1.a Native binding swap interface (lockin-P0-2)
  - §3.5.1.2   POSIX process group + SIGCHLD wiring
  - §3.5.1.6   Win named-pipe ACL hardening
- `docs/superpowers/specs/v0.3-fragments/frag-11-packaging.md`
  - §11.1 rebuild-native-for-node.cjs
  - §11.4 SHA256SUMS / signing of `ccsm_native.node`

## What it is

One single `.node` carrying five export surfaces:

| Surface     | Win32                                                        | Linux                            | Darwin                          |
|-------------|--------------------------------------------------------------|----------------------------------|---------------------------------|
| `winjob`    | `Create/SetInformation/Assign/TerminateJobObject`            | ENOSYS                           | ENOSYS                          |
| `pipeAcl`   | `SetSecurityInfo` + `PIPE_REJECT_REMOTE_CLIENTS`             | ENOSYS                           | ENOSYS                          |
| `pdeathsig` | ENOSYS                                                       | `prctl(PR_SET_PDEATHSIG)`        | ENOSYS                          |
| `peerCred`  | `GetNamedPipeClientProcessId` + `OpenProcessTokenUserSid`    | `getsockopt(SO_PEERCRED)`        | `getpeereid`                    |
| `sigchld`   | ENOSYS                                                       | `uv_signal_t(SIGCHLD)` + `waitpid(WNOHANG)` | same as Linux       |

Surfaces marked ENOSYS throw `Error { code: 'ENOSYS' }` at the binding
boundary so a misconfigured call site fails loud — never silently
no-ops at the native layer. The JS-side decider modules
(`daemon/src/pty/*.ts`, `daemon/src/sockets/peer-cred-verify.ts`)
provide platform-aware no-op stubs at the wrapper layer where
appropriate.

## How to build

From repo root:

```bash
npm run build:ccsm-native
```

This installs `node-addon-api` inside `daemon/native/ccsm_native/`,
runs `node-gyp rebuild` against the Node version in `daemon/.nvmrc`
(currently 22.11.0), and copies the resulting `ccsm_native.node`
into `daemon/native/<platform>-<arch>/`, where the daemon-side
loader (`daemon/src/native/index.ts`) resolves it.

The release build path runs the same logic from
`scripts/electron-rebuild-natives.cjs` (frag-11 §11.1) which
additionally rebuilds `better-sqlite3` for the daemon's Node ABI.

## How to use it from JS

NEVER `require('ccsm_native.node')` directly. The custom ESLint rule
`no-direct-native-import` enforces this — see frag-3.5.1 §3.5.1.1.a
("No call site in `daemon/src/pty/**` or `daemon/src/socket/**` may
import `ccsm_native.node` directly").

Always go through the loader shim:

```ts
import { native } from '../native/index.js';

// e.g. JobObject ownership
const job = createJobObject({ deps: native().winjob });

// e.g. pipe ACL hardening
applyPipeAcl(pipePath, { deps: native().pipeAcl });

// e.g. peer-cred verification
const verdict = verifyPeerCred(socket, { expectedSid }, {
  deps: native().peerCred,
});
```

## Per-platform availability

The loader shim at `daemon/src/native/index.ts` narrows the surface
by `process.platform` so consumers can check by `typeof` whether a
method is available:

```ts
if (typeof native().peerCred.getsockoptPeerCred === 'function') {
  // we are on Linux
}
```

The C++ stub files (`*_stub.cc`) register the same method names that
the real implementations register, so even a misconfigured call site
on the wrong platform gets a thrown ENOSYS error rather than a
JavaScript "x is not a function" TypeError.

## Why N-API and not koffi or shellouts

Per frag-3.5.1 §3.5.1.1.a "Vendor-risk acknowledgement" + open-question 1:
N-API was picked for compile-time symbol guarantees, zero runtime
overhead, and ABI stability across Node major versions (NAPI 8 covers
Node 16.6+). The `NativeBinding` swap interface is single-file
swappable to koffi or any other FFI in v0.4 if maintenance burden
becomes an issue.

Shellout fallbacks (`taskkill`, `icacls`, etc.) are intentionally NOT
implemented as a degraded path, because the spec contracts (e.g.
`KILL_ON_JOB_CLOSE` requires the kernel to act when the daemon
crashes — there is no chance to spawn a process from a dying
daemon) cannot be honoured by shellouts.

## Lifetime + handle ownership

Per §3.5.1.1 "Lifetime", the JobObject HANDLE is allocated once at
daemon boot and held for the daemon's whole life. The OS closes it
on process exit, which is the trigger for `KILL_ON_JOB_CLOSE`. The
binding therefore returns the HANDLE as a `Napi::External<void>`
with a no-op finalizer — JS GC tracks the wrapper but never frees
the underlying HANDLE. The JS-side `JobObjectHandle` abstraction in
`daemon/src/pty/win-jobobject.ts` is the only authority over its
logical lifetime.

## Acceptance tests

Per frag-3.5.1 §3.5.1.6:

- "Native binding accessed only through `daemon/src/native/index.ts`;
  lint `no-direct-native-import` passes on full daemon tree."
  — see CI workflow `.github/workflows/ccsm-native.yml` which runs
  `npx eslint daemon/src --ext .ts` after building the addon.

- "Unit: `winjob.create()` + `winjob.assign(job, fakePid)` round-trip;
  `assign` of dead pid throws `EINVAL`."
  — covered indirectly by `daemon/src/pty/__tests__/win-jobobject.test.ts`
  (existing) which exercises the `JobObjectHandle` against the
  injected `NativeWinjobDeps` shape that this binding implements.

- "Unit: SIGCHLD handler reaps a synthetic forked child within 50ms
  via `waitpid(pid, WNOHANG)` (per-PID, not `waitpid(-1)`)."
  — covered indirectly by `daemon/src/pty/__tests__/sigchld-reaper.test.ts`
  (existing) against the `SigchldReaperDeps` shape this binding
  implements via the JS-side `subscribe` -> `onSigchld` adapter.

The .node itself is smoke-tested by
`daemon/src/native/__tests__/index.test.ts` when run with
`CCSM_NATIVE_NODE=<path>` env (CI matrix sets this; local runs
without the env skip the dlopen tests cleanly).
