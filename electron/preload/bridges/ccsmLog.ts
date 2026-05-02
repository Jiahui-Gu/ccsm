// electron/preload/bridges/ccsmLog.ts
//
// Renderer console-forward bridge (v0.3 task #125, frag-6-7 §6.6.2).
//
// When `CCSM_RENDERER_LOG_FORWARD === '1'` is set in the env (read at
// preload load — Electron forwards process.env through to the preload
// context), this bridge wraps `console.{trace,debug,info,warn,error}` so
// every call ALSO ships a `log:write` IPC envelope to electron-main, which
// pino-writes them under the structured electron-main logger.
//
// Default OFF in production (per frag-6-7 §6.6.2 + task #125 brief — main
// log must not be polluted by renderer console noise). Keep the gate even
// in dev so contributors who want a clean main log can opt out.
//
// IMPORTANT: this is `add` not `replace`. Original console.* output still
// reaches the DevTools console; we only chain a forwarder onto it. Calling
// `installCcsmLogBridge()` is a no-op when the gate is off, so wiring it
// from `electron/preload/index.ts` unconditionally is safe.

import { ipcRenderer } from 'electron';

/** Mirrors the env var name + channel name in `electron/log.ts`. Kept as
 *  literal strings here because preload runs in a sandboxed context that
 *  cannot import non-electron modules from the main-process bundle. */
const CHANNEL = 'log:write';
const ENV_FLAG = 'CCSM_RENDERER_LOG_FORWARD';

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** Map the chained console method to the IPC payload level. */
const METHODS: Array<{ method: 'trace' | 'debug' | 'info' | 'warn' | 'error'; level: Level }> = [
  { method: 'trace', level: 'trace' },
  { method: 'debug', level: 'debug' },
  { method: 'info', level: 'info' },
  { method: 'warn', level: 'warn' },
  { method: 'error', level: 'error' },
];

/** Best-effort: serialise renderer-side args before they cross the IPC
 *  boundary. Plain primitives + JSON-able objects pass through; Errors
 *  collapse to `{ name, message, stack }` so the main side gets the
 *  stack trace. We do NOT forward DOM nodes or functions (would throw
 *  on structured-clone). */
function safeSerialize(arg: unknown): unknown {
  if (arg instanceof Error) {
    return { name: arg.name, message: arg.message, stack: arg.stack };
  }
  if (arg === undefined || arg === null) return arg;
  const t = typeof arg;
  if (t === 'string' || t === 'number' || t === 'boolean') return arg;
  if (t === 'function') return `[Function: ${(arg as { name?: string }).name ?? 'anonymous'}]`;
  try {
    // Round-trip through JSON to drop non-cloneables / cyclic refs.
    return JSON.parse(JSON.stringify(arg));
  } catch {
    return String(arg);
  }
}

/**
 * Install the renderer-side console-forward bridge. No-op when the
 * `CCSM_RENDERER_LOG_FORWARD` env gate is unset. Idempotent: a second
 * call is a no-op (the `__ccsmLogForwardInstalled` marker on `console`
 * prevents double-wrapping).
 */
export function installCcsmLogBridge(): void {
  // Read env gate up-front. preload context inherits process.env via
  // Electron's bridge, so this works without contextBridge gymnastics.
  if (typeof process === 'undefined' || process.env[ENV_FLAG] !== '1') return;

  // Idempotency marker — preload may be re-entered in tests.
  const consoleAny = console as unknown as Record<string, unknown> & { __ccsmLogForwardInstalled?: boolean };
  if (consoleAny.__ccsmLogForwardInstalled) return;
  consoleAny.__ccsmLogForwardInstalled = true;

  for (const { method, level } of METHODS) {
    const original = (console[method] as ((...args: unknown[]) => void) | undefined) ?? console.log.bind(console);
    console[method] = (...args: unknown[]) => {
      // Always run the original first so DevTools / stdout still see the
      // line even if IPC forward fails.
      try { original.apply(console, args); } catch { /* keep going */ }
      try {
        ipcRenderer.send(CHANNEL, { level, args: args.map(safeSerialize) });
      } catch {
        // IPC failed (closed contents, cross-context detach) — drop
        // silently; the original console call already ran.
      }
    };
  }
}
