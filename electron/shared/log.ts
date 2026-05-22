// Single seam for main-process logging. Format: "[tag] msg", same args as console.
// Wire Sentry/file logging here later — call sites already speak this shape.
//
// Kept separate from `src/shared/log.ts` (renderer) because main and renderer
// can't share modules across the contextBridge boundary, and a future Sentry
// wiring will differ between processes (main: `@sentry/electron/main`,
// renderer: `@sentry/electron/renderer`).
export function warn(tag: string, msg: string, ...rest: unknown[]): void {
  console.warn(`[${tag}] ${msg}`, ...rest);
}

export function error(tag: string, msg: string, ...rest: unknown[]): void {
  console.error(`[${tag}] ${msg}`, ...rest);
}
