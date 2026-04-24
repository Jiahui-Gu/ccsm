// Wave 1D — bootstrap integration for the optional `@ccsm/notify` package.
//
// The thin wrapper in `electron/notify.ts` (#267) exposes typed no-op
// fallbacks so the rest of the app can call notify functions without caring
// whether the native module loaded. This file sits one layer up and:
//
//   1. Configures the wrapper with our app id + an `onAction` handler that
//      routes Windows toast button clicks (Allow / Allow always / Reject /
//      Focus) back into the same code path the in-app prompt uses.
//   2. Eagerly probes availability so Settings can render an accurate
//      indicator without waiting for the first emit.
//   3. Wraps everything in try/catch so a bad install (missing native deps,
//      AUMID not registered, etc.) cannot block app startup.
//
// All entry points are no-ops on non-win32 platforms — phase 1 of @ccsm/notify
// only ships a Windows adapter.

import { BrowserWindow } from 'electron';
import {
  configureNotify,
  isNotifyAvailable,
  probeNotifyAvailability,
  type ActionEvent,
} from './notify';

// AUMID must match `app.setAppUserModelId` in main.ts. Windows refuses to
// route adaptive toast activations unless the host process AUMID matches the
// AUMID stamped on the Start Menu shortcut. In packaged builds NSIS sets the
// shortcut up; for ad-hoc dev runs, see `scripts/setup-aumid.ps1` in the
// `@ccsm/notify` package.
const APP_ID = 'com.ccsm.app';
const APP_NAME = 'CCSM';

/**
 * Callback the bootstrap hands to `@ccsm/notify` so toast-button activations
 * can be routed back into the host. Wired by main.ts at app `ready`.
 *
 *  - `permission` toasts use `toastId === requestId` for the underlying
 *    permission request, so the host can resolve it 1:1.
 *  - `question` toasts use `toastId === q-${requestId}` (matching the block
 *    id on the renderer side); the only meaningful action is `focus`, which
 *    surfaces the question to the user.
 *  - `done` toasts only carry `focus`.
 */
export type NotifyActionRouter = (event: ActionEvent) => void;

let bootstrapped = false;

/**
 * Configure the @ccsm/notify wrapper. Safe to call multiple times — only the
 * first invocation actually configures; subsequent calls are no-ops so the
 * onAction callback isn't replaced mid-flight (which would orphan in-flight
 * toasts).
 *
 * Returns `true` when configuration was applied (or had already been applied),
 * `false` when the platform is unsupported. Never throws.
 */
export function bootstrapNotify(router: NotifyActionRouter): boolean {
  if (process.platform !== 'win32') return false;
  if (bootstrapped) return true;
  try {
    configureNotify({
      appId: APP_ID,
      appName: APP_NAME,
      silent: false,
      onAction: (event) => {
        try {
          router(event);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(
            `[notify-bootstrap] router threw for toast ${event.toastId}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
      },
    });
    bootstrapped = true;
    // Kick off the dynamic import in the background so isNotifyAvailable()
    // returns truthful values by the time the user opens Settings or the
    // first agent event fires. We swallow the result — actual emits will
    // re-await the same cached promise.
    void probeNotifyAvailability().catch(() => {
      /* logged inside the wrapper */
    });
    return true;
  } catch (err) {
    // configureNotify itself never throws (it just stashes options) but be
    // defensive — a future refactor could.
    // eslint-disable-next-line no-console
    console.warn(
      `[notify-bootstrap] failed to configure: ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

/**
 * Returns true when ccsm should suppress an OS toast because the renderer
 * is already in the foreground — the user will see the in-app affordance,
 * pinging the OS too is noise. Defensive doubled gate; the renderer-side
 * `dispatchNotification` already applies a similar check, but it relies on
 * `document.hasFocus()` which can lie under devtools / playwright. Checking
 * `BrowserWindow.isFocused()` from main is the source of truth.
 */
export function shouldSuppressForFocus(): boolean {
  const wins = BrowserWindow.getAllWindows();
  for (const w of wins) {
    if (!w.isDestroyed() && w.isFocused() && w.isVisible()) return true;
  }
  return false;
}

/**
 * Track which session a given toastId belongs to so the onAction router can
 * call back into the agent runner with the right sessionId. Populated by
 * `notifications.ts:emitAdaptiveToast` immediately before the wrapper call.
 * Bounded growth: we trim entries on `consumeToastTarget` (resolved) and on
 * an LRU cap to defend against runaway emit loops.
 */
const TOAST_TARGET_LIMIT = 256;
const toastTargets = new Map<string, { sessionId: string; kind: 'permission' | 'question' | 'turn_done' }>();

export function registerToastTarget(
  toastId: string,
  sessionId: string,
  kind: 'permission' | 'question' | 'turn_done',
): void {
  if (toastTargets.size >= TOAST_TARGET_LIMIT) {
    // Drop oldest insertion. Map iteration order is insertion order in JS.
    const firstKey = toastTargets.keys().next().value;
    if (firstKey) toastTargets.delete(firstKey);
  }
  toastTargets.set(toastId, { sessionId, kind });
}

export function lookupToastTarget(
  toastId: string,
): { sessionId: string; kind: 'permission' | 'question' | 'turn_done' } | undefined {
  return toastTargets.get(toastId);
}

export function consumeToastTarget(toastId: string): void {
  toastTargets.delete(toastId);
}

/**
 * Test-only seam — unit tests reach in to flip the bootstrap flag back so a
 * fresh `bootstrapNotify` call re-runs `configureNotify` against a mocked
 * importer.
 */
export function __resetBootstrapForTests(): void {
  bootstrapped = false;
  toastTargets.clear();
}

export { isNotifyAvailable };
export const NOTIFY_APP_ID = APP_ID;
export const NOTIFY_APP_NAME = APP_NAME;
