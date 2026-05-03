/**
 * Main-process bridge to `@anthropic-ai/claude-agent-sdk` session-title APIs.
 *
 * Exposes three operations to the renderer over IPC:
 *   - `getSessionTitle(sid, dir?)`     → SDK `getSessionInfo`
 *   - `renameSessionTitle(sid, t, d?)` → SDK `renameSession`
 *   - `listProjectSummaries(projectKey)` → SDK `listSessions({ dir: projectKey })`
 *
 * Substrate concerns folded in here so callers (PR2 store wiring, PR3 watcher,
 * PR4 backfill) never have to reimplement them:
 *
 * 1. Per-sid serialization. A `Map<sid, Promise<unknown>>` chains every
 *    operation against the same sid. Two `renameSession(A)` calls fired in
 *    rapid succession — or a rename racing a `getSessionInfo` — would
 *    otherwise interleave SDK fs writes against the JSONL file. The chain
 *    keeps each sid's operations strictly ordered FIFO. Different sids are
 *    independent and run in parallel.
 *
 * 2. 2-second TTL cache on `getSessionTitle`. Renderer Sidebar can render the
 *    same session row multiple times during a state burst; without a cache
 *    each render would re-stat the JSONL file. Invalidated on any successful
 *    rename of the same sid.
 *
 * 3. Error normalization. SDK throws raw fs errors (`ENOENT`) and validation
 *    errors. We classify ENOENT as `'no_jsonl'` (session file not yet
 *    written — common right after `query()` starts) and everything else as
 *    `'sdk_threw'`. The IPC boundary always sees a result discriminated
 *    union, never an exception.
 *
 * 4. `pendingRenames` queue. PR2 needs to "remember" a user-set title before
 *    the first message has flushed the JSONL file (otherwise SDK's
 *    `renameSession` will throw ENOENT). The store enqueues; PR3's watcher
 *    flushes on the first frame. Lives here so the bridge owns all SDK
 *    interaction in one place.
 */

import type {
  getSessionInfo as GetSessionInfoFn,
  renameSession as RenameSessionFn,
  listSessions as ListSessionsFn,
} from '@anthropic-ai/claude-agent-sdk';

import { classifyError, decideRetry, decideRequeue } from './deciders.js';

// `@anthropic-ai/claude-agent-sdk` is published as ESM-only (sdk.mjs). Our
// Electron main bundle compiles to CommonJS (tsconfig.electron.json:
// `module: CommonJS`), so a static `import { ... } from '...'` becomes a
// `require()` call at runtime — which Node refuses for an ESM module
// (ERR_REQUIRE_ESM, blocks the whole app from booting). We resolve the SDK
// once via dynamic `import()` and cache the live exports for every later
// call. The first SDK-touching IPC pays the import cost (~tens of ms);
// every subsequent call is a Map / Promise hit only.
type SdkExports = {
  getSessionInfo: typeof GetSessionInfoFn;
  renameSession: typeof RenameSessionFn;
  listSessions: typeof ListSessionsFn;
};
let sdkPromise: Promise<SdkExports> | null = null;
async function loadSdk(): Promise<SdkExports> {
  if (!sdkPromise) {
    // CommonJS-build trap: a literal `await import('@anthropic-ai/...')` is
    // transpiled by `tsc` (with `module: CommonJS`) into `require(...)`,
    // which Node refuses for an ESM-only package (ERR_REQUIRE_ESM). Wrap
    // the dynamic import in `new Function` so the call survives transpile
    // intact and is evaluated as a real ESM `import()` at runtime.
    //
    // Side effect: vitest's `vi.mock('@anthropic-ai/claude-agent-sdk', …)`
    // can't intercept this loader (the mock resolver only sees static
    // imports). Tests inject mocks via `__setSdkForTests` instead.
    const dynamicImport = new Function(
      'spec',
      'return import(spec)'
    ) as (spec: string) => Promise<typeof import('@anthropic-ai/claude-agent-sdk')>;
    sdkPromise = dynamicImport('@anthropic-ai/claude-agent-sdk').then((mod) => ({
      getSessionInfo: mod.getSessionInfo,
      renameSession: mod.renameSession,
      listSessions: mod.listSessions,
    }));
  }
  return sdkPromise;
}

