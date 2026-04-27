// Map toastId -> action callback. The notifier registers a callback when a
// toast is emitted and removes it when the toast is dismissed (either by an
// action firing, by an explicit dismiss call, or by the OS timing out).
//
// `fire` is idempotent: a second fire for the same toastId is a no-op. This
// guards against the OS delivering duplicate activations (it has happened on
// Windows when a toast is clicked while already dismissing).

import type { ActionEvent } from './types';

export type ToastCallback = (event: ActionEvent) => void;

export class ToastRegistry {
  private readonly callbacks = new Map<string, ToastCallback>();

  /** Register a callback for a toastId. Overwrites any previous entry. */
  register(toastId: string, callback: ToastCallback): void {
    this.callbacks.set(toastId, callback);
  }

  /** True iff a callback is currently registered for this toastId. */
  has(toastId: string): boolean {
    return this.callbacks.has(toastId);
  }

  /**
   * Invoke the callback for a toastId, then remove the entry. Returns true if
   * a callback was fired. Returns false if no entry exists (already fired,
   * dismissed, or never registered) — the second-fire-after-fire case.
   */
  fire(event: ActionEvent): boolean {
    const cb = this.callbacks.get(event.toastId);
    if (!cb) return false;
    // Remove BEFORE invoking so a re-entrant fire (callback that triggers
    // another action) cannot loop.
    this.callbacks.delete(event.toastId);
    cb(event);
    return true;
  }

  /**
   * Drop the callback without firing. Used when the host resolves a pending
   * permission via in-app UI before the user touches the toast.
   * Returns true if an entry was removed.
   */
  dismiss(toastId: string): boolean {
    return this.callbacks.delete(toastId);
  }

  /** Test/diagnostic helper. */
  size(): number {
    return this.callbacks.size;
  }
}
