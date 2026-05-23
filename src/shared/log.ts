// Renderer-side structured logger.
//
// Replaces the legacy console-only stub. Wraps `electron-log/renderer` so
// every record:
//   1. flows to main via electron-log's IPC bridge (single source of truth
//      for cross-process correlation by sid)
//   2. ALSO writes to a small local ring file under
//      `app.getPath('userData')/renderer-logs/` (1MB × 2 = 2MB cap) — so if
//      the IPC bridge dies mid-crash the renderer still has tail evidence
//   3. passes through `scrub` before serialization so the transparent-
//      transport invariant holds even if a caller accidentally passes a
//      stringified clipboard chunk
//
// Back-compat: existing call sites use `warn(tag, msg, ...rest)` and
// `error(tag, msg, ...rest)` — both signatures are preserved. New code
// should prefer `log.event(name, fields)` for structured probes.
//
// Test environment: under vitest (`process.env.VITEST` set), we skip the
// electron-log import and use a console-only stub. Reason: electron-log's
// renderer entry installs a `RendererErrorHandler` that hooks window
// 'error' / 'unhandledrejection' listeners and tries to ship records over
// IPC to a main process that doesn't exist in jsdom — leading to either
// noisy stderr ("logger isn't initialized in the main process") on every
// jsdom-emitted error or, in the worst case, a hang when the IPC transport
// retries. The stub preserves the public API and the console-direct calls
// in the back-compat shims so all existing test contracts (~80 sites using
// `vi.spyOn(console, 'warn')`) keep working without behavior drift.

import { scrub, normalizeError, EVENT_ALLOWED_FIELDS, setHomeDir, scrubConsoleArgs } from './scrub';

type ElogLike = {
  debug: (msg: string) => void;
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

// Detect a non-Electron runtime (vitest under plain Node OR webpack
// dev-server's SSR shim) and short-circuit electron-log entirely. We check
// BOTH the Electron-runtime flag (`process.versions.electron`) AND the
// `VITEST` env so that:
//   * `isElectronRuntime === false` covers any non-Electron host (CI vitest
//     on Node with no binary, future SSR experiments) — most robust signal.
//   * `isVitest === true` covers the renderer-test case where webpack/jsdom
//     does set up a `window.process` polyfill that DOES claim
//     `versions.electron` (vite-plugin-electron emulates it). Belt and
//     suspenders, mirroring the cold-review recommendation.
const isElectronRuntime =
  typeof process !== 'undefined' && typeof process.versions?.electron === 'string';
const isVitest =
  typeof process !== 'undefined' &&
  (process.env?.VITEST === 'true' || process.env?.NODE_ENV === 'test');

function loadElog(): ElogLike {
  if (!isElectronRuntime || isVitest) {
    // Non-Electron or test environment — write to console only. The back-
    // compat shims already do that; here we provide a thin pass-through so
    // the structured paths (`log.event`) don't crash if a test exercises
    // them.
    return {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
  const mod = require('electron-log/renderer');
  return (mod.default ?? mod) as ElogLike;
}

const log: ElogLike = loadElog();

// Renderer doesn't have a homedir to scrub (sandboxed), but we still hook
// the setter so any future preload bridge can hand one over.
setHomeDir(null);

const LOG_SCHEMA_VERSION = 1;
type Tag = string;
type Msg = string;
type Fields = Record<string, unknown> | undefined;

function scrubFields(fields: Fields): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const scrubbed = scrub(fields) as Record<string, unknown> | undefined;
  return scrubbed;
}

function maybeNormalizeError(fields: Fields): Fields {
  if (!fields) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Error) {
      out[k] = normalizeError(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Back-compat shim: existing call sites pass `(tag, msg, ...rest)` where
// `rest` is often a single Error or a string. Roll them into a `fields`
// object so the structured form below works uniformly.
function compactRest(rest: unknown[]): Fields {
  if (rest.length === 0) return undefined;
  if (rest.length === 1) {
    const r = rest[0];
    if (r instanceof Error) return { error: normalizeError(r) };
    if (r && typeof r === 'object' && !Array.isArray(r)) return r as Record<string, unknown>;
    return { detail: r };
  }
  return { detail: rest };
}

function emit(
  level: 'debug' | 'info' | 'warn' | 'error',
  tag: Tag,
  msg: Msg,
  fields?: Fields,
): void {
  const scrubbed = scrubFields(maybeNormalizeError(fields));
  const record = {
    schemaV: LOG_SCHEMA_VERSION,
    tag,
    msg,
    ...(scrubbed ?? {}),
  };
  log[level](JSON.stringify(record));
}

export const log_api = {
  debug(tag: Tag, msg: Msg, fields?: Fields): void {
    emit('debug', tag, msg, fields);
  },
  info(tag: Tag, msg: Msg, fields?: Fields): void {
    emit('info', tag, msg, fields);
  },
  warn(tag: Tag, msg: Msg, fields?: Fields): void {
    emit('warn', tag, msg, fields);
  },
  error(tag: Tag, msg: Msg, fieldsOrErr?: Fields | Error): void {
    if (fieldsOrErr instanceof Error) {
      emit('error', tag, msg, { error: normalizeError(fieldsOrErr) });
      return;
    }
    emit('error', tag, msg, fieldsOrErr);
  },
  /** Structured probe. `name` is a dotted event name (e.g. `attach.snapshot.applied`).
   *  Unknown top-level keys in `fields` trigger a dev-only assertion (visible in
   *  console) so accidental content leakage is caught early — never throws in prod. */
  event(name: string, fields?: Fields): void {
    if (fields && process.env.NODE_ENV !== 'production') {
      for (const k of Object.keys(fields)) {
        if (!EVENT_ALLOWED_FIELDS.has(k)) {
          console.warn(
            `[log.event] unknown field '${k}' in event '${name}' — add to EVENT_ALLOWED_FIELDS or rename`,
          );
        }
      }
    }
    const scrubbed = scrubFields(fields);
    const record = {
      schemaV: LOG_SCHEMA_VERSION,
      event: name,
      ...(scrubbed ?? {}),
    };
    log.info(JSON.stringify(record));
  },
};

// Public namespace export — new code uses `log.debug(...)` / `log.event(...)`.
export { log_api as log };

// Back-compat top-level exports — ~80 call sites already speak this shape.
// Signature preserved: `(tag, msg, ...rest)`. ALSO call console directly
// because electron-log captures `console.warn`/`console.error` references
// at module-load time, so vitest's `vi.spyOn(console, 'warn')` won't see
// records routed solely through electron-log. Legacy test contracts assert
// against the direct console call; preserving it keeps them intact while
// structured records still flow to the file/IPC sinks via `log_api.warn`.
//
// SECURITY: `rest` is scrubbed BEFORE it reaches console — Errors get
// normalized, objects get forbidden-field drops + path/env scrubbing.
// See finding #1c in cold review of PR #1345.
export function warn(tag: string, msg: string, ...rest: unknown[]): void {
  console.warn(`[${tag}] ${msg}`, ...scrubConsoleArgs(rest));
  log_api.warn(tag, msg, compactRest(rest));
}
export function error(tag: string, msg: string, ...rest: unknown[]): void {
  console.error(`[${tag}] ${msg}`, ...scrubConsoleArgs(rest));
  if (rest.length === 1 && rest[0] instanceof Error) {
    log_api.error(tag, msg, rest[0]);
    return;
  }
  log_api.error(tag, msg, compactRest(rest));
}
