// Windows platform adapter.
//
// Wraps `electron-windows-notifications` so the dispatcher can stay
// platform-agnostic. Each emit method:
//   1. Builds Adaptive Toast XML for the requested type.
//   2. Constructs a ToastNotification tagged by toastId so it can be
//      hidden/removed from the Action Center later.
//   3. Subscribes to the `activated` event, parses the arguments string,
//      forwards to `Notifier.onAction`, then auto-dismisses the toast.
//
// AUMID validation: the adapter requires a non-empty `appId`. Toasts emitted
// without a registered AUMID + Start Menu shortcut on Windows silently
// vanish, which is impossible to debug. We surface the requirement at
// construction with a pointer to `setup-aumid.ps1`.

import type {
  ActionId,
  DonePayload,
  NotifierOptions,
  PermissionPayload,
  QuestionPayload,
} from '../types';
import { parseActionArgs } from '../xml/common';
import { buildDoneXml } from '../xml/done';
import { buildPermissionXml } from '../xml/permission';
import { buildQuestionXml } from '../xml/question';

/**
 * Cross-platform shape the dispatcher targets. macOS / Linux adapters in
 * later phases must satisfy the same interface.
 */
export interface PlatformAdapter {
  permission(payload: PermissionPayload): void;
  question(payload: QuestionPayload): void;
  done(payload: DonePayload): void;
  /** Force-dismiss a toast by id without firing its callback. */
  dismiss(toastId: string): void;
  /** Optional shutdown hook — release any native handles. */
  dispose?(): void;
}

/** Subset of the electron-windows-notifications surface we depend on. */
interface ToastNotificationCtor {
  new (options: {
    appId?: string;
    template: string;
    strings?: string[];
    tag?: string;
    group?: string;
  }): ToastNotificationInstance;
}

interface ToastNotificationInstance {
  on(
    event: 'activated',
    listener: (toast: unknown, args: string | undefined) => void,
  ): void;
  on(event: 'dismissed', listener: (...args: unknown[]) => void): void;
  on(event: 'failed', listener: (err: unknown) => void): void;
  show(): void;
  hide(): void;
}

interface HistoryApi {
  remove(options: { tag: string; group?: string; appId?: string }): void;
}

interface ElectronWindowsNotifications {
  ToastNotification: ToastNotificationCtor;
  history: HistoryApi;
}

/**
 * Internal callback the adapter invokes after parsing an activation event.
 * The dispatcher (`Notifier`) wires this to the registry → onAction chain.
 */
export type ActivationCallback = (
  toastId: string,
  action: ActionId,
  args: Record<string, string>,
) => void;

const TOAST_GROUP = 'ccsm-notify';

const AUMID_HELP =
  'Set NotifierOptions.appId to the AUMID registered for this process. ' +
  'For ad-hoc dev runs, use scripts/setup-aumid.ps1.';

function loadNativeModule(): ElectronWindowsNotifications {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('electron-windows-notifications') as ElectronWindowsNotifications;
  return mod;
}

/**
 * Allow tests to inject a fake native module without a real electron host.
 * Production code never calls this.
 */
let nativeOverride: ElectronWindowsNotifications | undefined;
export function __setNativeForTests(
  mod: ElectronWindowsNotifications | undefined,
): void {
  nativeOverride = mod;
}

const KNOWN_ACTIONS: readonly ActionId[] = [
  'allow',
  'allow-always',
  'reject',
  'focus',
];

function isKnownAction(value: string): value is ActionId {
  return (KNOWN_ACTIONS as readonly string[]).includes(value);
}

export class WindowsAdapter implements PlatformAdapter {
  private readonly options: NotifierOptions;
  private readonly native: ElectronWindowsNotifications;
  /** Live toast handles, keyed by toastId, so `hide()` can be invoked. */
  private readonly liveToasts = new Map<string, ToastNotificationInstance>();
  /** Hook the dispatcher installs to route activations. */
  private activationCallback: ActivationCallback | undefined;

