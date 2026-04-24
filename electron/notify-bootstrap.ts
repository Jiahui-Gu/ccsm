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

// ── Runtime-state mirror (#307) ──────────────────────────────────────────
//
// The renderer-side `dispatchNotification` evaluates the user's notification
// preferences (global enabled toggle, per-event toggles, per-session mute,
// debounce) BEFORE asking main to fire a toast. Initial emits therefore
// honour those gates by construction. The ask-question retry timer (#252),
// however, lives in main and re-emits ~30s later — by which time the user
// may have toggled notifications off or focused the question's session.
// Without a mirror of the relevant renderer state, the retry would happily
// fire through that closed gate.
//
// Mirror is push-based: the renderer subscribes to its own store and pushes
// the two fields that matter for retry gating (`notificationsEnabled`,
// `activeSessionId`) via `notify:setRuntimeState` whenever they change.
// Defaults are conservative — we assume notifications are enabled until the
// renderer tells us otherwise so a renderer that never wires the bridge
// doesn't accidentally suppress every toast.
interface NotifyRuntimeState {
  notificationsEnabled: boolean;
  activeSessionId: string | null;
}

const runtimeState: NotifyRuntimeState = {
  notificationsEnabled: true,
  activeSessionId: null,
};

/**
 * Update the main-process mirror of renderer notification state. Called
 * via the `notify:setRuntimeState` IPC handler. Partial — fields not
 * present are left unchanged so the renderer can push deltas.
 */
export function setNotifyRuntimeState(patch: Partial<NotifyRuntimeState>): void {
  if (typeof patch.notificationsEnabled === 'boolean') {
    runtimeState.notificationsEnabled = patch.notificationsEnabled;
  }
  if (patch.activeSessionId === null || typeof patch.activeSessionId === 'string') {
    runtimeState.activeSessionId = patch.activeSessionId;
  }
}

/** Read-only snapshot for gate-checks at toast-fire time. */
export function getNotifyRuntimeState(): Readonly<NotifyRuntimeState> {
  return runtimeState;
}

/**
 * Combined gate evaluated at retry-fire time (#307). Returns true when the
 * caller should NOT fire — either the user globally disabled notifications,
 * or the user is focused on the question's own session (so the in-app
 * affordance is already visible and a fresh OS toast would be noise).
 *
 * Pure read against `runtimeState` + `BrowserWindow.isFocused()`; safe to
 * call repeatedly and from any module without circular-import risk.
 */
export function shouldSuppressRetry(sessionId: string | null | undefined): boolean {
  if (!runtimeState.notificationsEnabled) return true;
  if (sessionId && runtimeState.activeSessionId === sessionId) {
    if (shouldSuppressForFocus()) return true;
  }
  return false;
}

/** Test-only — restore mirror to defaults between unit tests. */
export function __resetNotifyRuntimeStateForTests(): void {
  runtimeState.notificationsEnabled = true;
  runtimeState.activeSessionId = null;
}

// ── Default toast-action router factory (#308) ───────────────────────────
//
// Extracted from main.ts so the e2e probe can install the EXACT same
// router behaviour rather than a hand-rolled copy that drifts from
// production. The router consumes a few host capabilities (resolve
// permission against the live session manager, cancel pending question
// retries, look up the foreground window) injected as functions so this
// module stays free of cyclic imports against `agent/sessions` and
// `notify-retry`.
export interface ToastActionRouterDeps {
  /** Resolve a CLI permission gate (typically `sessions.resolvePermission`). */
  resolvePermission: (sessionId: string, requestId: string, decision: 'allow' | 'deny') => unknown;
  /** Cancel a scheduled question retry (typically from `notify-retry`). */
  cancelQuestionRetry: (toastId: string) => void;
  /** Returns the window to send `notify:toastAction` to, or null. */
  getMainWindow: () => { isDestroyed?: () => boolean; webContents?: { send: (channel: string, payload: unknown) => void }; isMinimized?: () => boolean; restore?: () => void; isVisible?: () => boolean; show?: () => void; focus?: () => void } | null;
}

export function createDefaultToastActionRouter(
  deps: ToastActionRouterDeps,
): (event: { toastId: string; action: 'allow' | 'allow-always' | 'reject' | 'focus'; args: Record<string, string> }) => void {
  return (event) => {
    const target = lookupToastTarget(event.toastId);
    if (!target) return;
    const win = deps.getMainWindow();
    if (target.kind === 'permission') {
      // The toastId for permission events IS the requestId (see lifecycle.ts
      // → permissionRequestToWaitingBlock). Resolve the underlying CLI
      // permission gate and notify the renderer so it can update its
      // waiting-block UI + (for `allow-always`) seed `allowAlwaysTools`.
      const requestId = event.toastId;
      if (event.action === 'allow' || event.action === 'allow-always') {
        deps.resolvePermission(target.sessionId, requestId, 'allow');
      } else if (event.action === 'reject') {
        deps.resolvePermission(target.sessionId, requestId, 'deny');
        // Defensive cancel (#308): permission toasts don't schedule a retry
        // today (only question events do), but if a future change ever
        // routes question activations through the same toast-action path,
        // a forgotten cancel would leak the timer past the user's explicit
        // reject. Cheap belt-and-suspenders — `cancelQuestionRetry` is a
        // safe no-op when no entry exists. Both id shapes are tried so
        // either lifecycle convention (`q-${requestId}` or bare requestId)
        // is covered.
        deps.cancelQuestionRetry(`q-${requestId}`);
        deps.cancelQuestionRetry(requestId);
      }
      if (win && win.webContents) {
        win.webContents.send('notify:toastAction', {
          sessionId: target.sessionId,
          requestId,
          action: event.action,
        });
      }
      consumeToastTarget(event.toastId);
    } else if (target.kind === 'question' || target.kind === 'turn_done') {
      // Questions + turn_done only carry `focus`; other actions are no-ops
      // here (the renderer drives the actual answer flow once focused).
      consumeToastTarget(event.toastId);
    }
    // Always raise the window on any action — the user clicked the toast,
    // they want to see ccsm. Mirrors the existing `notification:focusSession`
    // path used by the legacy Electron Notification.
    if (win) {
      if (win.isMinimized?.()) win.restore?.();
      if (!win.isVisible?.()) win.show?.();
      win.focus?.();
      win.webContents?.send('notification:focusSession', target.sessionId);
    }
  };
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
