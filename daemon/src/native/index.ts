// daemon/src/native/index.ts — single import seat for ccsm_native.
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-3.5.1-pty-hardening.md
//   §3.5.1.1.a "Native binding swap interface (lockin-P0-2)"
//
//   "All call sites go through a TypeScript interface, never the raw
//    `.node` exports."
//   "No call site in `daemon/src/pty/**` or `daemon/src/socket/**`
//    may import `ccsm_native.node` directly."
//
// This module is the ONLY place in the daemon allowed to load the
// .node binary. The custom ESLint rule `no-direct-native-import`
// (registered in `eslint.config.js`) enforces it.
//
// What this module exports:
//   - `native: NativeBinding`            — the swap interface
//   - `loadCcsmNative()`                 — explicit loader (test seam)
//   - `IsBindingMissingError(err)`       — type guard for missing-binary
//
// What it does NOT do:
//   - logging (consumers are pure deciders/sinks; logging belongs to
//     the top-level daemon entry)
//   - retries (the loader is synchronous; if the .node fails to load
//     the daemon must fail boot, not enter a degraded state — per
//     frag-3.5.1 §3.5.1.6 acceptance "lint passes on full daemon
//     tree" implies the binding is present at runtime)

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Socket } from 'node:net';

import type { NativePeerCredDeps } from '../sockets/peer-cred-verify.js';
import type {
  NativeWinjobDeps,
  JobHandle,
} from '../pty/win-jobobject.js';
import type { NativePipeAclDeps } from '../pty/pipe-acl.js';
import type {
  SigchldReaperDeps,
  WaitpidResult,
} from '../pty/sigchld-reaper.js';

// ---------------------------------------------------------------------------
// Public swap interface (the spec's `NativeBinding`).
// ---------------------------------------------------------------------------

/**
 * Linux PR_SET_PDEATHSIG self-arm. Documented in
 * `daemon/src/pty/sigchld-reaper.ts` and frag-3.5.1 §3.5.1.2.
 * Throws `Error { code: 'ENOSYS' }` on non-Linux.
 */
export interface NativePdeathsigDeps {
  armSelf(signal: number): void;
}

/**
 * The full surface set, as seen by the daemon. Each surface is the
 * same shape consumed by its respective decider module:
 *
 *   - peerCred  : `NativePeerCredDeps` (sockets/peer-cred-verify.ts)
 *   - winjob    : `NativeWinjobDeps`   (pty/win-jobobject.ts)
 *   - pipeAcl   : `NativePipeAclDeps`  (pty/pipe-acl.ts)
 *   - pdeathsig : `NativePdeathsigDeps` (above; consumed inside the
 *                 daemon process — typically right before node-pty
 *                 spawn — to arm SIGTERM-on-parent-exit on Linux)
 *   - sigchld   : `SigchldReaperDeps`  (pty/sigchld-reaper.ts)
 *
 * Per frag-3.5.1 §3.5.1.1.a "Implementations live in
 * `daemon/src/native/impl/napi.ts` (default — wraps
 * `ccsm_native.node`) and a future `daemon/src/native/impl/koffi.ts`
 * (deferred). Swap is a single-file edit in `loadBinding()`."
 */
export interface NativeBinding {
  peerCred: NativePeerCredDeps;
  winjob: NativeWinjobDeps;
  pipeAcl: NativePipeAclDeps;
  pdeathsig: NativePdeathsigDeps;
  sigchld: SigchldReaperDeps;
  /** Embedded build-time version string from the .node (sanity probe). */
  bindingVersion: string;
}

// ---------------------------------------------------------------------------
// .node loader (production path).
// ---------------------------------------------------------------------------

/**
 * Raw shape of `ccsm_native.node` exports. Mirrors the C++
 * `Init` function in `daemon/native/ccsm_native/src/ccsm_native.cc`.
 * Kept private — callers consume the typed `NativeBinding` instead.
 */
interface RawNativeModule {
  bindingVersion: string;
  winjob: {
    create(): JobHandle;
    assign(handle: JobHandle, pid: number): void;
    terminate(handle: JobHandle, exitCode: number): void;
  };
  pipeAcl: {
    applyOwnerOnly(pipePath: string): void;
  };
  pdeathsig: {
    armSelf(signal: number): void;
  };
  peerCred: {
    getNamedPipeClientProcessId?(socket: Socket): number;
    openProcessTokenUserSid?(pid: number): string;
    getsockoptPeerCred?(socket: Socket): {
      uid: number;
      gid: number;
      pid: number;
    };
    getpeereid?(socket: Socket): { uid: number; gid: number };
  };
  sigchld: {
    subscribe(handler: () => void): () => void;
    waitpid(pid: number): WaitpidResult;
  };
}

