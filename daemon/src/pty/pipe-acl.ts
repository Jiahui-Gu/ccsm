// T45 — Windows named-pipe ACL hardening (Win32 only).
//
// Per feedback_single_responsibility: this module is a pure SINK seam
// for the Windows named-pipe DACL hardening path. It has one job:
// after `net.createServer().listen(pipePath)` returns and the pipe
// kernel object exists, call the native `pipeAcl.applyOwnerOnly`
// binding to overwrite the pipe's default DACL with an explicit
// owner-only ACL. No bookkeeping, no logging, no state. The call site
// (`daemon/src/socket/listener.ts` per spec, but that wiring lands in
// a follow-up task — this module exposes the primitive) is the
// decider; this module is the pure binding wrapper.
//
// Spec: frag-3.5.1 §3.5.1.6 (Win named-pipe ACL hardening) +
// frag-3.5.1 §3.5.1.1.a (NativeBinding swap interface) + v0.3-design
// §3.1.1 (transport hardening) + frag-6-7 §7.1.2 + §7.M1
// (explicit DACL = current SID).
//
// Spec quote (v0.3-design §7.1.2 / sec-M1): "Win default pipe DACL
// grants Everyone in many configs. Defaults are NOT trusted."
//
// What the native binding does (per frag-6-7 §7.M1, implemented in
// frag-11's `ccsm_native.node` `pipeAcl.applyOwnerOnly` export):
//   1. Resolve the current process token's user SID
//      (`OpenProcessToken` + `GetTokenInformation(TokenUser)`).
//   2. Build a fresh DACL via `InitializeAcl` +
//      `AddAccessAllowedAce(GENERIC_READ | GENERIC_WRITE,
//      currentUserSid)`.
//   3. Add explicit `AddAccessDeniedAce` entries for
//      `BUILTIN\Users` (S-1-5-32-545) and `ANONYMOUS LOGON`
//      (S-1-5-7) so a future ACL re-evaluation cannot accidentally
//      grant them via group inheritance.
//   4. Set the security descriptor on the pipe handle via
//      `SetSecurityInfo(pipeHandle, SE_KERNEL_OBJECT,
//      DACL_SECURITY_INFORMATION, ...)`.
//   5. Set `PIPE_REJECT_REMOTE_CLIENTS` on the pipe state via
//      `SetNamedPipeHandleState` so even an admin from a remote
//      machine cannot connect over `\\<host>\pipe\...`.
//
// Why a single wrapper call instead of exposing each primitive on
// the JS side: the five steps must be atomic — a window where the
// pipe exists with the default DACL is a real attack window (other
// local users could connect in that gap). The binding does all five
// inside one C++ call so JS never sees an "intermediate" state.
//
// Cross-platform: on non-Win32, `applyPipeAcl` returns silently. The
// POSIX side already gets owner-only access via the unix-socket
// `chmod 0600` performed by `daemon/src/socket/listener.ts`; the
// data dir's `0700` enclosing-directory permission is a second
// layer. Callers do NOT need to platform-guard.
//
// Test injection mirrors T38 (sigchld-reaper) / T39 (win-jobobject):
// the native `pipeAcl` surface is injected through `Deps` so the
// module can be exercised on Linux/macOS CI without the `.node`
// artifact present, and so unit tests can inspect every call shape
// without creating real Win32 pipes.

/**
 * Native `pipeAcl` surface, as exposed by the in-tree
 * `ccsm_native.node` binding (frag-3.5.1 §3.5.1.1.a). Production
 * wires this through the future `daemon/src/native/index.ts` swap
 * interface; tests pass a fake.
 *
 * Methods MUST throw on non-Win32 platforms (`ENOSYS`); the wrapper
 * never reaches the binding on non-Win32 (it returns early), so this
 * is only a safety net for misconfigured production wiring.
 */
