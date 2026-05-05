// PtyService.CheckClaudeAvailable handler — first-paint claude probe.
//
// Task #464 / SHIP-GATE: pre-#464 the renderer's boot probe at
// `src/App.tsx:227` called `window.ccsmPty.checkClaudeAvailable()`. The
// `window.ccsmPty` bridge does not exist in v0.3 production (no preload
// installs it), so the optional chain returned `undefined`, the catch
// branch flipped `claudeAvailable` to `false`, and EVERY user — even the
// ones with claude correctly installed — saw `<ClaudeMissingGuide />`
// on first paint. Dogfood was wedged.
//
// The fix has two halves:
//   1. THIS FILE — the daemon-side real implementation. The wire RPC
//      `PtyService.CheckClaudeAvailable` was registered as
//      `Code.Unimplemented` since T2.2; this swaps in a real handler
//      that delegates to the existing `claudeResolver.ts` (`resolveClaude`)
//      and best-effort parses `claude --version` for the response.
//   2. The renderer-side polyfill in
//      `packages/electron/src/renderer/window-ccsm-pty-bridge.ts` that
//      installs `window.ccsmPty.checkClaudeAvailable` against the typed
//      Connect client built by `RendererBoot` (T6.6).
//
// SRP layering — three roles, kept separate (dev.md §2):
//   - producer: `claudeResolver.ts` (`resolveClaude({ force })`) + the
//               `node:child_process` `spawnSync` that invokes
//               `<resolved> --version`. Both are passed in via
//               `CheckClaudeAvailableDeps` so unit tests can supply
//               inline fakes (no global mocks).
//   - decider:  `decideCheckClaudeAvailable(input, ctx)` — pure
//               function `(input, ctx) -> CheckClaudeAvailableResponse`.
//               No I/O directly; calls `ctx.resolve` /
//               `ctx.runVersion` (which are the producer surfaces).
//               Translates `null` from the resolver into
//               `{ available: false, error_code: 'ENOENT' }`.
//   - sink:     `makeCheckClaudeAvailableHandler(deps)` — the Connect
//               handler signature wrapper. Echoes `meta.request_id`
//               back per spec ch04 §3 (every response carries the
//               same request_id the client supplied).
//
// 5-tier "no wheel reinvention" judgement (dev.md §1 step 2):
//   1. Repo: `claudeResolver.ts` already does the entire `where` /
//      `which` lookup with a success-cache and a `force: true` bypass.
//      We reuse it as-is; no duplicated lookup logic.
//   2. node:child_process `spawnSync` is the standard library way to
//      capture `--version` output; nothing new to add.
//   3. No new dep introduced — `claudeResolver` already lives in this
//      package and `node:child_process` is a built-in.
//   4. N/A — the surface is repo-bespoke (cache + force flag + binary
//      path resolution + error_code mapping for the proto response).
//   5. N/A — see above.
//
// Forever-stable spec ref (proto pty.proto §6 / ch04 §3):
//   message CheckClaudeAvailableRequest {
//     RequestMeta meta = 1;
//     bool force = 2;            // Task #464 round-2: bypass resolver cache (renderer recheck path)
//   }
//   message CheckClaudeAvailableResponse {
//     RequestMeta meta = 1;
//     bool available = 2;        // true iff resolveClaude() returned non-null
//     string resolved_path = 3;  // absolute path; empty when !available
//     string version = 4;        // best-effort `claude --version` parse; "" on failure
//     string error_code = 5;     // "ENOENT" / "EACCES" / "" — surfaces the lookup failure mode for UI messaging
//   }
//
// Why best-effort `--version` (not "fail the call if version parse fails"):
//   - The renderer only needs `available` to gate ClaudeMissingGuide vs.
//     the main UI. Version is observability / future-feature copy ("you
//     have claude X.Y.Z installed"). A `--version` invocation that
//     succeeds-the-binary-but-prints-garbage MUST still report
//     `available: true` so the user is not locked out of a working
//     installation by a parser quirk.
//   - We never SHELL OUT to a user-controlled binary on a
//     latency-critical first-paint path with a long timeout — the spawn
//     uses a hard 5s timeout. claude prints version in <100ms in
//     practice; 5s is generous for slow disks and gives an unambiguous
//     "the binary is wedged" signal (rare).

