// PtyService.CheckClaudeAvailable handler — Task #464 (ship-gate, v0.3
// zero-rework). Spec ref: pty.proto §F6 (forever-stable lookup), chapter 08
// §6.1 (renderer's "claude not installed" empty-state), chapter 10 §5
// (Settings-derived `claude_binary_path` is a v0.4 follow-up — v0.3 path
// lookup is the only resolution strategy).
//
// Why this handler ships now: the renderer's boot probe (`<App>` /
// `<ClaudeMissingGuide>`) used to call `window.ccsmPty.checkClaudeAvailable`
// over the legacy preload bridge. The Connect cutover left the RPC stubbed
// (Code.Unimplemented), so every renderer probe surfaces `available=false`,
// which strands the user on `<ClaudeMissingGuide>` even when claude IS on
// PATH. That's the v0.3 ship-blocker the manager flagged as #464.
//
// SRP layering — three roles, kept separate (dev.md §2):
//   - producer: `claudeResolver.resolveClaude({force})` — a single
//     `spawnSync('where'|'which', ...)` lookup with module-level cache.
//     Lives in `pty-host/...` because the same lookup feeds ttyd spawn;
//     this handler just consumes its verdict.
//   - decider: `decideClaudeAvailability(resolved)` — pure mapping from
//     a resolver result (string | null) to the wire response shape. No
//     side effects, no Connect plumbing. Exported for unit tests.
//   - sink:    `makeCheckClaudeAvailableHandler(deps)` — Connect-ES
//     handler that calls the producer, runs the decider, packages a
//     CheckClaudeAvailableResponse. The only place `create(...)` runs.
//
// Why deps-injected `resolveClaude` (instead of importing the module
// symbol directly):
//   - Mirrors `pty-attach.ts`'s `getEmitter` seam — the production wiring
//     binds `() => resolveClaude({force})` from `claudeResolver.ts`; the
//     spec's integration test injects a fake that returns null (claude
//     not installed) or a stub path (claude installed) without monkey-
//     patching `child_process.spawnSync`. Hermetic, no real `where`
//     invocation, no PATH mutation between cases.
//
// 5-tier "no wheel reinvention" judgement (dev.md §1 step 2):
//   1. `claudeResolver.resolveClaude` already exists in
//      `packages/daemon/src/ptyHost/claudeResolver.ts` and ships the
//      cached `spawnSync`-based PATH probe. No new lookup logic; this
//      handler is a thin RPC adapter over the existing resolver.
//   2. node:child_process / node:fs alternatives reject — the resolver
//      already encapsulates the platform difference (`where` vs `which`)
//      and the npm-shim `.cmd` quirk on Windows. Re-implementing here
//      would diverge from ttyd's spawn path.
//   3-5. n/a — single existing in-repo helper covers it.
//
// Settings-derived `claude_binary_path` (chapter 10 §5) is intentionally
// NOT consulted here in v0.3 — the SettingsService overlay does not yet
// expose a typed accessor and the spec calls it out as security-sensitive
// (config wins over PATH, but only via the supervisor-blessed Settings
// schema). Wiring it in is a v0.4 follow-up; the forever-stable wire
// shape (`available` / `resolved_path` / `version` / `error_code`)
// already accommodates the future precedence rule without a proto bump.

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
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

import { PRINCIPAL_KEY } from '../../auth/index.js';

/**
 * Producer port — structural shape for the claude-binary resolver. The
 * production wiring binds `() => resolveClaude({force: true})` from
 * `ptyHost/claudeResolver.ts`; tests pass an inline fake.
 *
 * Returns the absolute path of the resolved binary, or `null` if neither
 * `where claude.cmd` / `where claude` (Windows) nor `which claude`
 * (POSIX) found a match.
 *
 * Why `force: true` at the production boundary: the renderer surfaces
 * `<ClaudeMissingGuide>` whenever `available=false`, and the user's
 * "Re-check" affordance MUST observe a fresh PATH lookup after the user
 * installs claude in another terminal. A per-call `spawnSync('where',
 * ...)` costs ~5-15 ms — far cheaper than the UX cost of a stale cached
 * `null`. The resolver-level cache still helps the ttyd spawn path,
 * which is what it was originally designed for.
 */