export interface NativePipeAclDeps {
  /**
   * Apply the owner-only DACL to an existing named pipe.
   *
   * Contract (per frag-6-7 §7.M1):
   *   - Grants `GENERIC_READ | GENERIC_WRITE` to the current
   *     process-token user SID only.
   *   - Adds explicit `AddAccessDeniedAce` for `BUILTIN\Users`
   *     (S-1-5-32-545) and `ANONYMOUS LOGON` (S-1-5-7).
   *   - Sets `PIPE_REJECT_REMOTE_CLIENTS` on the pipe state.
   *   - All five syscalls happen inside the native call so JS
   *     never observes an intermediate-DACL state.
   *
   * MUST throw if the pipe does not exist, if the current process
   * lacks `WRITE_DAC` on the pipe handle, or if `OpenProcessToken`
   * fails. The wrapper does not catch — callers (decider) decide
   * whether a failure is fatal (it is, for the daemon listener: a
   * pipe with the default Everyone-DACL is a security failure that
   * must fail boot, not log-and-continue).
   *
   * @param pipePath Full path of the named pipe, e.g.
   *   `\\.\pipe\ccsm-daemon-<userSid>`. The native binding opens
   *   the pipe with `CreateFile` to obtain a writable handle, so
   *   the pipe must already exist (created by `net.Server.listen`)
   *   before this call.
   */
  applyOwnerOnly(pipePath: string): void;
}

/**
 * Optional dependency injection. Defaults to the in-tree native
 * binding loader. Tests always inject fakes; production code also
 * injects via the future `daemon/src/native/index.ts` shim (per
 * §3.5.1.1.a "no direct native import" rule).
 *
 * Ignored on non-Win32 platforms — the wrapper returns silently
 * without touching the native layer.
 */
export interface ApplyPipeAclOptions {
  deps?: NativePipeAclDeps;
}

/**
 * Apply the owner-only DACL to a named pipe.
 *
 * On Win32: invokes `deps.applyOwnerOnly(pipePath)` synchronously.
 * Throws if the binding throws (fail-loud — see contract on
 * `NativePipeAclDeps.applyOwnerOnly`).
 *
 * On non-Win32: returns silently. POSIX gets owner-only access via
 * the unix-socket `chmod 0600` already performed by the socket
 * listener module; the enclosing data-dir `0700` is a second layer.
 *
 * Callers do NOT need to platform-guard with
 * `process.platform === 'win32'` — the cross-platform no-op stub
 * makes the call site uniform.
 *
 * @param pipePath Full path of the named pipe (e.g.
 *   `\\.\pipe\ccsm-daemon-<userSid>`). Ignored on non-Win32.
 * @param options Optional dependency injection. Defaults to the
 *   in-tree native binding loader (which throws until frag-11 lands
 *   the `ccsm_native.node` binding).
 */
export function applyPipeAcl(
  pipePath: string,
  options: ApplyPipeAclOptions = {},
): void {
  if (process.platform !== 'win32') {
    // POSIX path: unix-socket chmod 0600 is owned by
    // daemon/src/socket/listener.ts; this wrapper is intentionally
    // a no-op so call sites can be platform-agnostic.
    return;
  }

  const deps = options.deps ?? loadDefaultDeps();
  deps.applyOwnerOnly(pipePath);
}

/**
 * Production-default dependency loader. The in-tree
 * `ccsm_native.node` binding is owned by frag-11 (§3.5.1.1
 * "Built artifact name"); until it lands, this throws a clear
 * error directing callers to inject deps. Tests always inject; the
 * daemon runtime path will be wired in the
 * `daemon/src/native/index.ts` shim PR alongside the binding (per
 * §3.5.1.1.a "no direct native import" rule, this module is NOT
 * allowed to `require('../native/ccsm_native.node')` directly).
 *
 * The shellout fallback (`icacls "<pipePath>" /grant ...` or
 * `taskkill`-style hacks) is intentionally NOT implemented here.
 * `icacls` does not operate on named-pipe handles (it only handles
 * filesystem ACLs) and there is no shell command that can set
 * `PIPE_REJECT_REMOTE_CLIENTS` on an existing pipe — the spec
 * contract is the native binding, period. Shipping a shellout stub
 * would silently downgrade the spec's M1 "explicit DACL = current
 * SID" guarantee to "best-effort grant of filesystem ACL on a
 * non-existent path".
 */
function loadDefaultDeps(): NativePipeAclDeps {
  throw new Error(
    'applyPipeAcl: no default native deps available yet. ' +
      'Pass `options.deps` until the in-tree ccsm_native binding ' +
      '(frag-11 §11.4) lands and `daemon/src/native/index.ts` is wired.',
  );
}
