// Platform-agnostic notification dispatcher. Detects `process.platform` and
// delegates to a registered adapter. Currently only the Windows adapter is
// implemented; macOS / Linux fall through to the host's in-app banners.

import { ToastRegistry } from './registry';
import type {
  ActionEvent,
  ActionId,
  DonePayload,
  NotifierOptions,
  PermissionPayload,
  QuestionPayload,
} from './types';
import { type PlatformAdapter, WindowsAdapter } from './platform/windows';

const UNSUPPORTED_PLATFORM = (p: string): string =>
  `ccsm/notify: platform "${p}" is not supported (Windows only).`;

export class Notifier {
  private readonly adapter: PlatformAdapter;
  private readonly registry: ToastRegistry;
  private readonly options: NotifierOptions;

  private constructor(adapter: PlatformAdapter, options: NotifierOptions) {
    this.adapter = adapter;
    this.options = options;
    this.registry = new ToastRegistry();
    // Real adapters expose an activation hook so we can route OS-side toast
    // clicks through the registry. The stub adapter (and future macOS/Linux
    // adapters before they're implemented) may not — feature-detect.
    const maybeHookable = adapter as PlatformAdapter & {
      setActivationCallback?: (
        cb: (toastId: string, action: ActionId, args: Record<string, string>) => void,
      ) => void;
    };
    if (typeof maybeHookable.setActivationCallback === 'function') {
      maybeHookable.setActivationCallback((toastId, action, args) => {
        this.dispatchActivation({ toastId, action, args });
      });
    }
  }

  /**
   * Async factory — async because real adapters may need to verify
   * AUMID registration or wire native event subscriptions before returning.
   */
  static async create(options: NotifierOptions): Promise<Notifier> {
    const platform = process.platform;
    if (platform !== 'win32') {
      throw new Error(UNSUPPORTED_PLATFORM(platform));
    }
    const adapter = new WindowsAdapter(options);
    return new Notifier(adapter, options);
  }

  /** Internal: register the active onAction handler under a toastId. */
  private track(toastId: string): void {
    this.registry.register(toastId, (event) => {
      // Forward to the host app. The adapter is responsible for tearing the
      // OS-side toast down (it already calls `dismiss` after firing the
      // activation callback). We swallow handler errors so a buggy host
      // can't strand the registry entry — but we re-throw nothing.
      try {
        this.options.onAction(event);
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        console.error(
          `[ccsm/notify] onAction handler threw for toast ${event.toastId}: ${detail}`,
        );
      }
    });
  }

  /** Routed from the platform adapter when a toast is clicked. */
  private dispatchActivation(event: ActionEvent): void {
    // `fire` is idempotent — duplicate OS activations are silently ignored.
    this.registry.fire(event);
  }

  permission(payload: PermissionPayload): void {
    this.track(payload.toastId);
    this.adapter.permission(payload);
  }

  question(payload: QuestionPayload): void {
    this.track(payload.toastId);
    this.adapter.question(payload);
  }

  done(payload: DonePayload): void {
    this.track(payload.toastId);
    this.adapter.done(payload);
  }

  /**
   * Caller-initiated dismiss. Removes the registry entry and asks the
   * adapter to tear the toast down. No callback fires.
   */
  dismiss(toastId: string): void {
    this.registry.dismiss(toastId);
    try {
      this.adapter.dismiss(toastId);
    } catch {
      // Adapter may already be gone — swallow.
    }
  }

  /** Diagnostic — number of pending toast callbacks. */
  pendingCount(): number {
    return this.registry.size();
  }

  /** Release native handles. Safe to call multiple times. */
  dispose(): void {
    this.adapter.dispose?.();
  }
}