export type ResolveClaudeFn = () => string | null;

/**
 * Dependencies the handler factory needs.
 */
export interface CheckClaudeAvailableDeps {
  readonly resolveClaude: ResolveClaudeFn;
}

/**
 * Pure decider — maps a resolver result to the wire response message.
 * Exported for unit tests so callers can pin the truth table without
 * spinning up the Connect handler context.
 *
 * `error_code` is intentionally narrow today: the resolver folds every
 * lookup failure (`where` exited non-zero, executable not found, etc.)
 * into `null`. Distinguishing ENOENT vs EACCES would require wider
 * resolver surface; for v0.3 we surface `'ENOENT'` whenever resolution
 * fails because that's the dominant failure mode and the renderer copy
 * (`<ClaudeMissingGuide>`) reads "not on PATH" as the only actionable
 * message either way.
 */
export function decideClaudeAvailability(
  resolved: string | null,
): {
  readonly available: boolean;
  readonly resolvedPath: string;
  readonly version: string;
  readonly errorCode: string;
} {
  if (resolved !== null && resolved.length > 0) {
    return {
      available: true,
      resolvedPath: resolved,
      // `claude --version` parsing is a v0.4 nice-to-have. Empty string
      // is the documented sentinel ("best-effort … empty on failure").
      version: '',
      errorCode: '',
    };
  }
  return {
    available: false,
    resolvedPath: '',
    version: '',
    // Single failure code today — see decider commentary above.
    errorCode: 'ENOENT',
  };
}

/**
 * Build the `PtyService.CheckClaudeAvailable` unary handler.
 *
 * Flow:
 *   1. Defensive: assert `peerCredAuthInterceptor` deposited a principal.
 *      Mirrors hello.ts / watch-sessions.ts / pty-attach.ts posture.
 *   2. Invoke the injected resolver. The renderer's mutation-flavored
 *      re-check binds `force=true`; the boot probe binds `force=false`.
 *   3. Run the pure decider; package the wire response.
 *
 * No ConnectError construction in the happy path — claude-not-installed
 * is a wire-OK response (`available=false`) per pty.proto §F6, NOT an
 * RPC failure. Reserving error-throw for principal-missing keeps the
 * client error-handling story uniform across RPCs (the cold-start modal
 * already differentiates `Code.Internal` "wiring bug" from "RPC said
 * no").
 */
export function makeCheckClaudeAvailableHandler(
  deps: CheckClaudeAvailableDeps,
): ServiceImpl<typeof PtyService>['checkClaudeAvailable'] {
  return async function checkClaudeAvailable(
    _req: CheckClaudeAvailableRequest,
    handlerContext: HandlerContext,
  ): Promise<CheckClaudeAvailableResponse> {
    const principal = handlerContext.values.get(PRINCIPAL_KEY);
    if (principal === null) {
      throw new ConnectError(
        'PtyService.CheckClaudeAvailable handler invoked without ' +
          'peerCredAuthInterceptor in chain (PRINCIPAL_KEY=null) — ' +
          'daemon wiring bug',
        Code.Internal,
      );
    }

    // Bind-time `force: true` (see ResolveClaudeFn commentary): cheap
    // spawnSync vs. a stale cached null on the user's "Re-check" path.
    const resolved = deps.resolveClaude();
    const decision = decideClaudeAvailability(resolved);

    return create(CheckClaudeAvailableResponseSchema, {
      meta: create(RequestMetaSchema, {}),
      available: decision.available,
      resolvedPath: decision.resolvedPath,
      version: decision.version,
      errorCode: decision.errorCode,
    });
  };
}