// ─────────────────────────── Public types ────────────────────────────────

export type RenameResult =
  | { ok: true }
  | { ok: false; reason: 'no_jsonl' | 'sdk_threw'; message?: string };

export type SummaryResult = {
  summary: string | null;
  mtime: number | null;
};

export type ProjectSummary = {
  sid: string;
  summary: string | null;
  mtime: number;
};

// ─────────────────────────── Internal state ──────────────────────────────

const CACHE_TTL_MS = 2000;

type CacheEntry = { result: SummaryResult; expiresAt: number };
const titleCache = new Map<string, CacheEntry>();

// Per-sid op chain. Each new operation awaits the previous one (success OR
// failure — we swallow the rejection inside the chain so a single failed call
// doesn't poison every later call on the same sid). Independent sids never
// touch each other.
const opChains = new Map<string, Promise<unknown>>();

function chain<T>(sid: string, fn: () => Promise<T>): Promise<T> {
  const prev = opChains.get(sid) ?? Promise.resolve();
  // `.catch(() => undefined)` so a prior failure doesn't reject the whole
  // chain; each caller still sees its own resolved/rejected value below.
  const next = prev.catch(() => undefined).then(fn);
  opChains.set(
    sid,
    next.catch(() => undefined)
  );
  return next;
}

// Pending-rename queue (consumed by PR2). Stored verbatim and replayed by
// `flushPendingRename` once the watcher reports the JSONL exists.
type PendingRename = { title: string; dir?: string };
const pendingRenames = new Map<string, PendingRename>();

// ─────────────────────────── Helpers ─────────────────────────────────────
// Pure deciders (classifyError, decideRetry, decideRequeue) live in
// `./deciders.ts`. This file owns the side effects (caches, op chains,
// pending queue) and the SDK loader; it imports the pure logic.

// ─────────────────────────── Public API ──────────────────────────────────

