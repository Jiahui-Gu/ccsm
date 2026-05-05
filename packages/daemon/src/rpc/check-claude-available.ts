// PtyService.CheckClaudeAvailable handler — daemon-side resolver that
// answers "is the `claude` CLI binary discoverable AND runnable?" so the
// renderer can render the right empty state and gate CreateSession.
//
// Spec refs:
//   - docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//     ch04 §6 (RPC contract).
//     ch08 (renderer empty-state ↔ daemon-side claude resolution).
//     ch10 §5 (`claude_binary_path` config — install-time only, NOT
//             RPC-settable for security; daemon-owned PATH lookup is the
//             fallback).
//   - docs/superpowers/specs/2026-05-05-v03-test-shells.md §2.3
//     (test shells: available=true with version on PATH /
//                   available=false with reason when missing /
//                   available=false with reason when version probe times out).
//   - packages/proto/src/ccsm/v1/pty.proto line 30 / 143-154
//     (CheckClaudeAvailableRequest{meta};
//      CheckClaudeAvailableResponse{meta, available, resolved_path,
//                                   version, error_code}).
//
// SRP layering — three roles kept separate (dev.md §2):
//   - decider: `composeResponse` is implicit — the handler body picks
//              the response shape from the (resolver, versionProbe)
//              outcomes via a small `switch` on a discriminated union.
//              Pure mapping, no side effects.
//   - producer: TWO seams, both injected:
//                  (1) `resolver` — resolves the absolute claude binary
//                      path (PATH walk via `node:child_process` +
//                      `node:fs` per task spec — "no new deps").
//                  (2) `versionProbe` — spawns `<path> --version` with a
//                      2s AbortSignal-backed timeout and parses stdout.
//   - sink:    `makeCheckClaudeAvailableHandler(deps)` — Connect handler
//              factory. Reads PRINCIPAL_KEY (defensive only — this RPC
//              is open to any authenticated principal; the response is
//              host-wide, not principal-scoped, because the binary is a
//              daemon-process resource per ch10 §5), runs the resolver,
//              runs the version probe IFF the resolver succeeded, maps
//              outcomes into the proto response.
//
// Layer 1 — alternatives checked:
//   - `which` npm package: rejected — task spec says "no new deps;
//     PATH lookup is `node:child_process` + native PATH walk". The
//     PATH-walk implementation below is ~30 lines and avoids the dep.
//   - `execa` for the version probe: rejected — same reason; `node:child_process.spawn`
//     plus the standard AbortSignal timeout pattern is enough and is
//     already used by `pty-host/host.ts` (`fork`).
//   - Cache the resolution across calls: rejected for v0.3 — the
//     renderer calls this RPC at most a handful of times across an
//     entire boot (initial check + on user "rescan" action). Caching
//     just adds a stale-detection question (what if the user installs
//     claude after first check?). Out of scope here — a future
//     optimization can add a TTL behind the same handler shape with
//     no wire change.

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';
import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter as PATH_DELIMITER, join } from 'node:path';

import {
  CheckClaudeAvailableResponseSchema,
  type CheckClaudeAvailableRequest,
  type PtyService,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, type Principal as AuthPrincipal } from '../auth/index.js';

// ---------------------------------------------------------------------------
// Resolver / versionProbe seams
// ---------------------------------------------------------------------------

/**
 * Outcome of resolving the `claude` binary path. Discriminated union so
 * the handler can render `error_code` distinctly per failure mode (proto
 * field carries `"ENOENT"` / `"EACCES"` / `""`).
 *
 * `error_code` strings mirror the POSIX errno mnemonics the proto field
 * documents — these are forever-stable wire values per ch04 §6.
 */
export type ResolveOutcome =
  | { readonly kind: 'found'; readonly path: string }
  | {
      readonly kind: 'missing';
      /** "ENOENT" | "EACCES" | other errno mnemonic, or "" if unknown. */
      readonly errorCode: string;
    };

export type ClaudeBinaryResolver = () => Promise<ResolveOutcome>;

/**
 * Outcome of probing `<path> --version`. Discriminated so the handler
 * can distinguish "ran cleanly" from "timed out" from "crashed".
 *
 * `version` is the trimmed first line of stdout — the daemon does NOT
 * apply a regex; ch04 §6 calls the field "best-effort `claude --version`
 * parse" with `""` on failure.
 */
