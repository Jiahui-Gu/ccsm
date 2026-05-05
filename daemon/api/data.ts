/**
 * Wave-2 A: HTTP endpoints for the modules that moved from electron/ into
 * daemon/ (db, sessionTitles, prefs, import-scanner, settings:defaultModel).
 *
 * Auto-registered by daemon/api/index.ts. Wire format mirrors what the
 * renderer already used over IPC, just shipped over HTTP:
 *   request:  POST /api/<group>/<op>  body = { args: [...] }
 *   response: 2xx { result: <value> } | non-2xx { error: <msg> }
 *
 * The renderer reaches these via the wave-1 fetch shim (window.ccsm) — see
 * src/lib/ipc/transport-fetch.ts — which packs the historical
 * `ipcRenderer.invoke(channel, ...args)` into the body shape above.
 *
 * Each endpoint is a thin shell that translates `body.args` into a call
 * against the canonical module function and wraps any throw into
 * `{ status: 500, error: <msg> }`. Errors are kept opaque to the renderer
 * (so a sqlite WAL hiccup degrades gracefully) but logged on stderr so
 * dogfood surfaces them.
 */

import type { Router, HandlerResult } from '../router';

import { loadState, saveState } from '../db';
import { validateSaveStateInput } from '../db-validate';
import { emitStateSaved } from '../shared/stateSavedBus';
import {
  getSessionTitle,
  listProjectSummaries,
  flushPendingRename,
} from '../sessionTitles';
import { getUserCwds, pushUserCwd } from '../prefs/userCwds';
import { scanImportableSessions } from '../import-scanner';
import { readDefaultModelFromSettings } from '../agent/read-default-model';

interface ArgsBody {
  args?: unknown;
}

// Read `body.args` defensively — the wire format is `{ args: [...] }` but a
// malformed renderer call may send `{}`, `null`, or omit the args field. We
// reject anything where `args` is present but isn't an array. Missing args
// is treated as `[]` so a no-arg endpoint (`{}` body) just works.
function readArgs(body: unknown): { ok: true; args: unknown[] } | { ok: false; error: string } {
  if (body === null || body === undefined) return { ok: true, args: [] };
  if (typeof body !== 'object') return { ok: false, error: 'invalid request: body must be an object' };
  const args = (body as ArgsBody).args;
  if (args === undefined) return { ok: true, args: [] };
  if (!Array.isArray(args)) {
    return { ok: false, error: 'invalid request: args must be an array' };
  }
  return { ok: true, args };
}

// Lift the daemon's `loadState` (which throws on corrupt sqlite reads) into
// the renderer-facing shape: any throw degrades to `null` so the renderer
// falls through to its default state instead of receiving an opaque error.
// Mirrors the legacy electron/ipc/dbIpc.ts handleDbLoad behavior.
function safeLoadState(key: string): string | null {
  try {
    return loadState(key);
  } catch (err) {
    process.stderr.write(
      `[data-api] db:load failed for key=${key}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

// db:save mirrors the legacy electron/ipc/dbIpc.ts handleDbSave: validate,
// persist, then fan out the stateSavedBus event so per-key cache owners
// (prefs/crashReporting, prefs/notifyEnabled) drop their cached value.
function safeSaveState(
  key: unknown,
  value: unknown,
): { ok: true } | { ok: false; error: string } {
  const v = validateSaveStateInput(key, value);
  if (!v.ok) {
    if (v.error === 'value_too_large' && typeof value === 'string') {
      process.stderr.write(
        `[data-api] db:save rejecting oversized value (${value.length} bytes) for key=${String(key)}\n`,
      );
    }
    return v;
  }
  try {
    saveState(key as string, value as string);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[data-api] db:save failed for key=${String(key)}: ${msg}\n`);
    return { ok: false, error: msg };
  }
  emitStateSaved(key as string);
  return { ok: true };
}

type AsyncFn = (args: unknown[]) => Promise<unknown> | unknown;

// Wrap a per-op function into the router's Handler shape: pull args out,
// invoke, return either { result } or { error }. Rejections become 500 with
// the error message so the renderer's fetch shim can surface a useful toast.
function makeHandler(fn: AsyncFn) {
  return async (
    _req: import('node:http').IncomingMessage,
    body: unknown,
  ): Promise<HandlerResult> => {
    const parsed = readArgs(body);
    if (!parsed.ok) return { status: 400, error: parsed.error };
    try {
      const result = await fn(parsed.args);
      return { status: 200, body: { result } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 500, error: msg };
    }
  };
}