  constructor(options: NotifierOptions) {
    if (!options.appId || options.appId.trim().length === 0) {
      throw new Error(`ccsm/notify: AUMID not registered. ${AUMID_HELP}`);
    }
    this.options = options;
    try {
      this.native = nativeOverride ?? loadNativeModule();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `ccsm/notify: failed to load electron-windows-notifications (${detail}). ` +
          'Ensure the host process is electron and the package is installed.',
      );
    }
  }

  /**
   * Register the dispatcher's activation callback. Called by `Notifier`
   * once during construction. Kept separate from the constructor to keep
   * the public `NotifierOptions` shape uncluttered.
   */
  setActivationCallback(cb: ActivationCallback): void {
    this.activationCallback = cb;
  }

  permission(payload: PermissionPayload): void {
    const xml = buildPermissionXml(payload, {
      iconPath: this.options.iconPath,
      silent: this.options.silent,
    });
    this.showToast(payload.toastId, xml);
  }

  question(payload: QuestionPayload): void {
    const xml = buildQuestionXml(payload, {
      iconPath: this.options.iconPath,
      silent: this.options.silent,
    });
    this.showToast(payload.toastId, xml);
  }

  done(payload: DonePayload): void {
    const xml = buildDoneXml(payload, {
      iconPath: this.options.iconPath,
      silent: this.options.silent,
    });
    this.showToast(payload.toastId, xml);
  }

  dismiss(toastId: string): void {
    const handle = this.liveToasts.get(toastId);
    this.liveToasts.delete(toastId);
    if (handle) {
      try {
        handle.hide();
      } catch {
        // Toast may already have been dismissed by the OS.
      }
    }
    // Also clear the entry from Action Center so the user doesn't see a
    // stale notification after the in-app UI resolved the prompt.
    try {
      this.native.history.remove({
        tag: toastId,
        group: TOAST_GROUP,
        appId: this.options.appId,
      });
    } catch {
      // Older Windows builds occasionally throw if the entry is gone.
    }
  }

  private showToast(toastId: string, template: string): void {
    const toast = new this.native.ToastNotification({
      appId: this.options.appId,
      template,
      tag: toastId,
      group: TOAST_GROUP,
    });
    this.liveToasts.set(toastId, toast);
    toast.on('activated', (_t, args) => {
      this.handleActivation(toastId, args ?? '');
    });
    toast.on('dismissed', () => {
      // OS-level dismiss (timeout, user swipe, action-center clear): drop the
      // handle so the map doesn't leak. We intentionally do NOT fire the
      // action callback here — only explicit user actions resolve the prompt.
      this.liveToasts.delete(toastId);
    });
    toast.on('failed', (err) => {
      // Log to stderr so the operator sees AUMID / shortcut issues. The
      // dispatcher's registry stays alive — caller can fall back to in-app UI.
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`[ccsm/notify] toast ${toastId} failed: ${detail}`);
    });
    toast.show();
  }

  private handleActivation(toastId: string, rawArgs: string): void {
    const parsed = parseActionArgs(rawArgs);
    const actionRaw = parsed['action'] ?? 'focus';
    const action: ActionId = isKnownAction(actionRaw) ? actionRaw : 'focus';
    // Strip the action key from the args bag before forwarding — callers
    // already receive `action` as a top-level field.
    const argsForCallback: Record<string, string> = { ...parsed };
    delete argsForCallback['action'];
    try {
      this.activationCallback?.(toastId, action, argsForCallback);
    } finally {
      // Per spec: auto-dismiss after firing the callback.
      this.dismiss(toastId);
    }
  }

  dispose(): void {
    for (const [id] of this.liveToasts) {
      try {
        this.dismiss(id);
      } catch {
        // best-effort
      }
    }
    this.liveToasts.clear();
  }
}
