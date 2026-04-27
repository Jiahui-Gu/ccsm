// Wave 1D — bootstrap integration for the optional the inlined notify module package.
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
// All entry points are no-ops on non-win32 platforms — phase 1 of the inlined notify module
// only ships a Windows adapter.

import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { app } from 'electron';
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
// the inlined notify module package.
const APP_ID = 'com.ccsm.app';
const APP_NAME = 'CCSM';

/**
 * Callback the bootstrap hands to the inlined notify module so toast-button activations
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
 * Configure the inlined notify module wrapper. Safe to call multiple times — only the
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

// ── Default toast-action router factory (#308) ───────────────────────────
//
// Extracted from main.ts so the e2e probe can install the EXACT same
// router behaviour rather than a hand-rolled copy that drifts from
// production. The router consumes the host's main-window lookup as an
// injected function so this module stays free of cyclic imports.
export interface ToastActionRouterDeps {
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
      // The toastId for permission events IS the requestId. Permission
      // resolution previously routed through the SDK runner; with the
      // SDK gone (W3.5) the renderer is the only authority, so we just
      // notify it of the toast click and let it update its UI.
      const requestId = event.toastId;
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

// ── AUMID dev auto-setup ─────────────────────────────────────────────────
//
// Windows only routes Adaptive Toasts to a process whose AUMID matches the
// AUMID stamped on a Start Menu shortcut. Packaged installers (NSIS) handle
// this; for ad-hoc `npm run dev` the user has to run
// `scripts/setup-aumid.ps1` once per machine. This helper automates that
// step: at startup in dev mode, if the expected .lnk is missing, we spawn
// the script fire-and-forget. Failures are logged but never block startup.

const AUMID_SHORTCUT_NAME = 'CCSM Dev';

function getExpectedAumidShortcutPath(): string {
  // Mirrors `[Environment]::GetFolderPath('Programs')` from setup-aumid.ps1:
  // current-user Start Menu Programs folder.
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${AUMID_SHORTCUT_NAME}.lnk`);
}

/**
 * On Windows in dev mode, ensure the Start Menu .lnk required for AUMID
 * routing exists. If it doesn't, spawn `scripts/setup-aumid.ps1` detached
 * fire-and-forget. NEVER blocks startup; never throws.
 *
 * Skipped in packaged builds — NSIS handles the shortcut via electron-builder.
 */
export function autoSetupAumid(): void {
  try {
    if (process.platform !== 'win32') return;
    if (app.isPackaged) return;
    const lnk = getExpectedAumidShortcutPath();
    if (fs.existsSync(lnk)) return;
    // Resolve the script relative to the repo root. In dev, __dirname points
    // into `dist/electron/`, so go up two levels for the repo root.
    const repoRoot = path.resolve(__dirname, '..', '..');
    const scriptPath = path.join(repoRoot, 'scripts', 'setup-aumid.ps1');
    if (!fs.existsSync(scriptPath)) {
      console.warn(`[notify-bootstrap] setup-aumid.ps1 not found at ${scriptPath}; skipping AUMID auto-setup`);
      return;
    }
    const child = spawn(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { detached: true, stdio: 'ignore' },
    );
    child.on('error', (err) => {
      console.warn(`[notify-bootstrap] AUMID setup spawn error: ${err.message}`);
    });
    child.unref();
  } catch (err) {
    console.warn(
      `[notify-bootstrap] AUMID auto-setup failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

