// v0.3 wave 1 — daemon port discovery.
//
// The Electron preload (wave-1 dev-B) installs `window.__getDaemonPort()`
// which resolves to the loopback port the local daemon bound to. We call
// it once at renderer boot, cache the resolved port, and reuse it for
// every subsequent fetch. The promise itself is cached so concurrent
// callers race onto the same in-flight discovery.
//
// `init()` is called from `installCcsmShim()` before React mounts so the
// rest of the renderer can treat `getDaemonPort()` as cheap and sync-ish
// (it always returns the same already-resolved promise after init).

let portPromise: Promise<number> | null = null;
let resolvedPort: number | null = null;

interface PreloadHook {
  __getDaemonPort?: () => Promise<number>;
}

/**
 * Kick off discovery. Idempotent — repeated calls reuse the in-flight or
 * resolved promise. Resolves to the daemon port, or rejects with a
 * descriptive error when the preload bridge is missing.
 */
export function init(): Promise<number> {
  if (portPromise) return portPromise;
  const w = window as unknown as PreloadHook;
  const hook = w.__getDaemonPort;
  if (typeof hook !== 'function') {
    portPromise = Promise.reject(
      new Error('daemon offline: window.__getDaemonPort preload bridge missing')
    );
    // Swallow the rejection on the cached promise so the global handler
    // doesn't fire repeatedly; callers see the rejection on `await`.
    portPromise.catch(() => {});
    return portPromise;
  }
  portPromise = (async () => {
    const p = await hook();
    if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) {
      throw new Error(`daemon offline: invalid port ${String(p)}`);
    }
    resolvedPort = p;
    return p;
  })();
  portPromise.catch(() => {
    /* propagate via await; avoid unhandledrejection spam */
  });
  return portPromise;
}

/**
 * Returns the in-flight or resolved port promise. Throws if `init()`
 * was never called — that would be an ordering bug in renderer boot.
 */
export function getDaemonPort(): Promise<number> {
  if (!portPromise) {
    return Promise.reject(
      new Error('daemon-port: init() not called before getDaemonPort()')
    );
  }
  return portPromise;
}

/**
 * Synchronous read of the resolved port. Returns `null` until discovery
 * completes. Useful for diagnostics; production paths should use
 * `getDaemonPort()`.
 */
export function getResolvedPort(): number | null {
  return resolvedPort;
}