export type VersionProbeOutcome =
  | { readonly kind: 'ok'; readonly version: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'failed'; readonly errorCode: string };

export type ClaudeVersionProbe = (
  path: string,
  signal: AbortSignal,
) => Promise<VersionProbeOutcome>;

export interface CheckClaudeAvailableDeps {
  /**
   * Resolve the absolute path to the claude binary via PATH walk (or
   * the install-time configured path if the production wiring chains
   * one in). MUST NOT throw; surface failures via the discriminated
   * union so the handler renders `available=false` cleanly.
   */
  readonly resolver: ClaudeBinaryResolver;
  /**
   * Spawn `<path> --version` with the supplied AbortSignal (handler
   * arms a 2s timeout). MUST NOT throw; surface failures via the
   * discriminated union.
   */
  readonly versionProbe: ClaudeVersionProbe;
  /**
   * Override the version-probe timeout. Production = 2_000 ms; tests
   * pass a small value so the "times out" case completes quickly.
   * Default 2_000 ms when omitted.
   */
  readonly versionProbeTimeoutMs?: number;
}

/** Default version-probe timeout (spec ch08 footnote). */
export const DEFAULT_VERSION_PROBE_TIMEOUT_MS = 2_000;

// ---------------------------------------------------------------------------
// Default resolver — node:child_process + native PATH walk (no new deps)
// ---------------------------------------------------------------------------

/**
 * PATH-walk resolver factory. Reads `process.env.PATH` and (on Windows)
 * `process.env.PATHEXT` to find the first executable named `claude`
 * (`claude.exe` on Windows). Returns the absolute path on success or
 * `{kind:'missing', errorCode}` on failure.
 *
 * Pure factory: takes the env + platform as inputs so unit tests can
 * exercise the walk without touching the real filesystem (tests pass
 * a fake PATH containing a tmpdir + a fake binary).
 *
 * Production wiring: `defaultClaudeResolver({ env: process.env, platform:
 * process.platform })`.
 */
export function defaultClaudeResolver(opts: {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** Override fs.accessSync — tests inject a stub. */
  readonly accessSyncImpl?: (p: string, mode?: number) => void;
}): ClaudeBinaryResolver {
  const access = opts.accessSyncImpl ?? accessSync;
  const isWindows = opts.platform === 'win32';
  const exeName = 'claude';
  // PATHEXT on Windows enumerates the executable suffixes the shell
  // would auto-append. POSIX: empty list (no suffix).
  const exts: readonly string[] = isWindows
    ? (opts.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.trim()).filter((e) => e.length > 0)
    : [''];
  const pathDirs = (opts.env.PATH ?? '').split(PATH_DELIMITER).filter((d) => d.length > 0);
  return async function resolveClaude(): Promise<ResolveOutcome> {
    let lastError = 'ENOENT';
    for (const dir of pathDirs) {
      for (const ext of exts) {
        const candidate = join(dir, `${exeName}${ext}`);
        try {
          // F_OK = exists; X_OK = executable bit (POSIX). On Windows
          // node ignores X_OK and just checks existence — which is the
          // right behavior because the .exe-suffix filtering already
          // gates "executability".
          access(candidate, fsConstants.F_OK | fsConstants.X_OK);
          return { kind: 'found', path: candidate };
        } catch (err) {
          // Capture the most informative errno we observe — EACCES
          // (file exists, no exec bit) is more useful to surface than
          // a parade of ENOENTs from non-matching dirs.
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          if (code === 'EACCES') {
            lastError = 'EACCES';
          }
        }
      }
    }
    return { kind: 'missing', errorCode: lastError };
  };
}

// ---------------------------------------------------------------------------
// Default version probe — spawn(path, ['--version']) with AbortSignal
// ---------------------------------------------------------------------------

/**
 * Default version-probe implementation: spawn `<path> --version`,
 * collect stdout to EOF (capped), trim and return the first line.
 *
 * The supplied AbortSignal is wired through to `spawn`'s `signal`
 * option — when it fires the child is SIGTERM'd and the promise
 * resolves with `{kind:'timeout'}`. No race window: the spawn-level
 * signal handling is an AbortError on the 'error' event, distinct
 * from a non-zero exit.
 */