export default function register(router: Router): void {
  // ── db ───────────────────────────────────────────────────────────────────
  router.addRoute(
    'POST',
    '/api/db/load',
    makeHandler(async (args) => {
      const key = String(args[0] ?? '');
      return safeLoadState(key);
    }),
  );
  router.addRoute(
    'POST',
    '/api/db/save',
    makeHandler(async (args) => {
      // Returns { ok: true } | { ok: false; error: ... } — preserved verbatim
      // as `result.<...>` so the renderer's saveState wrapper unwraps the
      // discriminant exactly like the old IPC handler.
      return safeSaveState(args[0], args[1]);
    }),
  );

  // ── sessionTitles ────────────────────────────────────────────────────────
  // Note: the security guard `safeDir` from the legacy electron handler is
  // NOT replicated here — the daemon binds 127.0.0.1 only, so the renderer
  // is the only reachable caller and renderer-supplied `dir` cannot be
  // injected from a remote attacker. The renderer is expected to forward
  // the same `dir` it always did. UNC/path-traversal hardening for SDK
  // calls remains a v0.4 concern (#804 risk #5 follow-up).
  router.addRoute(
    'POST',
    '/api/sessionTitles/get',
    makeHandler(async (args) => {
      const sid = String(args[0] ?? '');
      const dir = typeof args[1] === 'string' ? args[1] : undefined;
      return getSessionTitle(sid, dir);
    }),
  );
  router.addRoute(
    'POST',
    '/api/sessionTitles/listForProject',
    makeHandler(async (args) => {
      const projectKey = String(args[0] ?? '');
      return listProjectSummaries(projectKey);
    }),
  );
  router.addRoute(
    'POST',
    '/api/sessionTitles/flushPending',
    makeHandler(async (args) => {
      const sid = String(args[0] ?? '');
      await flushPendingRename(sid);
      return null;
    }),
  );

  // ── prefs / app ──────────────────────────────────────────────────────────
  router.addRoute(
    'POST',
    '/api/app/userCwds/get',
    makeHandler(async () => getUserCwds()),
  );
  router.addRoute(
    'POST',
    '/api/app/userCwds/push',
    makeHandler(async (args) => {
      const p = args[0];
      if (typeof p !== 'string') return getUserCwds();
      // No isSafePath gate here — that lives in electron/security and is W2-D
      // scope. v0.3 ship intent: keep behavior, move location.
      return pushUserCwd(p);
    }),
  );

  // ── settings ─────────────────────────────────────────────────────────────
  router.addRoute(
    'POST',
    '/api/settings/defaultModel',
    makeHandler(async () => {
      try {
        return await readDefaultModelFromSettings();
      } catch {
        return null;
      }
    }),
  );

  // ── import ───────────────────────────────────────────────────────────────
  // Note: the legacy electron/ipc/utilityIpc.ts had a hot-cache + background
  // refresh wrapper around scanImportableSessions for ImportDialog UX. v0.3
  // ship intent is "move location, not behavior" — we keep the cache here,
  // module-scoped, so cold opens still don't block on a multi-second scan.
  let importableCache: Awaited<ReturnType<typeof scanImportableSessions>> = [];
  let importablePending: ReturnType<typeof scanImportableSessions> | null = null;
  function refreshImportableCache() {
    if (importablePending) return importablePending;
    importablePending = scanImportableSessions()
      .then((rows) => {
        importableCache = rows;
        return rows;
      })
      .catch((err: unknown) => {
        process.stderr.write(
          `[data-api] scanImportableSessions failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return importableCache;
      })
      .finally(() => {
        importablePending = null;
      }) as ReturnType<typeof scanImportableSessions>;
    return importablePending;
  }
  router.addRoute(
    'POST',
    '/api/import/scan',
    makeHandler(async () => {
      if (importableCache.length > 0) {
        void refreshImportableCache();
        return importableCache;
      }
      return refreshImportableCache();
    }),
  );
  router.addRoute(
    'POST',
    '/api/import/recentCwds',
    makeHandler(async () => getUserCwds()),
  );
}