export async function getSessionTitle(
  sid: string,
  dir?: string
): Promise<SummaryResult> {
  const now = Date.now();
  const cached = titleCache.get(sid);
  if (cached && cached.expiresAt > now) {
    return cached.result;
  }

  const result = await chain(sid, async (): Promise<SummaryResult> => {
    try {
      const { getSessionInfo } = await loadSdk();
      const info = await getSessionInfo(sid, dir ? { dir } : undefined);
      if (!info) return { summary: null, mtime: null };
      return {
        summary: info.summary ?? null,
        mtime: typeof info.lastModified === 'number' ? info.lastModified : null,
      };
    } catch (err) {
      // Read-side errors are not surfaced; the renderer just sees "no title".
      // We log so we can spot SDK-level breakage, but don't escalate.
      const cls = classifyError(err);
      if (cls.reason !== 'no_jsonl') {
        console.warn(`[sessionTitles] getSessionInfo(${sid}) threw:`, cls.message);
      }
      return { summary: null, mtime: null };
    }
  });

  titleCache.set(sid, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

export async function renameSessionTitle(
  sid: string,
  title: string,
  dir?: string
): Promise<RenameResult> {
  return chain(sid, async (): Promise<RenameResult> => {
    try {
      const { renameSession } = await loadSdk();
      await renameSession(sid, title, dir ? { dir } : undefined);
      // Invalidate cached title — next read must reflect the new value.
      titleCache.delete(sid);
      return { ok: true };
    } catch (err) {
      // Sidebar rename hands us `session.cwd`. SDK derives the on-disk
      // project-key directory from that cwd via `_1(realpath(dir))`
      // (sdk.mjs `k6`/`_1`); when the cwd was renamed/moved/case-shifted
      // since the session was created — common on Windows — the encoded key
      // does not match the directory the JSONL actually lives under, and
      // SDK throws `Session <sid> not found in project directory for <dir>`.
      // The dir-less SDK path iterates every `~/.claude/projects/*` and
      // appends to whichever subdir owns `<sid>.jsonl` (sdk.d.ts:2204
      // documents this), so retrying without `dir` is the bulletproof
      // recovery. ENOENT (no JSONL anywhere) is a different signal — bubble
      // it up unchanged so the store can enqueue a pending rename.
      if (decideRetry(err, dir)) {
        try {
          const { renameSession } = await loadSdk();
          await renameSession(sid, title, undefined);
          titleCache.delete(sid);
          return { ok: true };
        } catch (retryErr) {
          return { ok: false, ...classifyError(retryErr) };
        }
      }
      return { ok: false, ...classifyError(err) };
    }
  });
}

export async function listProjectSummaries(
  projectKey: string
): Promise<ProjectSummary[]> {
  // Project-scoped reads are not per-sid serialized — they touch every
  // session file in the project, and serializing per-project would defeat
  // the parallelism that makes this useful for backfill.
  try {
    const { listSessions } = await loadSdk();
    const sessions = await listSessions({ dir: projectKey });
    return sessions.map((s) => ({
      sid: s.sessionId,
      summary: s.summary ?? null,
      mtime: typeof s.lastModified === 'number' ? s.lastModified : 0,
    }));
  } catch (err) {
    console.warn(
      `[sessionTitles] listSessions(${projectKey}) threw:`,
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

// ─────────────────────────── Pending queue (PR2) ─────────────────────────

export function enqueuePendingRename(sid: string, title: string, dir?: string): void {
  pendingRenames.set(sid, { title, dir });
}

export async function flushPendingRename(sid: string): Promise<void> {
  const pending = pendingRenames.get(sid);
  if (!pending) return;
  pendingRenames.delete(sid);
  const result = await renameSessionTitle(sid, pending.title, pending.dir);
  if (decideRequeue(result)) {
    // JSONL still not there — re-queue for the next flush attempt. PR3's
    // watcher will retry on the next frame.
    pendingRenames.set(sid, pending);
  }
}

// ─────────────────────────── Per-sid cleanup ─────────────────────────────

/**
 * Release every per-sid Map entry held by this module. Called from the
 * `sessionWatcher.on('unwatched', …)` listener in
 * `electron/notify/bootstrap/installPipeline.ts` so a long-running ccsm
 * process doesn't accumulate one entry per sid ever queried for the lifetime
 * of the app (audit #876, tech-debt H1).
 *
 * Safety:
 *   - Idempotent. `Map.delete` of an absent key is a no-op; calling
 *     `forgetSid` twice for the same sid is fine.
 *   - Doesn't throw, so the unwatched-event chain never breaks even if the
 *     sid was never seen by this module.
 *   - Doesn't cancel an in-flight rename. The serialization chain is held by
 *     the local `next` variable inside `chain()`; deleting the Map entry only
 *     drops the *next* op's predecessor link. A pending SDK call already
 *     awaiting `loadSdk()` / `renameSession()` runs to completion and resolves
 *     its caller's promise normally. The dropped chain pointer just means a
 *     fresh sid-reuse won't serialize against the old in-flight op — which is
 *     correct (the sid is "gone" from this module's POV).
 */
export function forgetSid(sid: string): void {
  if (typeof sid !== 'string' || sid.length === 0) return;
  titleCache.delete(sid);
  opChains.delete(sid);
  pendingRenames.delete(sid);
}

// ─────────────────────────── Test-only helpers ───────────────────────────

/**
 * Reset all module state. Test-only; never called from production code.
 * Exported so the vitest suite can isolate cases without juggling module
 * reloads.
 */
export function __resetForTests(): void {
  titleCache.clear();
  opChains.clear();
  pendingRenames.clear();
  sdkPromise = null;
}

/**
 * Inspect internal Map state for tests. Returns `true` when ANY of the three
 * per-sid Maps still holds an entry for `sid`. Used by `forgetSid` tests to
 * assert full cleanup without exporting the Maps themselves.
 */
export function __hasSidStateForTests(sid: string): boolean {
  return (
    titleCache.has(sid) || opChains.has(sid) || pendingRenames.has(sid)
  );
}

/**
 * Inject SDK fakes for tests. The real loader uses a `new Function`
 * dynamic-import shim (see `loadSdk` above) to dodge tsc's CommonJS rewrite,
 * which also dodges `vi.mock`. Tests call this with the same shape the
 * production loader resolves to. Pass `null` to fall back to the real SDK.
 */
export function __setSdkForTests(fakes: SdkExports | null): void {
  sdkPromise = fakes ? Promise.resolve(fakes) : null;
}