export const defaultVersionProbe: ClaudeVersionProbe = (path, signal) => {
  return new Promise<VersionProbeOutcome>((resolve) => {
    let stdout = '';
    const MAX_BYTES = 4_096; // version strings are ≤ ~80 chars; cap defensively
    const child = spawn(path, ['--version'], {
      signal,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length < MAX_BYTES) {
        stdout += chunk.slice(0, MAX_BYTES - stdout.length);
      }
    });
    let settled = false;
    const settle = (outcome: VersionProbeOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    child.on('error', (err) => {
      const errno = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
      if (errno === 'ABORT_ERR' || (err as Error).name === 'AbortError') {
        settle({ kind: 'timeout' });
        return;
      }
      settle({ kind: 'failed', errorCode: errno });
    });
    child.on('close', (code) => {
      if (code === 0) {
        const firstLine = stdout.split(/\r?\n/, 1)[0] ?? '';
        settle({ kind: 'ok', version: firstLine.trim() });
      } else {
        settle({ kind: 'failed', errorCode: `EXIT_${code ?? 'NULL'}` });
      }
    });
  });
};

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Build the `PtyService.CheckClaudeAvailable` unary handler.
 *
 * Flow per ch04 §6 + test shell §2.3:
 *   1. Defensive PRINCIPAL_KEY check (open to any authenticated
 *      principal — see file header for why no per-session ownership
 *      check applies).
 *   2. `resolver()` — PATH walk.
 *   3. If missing: respond `available=false`, error_code from outcome.
 *   4. If found: arm 2s AbortSignal, run `versionProbe(path, signal)`.
 *   5. Map probe outcome to response (`ok` => available=true with
 *      version; `timeout` / `failed` => available=false with reason —
 *      "binary present but not runnable" is still "claude not usable"
 *      from the renderer's perspective; ch04 §6 says `available` is
 *      "true iff daemon successfully resolved an executable").
 */
export function makeCheckClaudeAvailableHandler(
  deps: CheckClaudeAvailableDeps,
): ServiceImpl<typeof PtyService>['checkClaudeAvailable'] {
  const timeoutMs = deps.versionProbeTimeoutMs ?? DEFAULT_VERSION_PROBE_TIMEOUT_MS;
  return async function checkClaudeAvailable(
    _req: CheckClaudeAvailableRequest,
    handlerContext: HandlerContext,
  ) {
    const principal: AuthPrincipal | null = handlerContext.values.get(PRINCIPAL_KEY);
    if (principal === null) {
      throw new ConnectError(
        'PtyService.CheckClaudeAvailable handler invoked without peerCredAuthInterceptor in chain ' +
          '(PRINCIPAL_KEY=null) — daemon wiring bug',
        Code.Internal,
      );
    }

    const resolved = await deps.resolver();
    if (resolved.kind === 'missing') {
      return create(CheckClaudeAvailableResponseSchema, {
        meta: _req.meta,
        available: false,
        resolvedPath: '',
        version: '',
        errorCode: resolved.errorCode,
      });
    }

    // Arm a 2s timeout via AbortController. We always abort on the
    // finally so a fast `ok` response doesn't leak the timer.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let probe: VersionProbeOutcome;
    try {
      probe = await deps.versionProbe(resolved.path, ac.signal);
    } finally {
      clearTimeout(timer);
    }

    switch (probe.kind) {
      case 'ok':
        return create(CheckClaudeAvailableResponseSchema, {
          meta: _req.meta,
          available: true,
          resolvedPath: resolved.path,
          version: probe.version,
          errorCode: '',
        });
      case 'timeout':
        return create(CheckClaudeAvailableResponseSchema, {
          meta: _req.meta,
          available: false,
          resolvedPath: resolved.path,
          version: '',
          errorCode: 'ETIMEDOUT',
        });
      case 'failed':
        return create(CheckClaudeAvailableResponseSchema, {
          meta: _req.meta,
          available: false,
          resolvedPath: resolved.path,
          version: '',
          errorCode: probe.errorCode,
        });
      default: {
        const _exhaustive: never = probe;
        throw new Error(
          `unhandled VersionProbeOutcome: ${String((_exhaustive as { kind: string }).kind)}`,
        );
      }
    }
  };
}
