// src/lib/installRendererErrorForwarder.ts
//
// Phase 5 crash observability — renderer-side hooks for window.onerror and
// window.onunhandledrejection (and, in dev builds only, console.error).
// Forwards each event to the main process via the preload bridge so the
// phase-1 collector records a `surface: 'renderer'` incident on disk
// (regardless of consent) and the phase-2/3 Sentry SDK forwards it
// (consent-gated, phase 4).
//
// We intentionally do NOT replace the renderer Sentry SDK's own
// `window.onerror` interception — both can coexist (Sentry's runs first,
// captures into its transport; ours runs after via the same global hook
// and writes the on-disk incident). The two paths complement each other:
// Sentry covers the "DSN configured + consent granted" upload path; this
// forwarder covers the "always have something on disk" baseline.
//
// console.error is gated behind a dev-only flag because production logs are
// noisy and a single misbehaving render path could trigger the rate limit
// in seconds, masking the real signal we care about (uncaught throws).
//
// Rate-limiting lives on the main side (per-process). The renderer just
// fires-and-forgets — even an excess of events at this end is cheap.

interface CcsmCrashBridge {
  reportRendererError: (report: {
    error: { name?: string; message: string; stack?: string };
    source: string;
    url?: string;
  }) => Promise<{ accepted: boolean; reason?: string }>;
}

interface CcsmAPI {
  crash?: CcsmCrashBridge;
}

interface InstallOpts {
  /** Capture console.error too. Off by default; turn on for dev builds. */
  captureConsoleError?: boolean;
}

function serialize(input: unknown): { name?: string; message: string; stack?: string } {
  if (input instanceof Error) {
    return { name: input.name, message: input.message, stack: input.stack };
  }
  if (input && typeof input === 'object') {
    try { return { message: JSON.stringify(input) }; } catch { return { message: String(input) }; }
  }
  return { message: String(input) };
}

/** Install renderer-side error forwarders. Returns a teardown function for
 *  hot-reload / tests. Safe to call before the preload bridge is ready —
 *  reports just bounce off until `window.ccsm.crash.reportRendererError`
 *  resolves. */
export function installRendererErrorForwarder(opts: InstallOpts = {}): () => void {
  const w = window as unknown as { ccsm?: CcsmAPI };

  function send(error: unknown, source: string, url?: string): void {
    const bridge = w.ccsm?.crash;
    if (!bridge?.reportRendererError) return;
    try {
      // Fire-and-forget; the main side rate-limits and never throws back.
      void bridge.reportRendererError({ error: serialize(error), source, url });
    } catch {
      /* swallow — losing a forwarder report must not break the renderer */
    }
  }

  const onErr = (event: Event): void => {
    const e = event as Event & { error?: unknown; message?: string; filename?: string };
    send(e.error ?? e.message ?? 'unknown error', 'window.onerror', e.filename || undefined);
  };
  const onRej = (event: Event): void => {
    const e = event as Event & { reason?: unknown };
    send(e.reason, 'window.onunhandledrejection');
  };

  window.addEventListener('error', onErr);
  window.addEventListener('unhandledrejection', onRej);

  let restoreConsole: (() => void) | null = null;
  if (opts.captureConsoleError) {
    const orig = console.error.bind(console);
    console.error = (...args: unknown[]): void => {
      try { orig(...args); } finally {
        // Only forward Error-shaped first arg; arbitrary console.error('foo', 1)
        // calls produce too much noise to be useful as crash incidents.
        if (args[0] instanceof Error) send(args[0], 'console.error');
      }
    };
    restoreConsole = () => { console.error = orig; };
  }

  return () => {
    window.removeEventListener('error', onErr);
    window.removeEventListener('unhandledrejection', onRej);
    restoreConsole?.();
  };
}
