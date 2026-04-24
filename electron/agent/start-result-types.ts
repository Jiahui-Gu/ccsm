/**
 * Shared types for `agent:start` IPC contract.
 *
 * Source of truth for the `StartErrorCode` union and the `StartResult`
 * shape. Imported by:
 *   - electron/agent/manager.ts (producer of StartResult on the main side)
 *   - electron/agent/sessions.ts (ClaudeSpawnFailedError.code)
 *   - electron/preload.ts        (re-exports the IPC return type)
 *
 * The renderer-side `src/global.d.ts` mirrors this union as string literals
 * because that file is a `.d.ts` ambient declaration consumed by the Vite
 * renderer build, not the electron tsconfig — so it can't import from here
 * directly. Keep them in sync; CI typecheck will catch drift if a code value
 * is used in a discriminated check on either side.
 */
export type StartErrorCode = 'CLAUDE_NOT_FOUND' | 'CWD_MISSING' | 'CLI_SPAWN_FAILED';

export type StartResult =
  | { ok: true }
  | {
      ok: false;
      error: string;
      errorCode?: StartErrorCode;
      searchedPaths?: string[];
      /**
       * Tail of stderr (or the libuv error message) captured during the
       * early-failure window. Populated for `CLI_SPAWN_FAILED` so the
       * renderer banner can show the user *why* the CLI bailed (missing
       * dependency, bad shim, stale env, etc.) instead of an opaque
       * "failed to start".
       */
      detail?: string;
    };