/** Marker error class so callers can `if (IsBindingMissingError(e))`. */
export class CcsmNativeMissingError extends Error {
  override readonly name = 'CcsmNativeMissingError';
  readonly resolvedFrom: string;
  override readonly cause: unknown;
  constructor(resolvedFrom: string, cause: unknown) {
    super(
      `ccsm_native.node could not be loaded from "${resolvedFrom}". ` +
        `This is the in-tree N-API helper from ` +
        `daemon/native/ccsm_native/. Build it with ` +
        `\`npm run rebuild:natives\` or run the CI ` +
        `\`ccsm-native\` workflow. ` +
        `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.resolvedFrom = resolvedFrom;
    this.cause = cause;
  }
}

export function IsBindingMissingError(
  e: unknown,
): e is CcsmNativeMissingError {
  return e instanceof CcsmNativeMissingError;
}

/**
 * Resolve the per-platform `.node` artifact path. The rebuild script
 * (`scripts/electron-rebuild-natives.cjs`) writes to
 * `daemon/native/<platform>-<arch>/ccsm_native.node`; the dev path
 * (`node-gyp rebuild` invoked directly inside
 * `daemon/native/ccsm_native/`) writes to
 * `daemon/native/ccsm_native/build/Release/ccsm_native.node`.
 *
 * We try both, in order. The first hit wins.
 */
function candidatePaths(): string[] {
  // ESM-safe __dirname: this file is `daemon/src/native/index.ts`,
  // which compiles to `daemon/dist-daemon/native/index.js`. From
  // there we walk up to the daemon root, then into `native/`.
  const here = path.dirname(fileURLToPath(import.meta.url));
  // From daemon/dist-daemon/native/  →  daemon/  is two levels up.
  const daemonRoot = path.resolve(here, '..', '..');
  const platformArch = `${process.platform}-${process.arch}`;
  return [
    path.join(daemonRoot, 'native', platformArch, 'ccsm_native.node'),
    path.join(
      daemonRoot,
      'native',
      'ccsm_native',
      'build',
      'Release',
      'ccsm_native.node',
    ),
  ];
}

/**
 * Synchronous loader. Tries each candidate path; the first that loads
 * cleanly wins. Throws `CcsmNativeMissingError` if every candidate
 * fails. Intended to be called once at daemon boot.
 *
 * Test seam: callers may pass an explicit `paths` override to load a
 * .node from a custom location (e.g. CI smoke test).
 */
export function loadCcsmNative(
  paths: string[] = candidatePaths(),
): NativeBinding {
  // createRequire so this ESM module can `require` a CJS .node
  // without relying on the host bundler.
  const req = createRequire(import.meta.url);
  let lastErr: unknown = null;
  let lastTried = '';
  for (const p of paths) {
    try {
      lastTried = p;
      const mod = req(p) as RawNativeModule;
      return adaptRaw(mod);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new CcsmNativeMissingError(lastTried, lastErr);
}

function adaptRaw(raw: RawNativeModule): NativeBinding {
  // Per-platform narrowing. We attach only the methods that the
  // platform's binding actually implements — the other methods stay
  // `undefined` so the `verifyPeerCred` decider's existing
  // "deps missing -> wire ccsm_native (frag-11)" branch catches a
  // misconfigured call site cleanly. (The Win/POSIX stub .cc files
  // already throw ENOSYS if anyone reaches them anyway; this is
  // belt-and-braces.)
  const peerCred: NativePeerCredDeps = {};
  if (process.platform === 'win32') {
    peerCred.getNamedPipeClientProcessId =
      raw.peerCred.getNamedPipeClientProcessId;
    peerCred.openProcessTokenUserSid = raw.peerCred.openProcessTokenUserSid;
  } else if (process.platform === 'linux') {
    peerCred.getsockoptPeerCred = raw.peerCred.getsockoptPeerCred;
  } else if (process.platform === 'darwin') {
    peerCred.getpeereid = raw.peerCred.getpeereid;
  }

  const sigchld: SigchldReaperDeps =
    process.platform === 'win32'
      ? // Win has no SIGCHLD; consumers MUST guard with
        // `process.platform !== 'win32'` per the JS-side contract,
        // so these throw the same way the .cc stub does.
        {
          onSigchld: () => {
            throw enosys('sigchld.onSigchld');
          },
          waitpid: () => {
            throw enosys('sigchld.waitpid');
          },
        }
      : {
          // Spec: `onSigchld(handler) -> detach`. The .node export
          // is named `subscribe` (clearer in the C++ context); the
          // adapter renames so the JS-side contract from
          // `sigchld-reaper.ts` is honoured verbatim.
          onSigchld: (handler) => raw.sigchld.subscribe(handler),
          waitpid: (pid) => raw.sigchld.waitpid(pid),
        };

  return {
    bindingVersion: raw.bindingVersion,
    winjob: raw.winjob,
    pipeAcl: raw.pipeAcl,
    pdeathsig: raw.pdeathsig,
    peerCred,
    sigchld,
  };
}

function enosys(op: string): Error {
  const e = new Error(`${op}: ENOSYS (not supported on this platform)`);
  (e as Error & { code?: string }).code = 'ENOSYS';
  return e;
}

// ---------------------------------------------------------------------------
// Lazy singleton.
// ---------------------------------------------------------------------------

let cached: NativeBinding | null = null;

/**
 * Lazy-loaded singleton accessor. The first call resolves the
 * binding; subsequent calls return the same instance. Throws
 * `CcsmNativeMissingError` on first-call failure; caches the throw
 * so subsequent calls re-throw without re-trying the dlopen (which
 * would not change outcome and would multiply boot-time noise).
 */
let cachedError: CcsmNativeMissingError | null = null;
export function native(): NativeBinding {
  if (cached !== null) return cached;
  if (cachedError !== null) throw cachedError;
  try {
    cached = loadCcsmNative();
    return cached;
  } catch (err) {
    if (err instanceof CcsmNativeMissingError) {
      cachedError = err;
    }
    throw err;
  }
}

/**
 * Test-only: reset the cached singleton. Production code never calls
 * this. Tests use it to swap in fakes between cases.
 */
export function __resetNativeCacheForTests(): void {
  cached = null;
  cachedError = null;
}

/**
 * Test-only: inject a pre-built `NativeBinding` (used to exercise the
 * `native()` accessor without a real .node present).
 */
export function __setNativeForTests(b: NativeBinding | null): void {
  cached = b;
  cachedError = null;
}