import { create } from '@bufbuild/protobuf';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import {
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';

import {
  CheckClaudeAvailableResponseSchema,
  RequestMetaSchema,
  type CheckClaudeAvailableRequest,
  type CheckClaudeAvailableResponse,
  type PtyService,
} from '@ccsm/proto';

import { resolveClaude as defaultResolveClaude } from '../../ptyHost/claudeResolver.js';

/**
 * Hard cap on `claude --version` execution time. claude prints version in
 * <100ms in practice; 5s is generous for slow disks. A wedged binary at
 * this point reports `available: true` (the resolution succeeded — the
 * binary exists) with `version: ''` (we couldn't parse it) — the user
 * still gets into the main UI; they just don't see version chrome.
 */
export const VERSION_PROBE_TIMEOUT_MS = 5000;

/**
 * Shape of the resolver port (mirrors `claudeResolver.ts`'s
 * `resolveClaude` signature). Injected via {@link CheckClaudeAvailableDeps}
 * so unit tests don't need to mock `node:child_process` against the
 * real resolver.
 */
export type ResolveClaudeFn = (opts?: { force?: boolean }) => string | null;

/**
 * Shape of the version-probe port. Production wires the `node:child_process`
 * `spawnSync`; tests pass an inline fake. Returns `null` when the spawn
 * fails (timeout / nonzero exit / throw); the decider treats `null` as
 * "binary is on PATH but version is unknown" — `available: true`,
 * `version: ''`.
 */
export type RunVersionFn = (resolvedPath: string) => string | null;

/**
 * Deps the handler factory needs. Both fields default to production
 * implementations when omitted (`resolveClaude` = the singleton resolver,
 * `runVersion` = the bounded `spawnSync` defined below) so production
 * startup wires `{}` and tests pass inline fakes.
 */
export interface CheckClaudeAvailableDeps {
  readonly resolveClaude?: ResolveClaudeFn;
  readonly runVersion?: RunVersionFn;
}

/**
 * Default version-probe — runs `<resolvedPath> --version` with a 5s
 * timeout and returns the trimmed stdout's first line. Returns `null`
 * for any non-success outcome (timeout, nonzero exit, throw, empty
 * stdout) so the decider can treat all failure modes uniformly.
 *
 * Exported for unit-test reuse — production callers should rely on the
 * `CheckClaudeAvailableDeps.runVersion` default rather than calling
 * this directly.
 */
export function defaultRunVersion(resolvedPath: string): string | null {
  try {
    const r = nodeSpawnSync(resolvedPath, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: VERSION_PROBE_TIMEOUT_MS,
    });
    if (r.status !== 0) return null;
    const first = r.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Pure decider verdict — discriminated only by `available` because the
 * proto response merges both branches into one schema. Tests can assert
 * on the verdict shape without parsing the proto-encoded response.
 */
export type CheckClaudeAvailableVerdict = {
  readonly available: boolean;
  readonly resolvedPath: string;
  readonly version: string;
  readonly errorCode: string;
};

/**
 * Pure decider. Calls `ctx.resolve({ force })` with the request's `force`
 * flag threaded through (Task #464 round-2: proto field
 * `CheckClaudeAvailableRequest.force` plumbs the renderer recheck signal
 * to the daemon resolver so a user who installs claude post-launch can
 * actually recover — pre-round-2 the resolver's cached `null` was sticky
 * because the wire request had no force field). When the resolver
 * returns `null`, surfaces `error_code: "ENOENT"` so the renderer can
 * pick UI copy ("install claude" vs. "permission denied" — though the
 * permission case lands in v0.4; v0.3 only emits ENOENT or "").
 *
 * When the resolver returns a path, runs `ctx.runVersion(path)` to
 * best-effort parse the version. A `null` return there yields
 * `version: ''` — see file header for why we do not fail the call in
 * that case.
 */
export function decideCheckClaudeAvailable(ctx: {
  readonly resolve: ResolveClaudeFn;
  readonly runVersion: RunVersionFn;
  readonly force?: boolean;
}): CheckClaudeAvailableVerdict {
  // Round-2: thread `force` to the resolver. Default `false` so the
  // first-paint probe enjoys the success cache; the renderer's recheck
  // button explicitly passes `true` to bypass it.
  const path = ctx.resolve({ force: ctx.force ?? false });
  if (path === null) {
    return {
      available: false,
      resolvedPath: '',
      version: '',
      errorCode: 'ENOENT',
    };
  }
  const version = ctx.runVersion(path) ?? '';
  return {
    available: true,
    resolvedPath: path,
    version,
    errorCode: '',
  };
}

/**
 * Build the Connect `ServiceImpl<typeof PtyService>['checkClaudeAvailable']`
 * handler. Echoes `meta.request_id` (spec ch04 §3 — every response
 * carries the same request_id the client supplied; the
 * `requestMetaInterceptor` validates non-empty before this runs, so we
 * can read it without a defensive null-check on the request side).
 */
export function makeCheckClaudeAvailableHandler(
  deps: CheckClaudeAvailableDeps = {},
): ServiceImpl<typeof PtyService>['checkClaudeAvailable'] {
  const resolve = deps.resolveClaude ?? defaultResolveClaude;
  const runVersion = deps.runVersion ?? defaultRunVersion;
  return (
    req: CheckClaudeAvailableRequest,
    _handlerContext: HandlerContext,
  ): CheckClaudeAvailableResponse => {
    // Round-2: thread `req.force` (proto field 2) into the decider so the
    // resolver bypasses its in-process cache when the renderer recheck
    // button asks for it. Generated proto type defaults `force` to
    // `false` for unset wire bytes, so backward-compatible with pre-#464
    // callers that don't set the field.
    const verdict = decideCheckClaudeAvailable({
      resolve,
      runVersion,
      force: req.force,
    });
    return create(CheckClaudeAvailableResponseSchema, {
      meta: create(RequestMetaSchema, {
        requestId: req.meta?.requestId ?? '',
        clientVersion: req.meta?.clientVersion ?? '',
        clientSendUnixMs: req.meta?.clientSendUnixMs ?? 0n,
      }),
      available: verdict.available,
      resolvedPath: verdict.resolvedPath,
      version: verdict.version,
      errorCode: verdict.errorCode,
    });
  };
}
