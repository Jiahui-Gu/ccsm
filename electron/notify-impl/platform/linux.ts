// Linux platform adapter — stub.
//
// Notifications are Windows-only in the current MVP. This stub exists so the
// dispatcher can `new LinuxAdapter()` on Linux without resolving Windows-only
// native bindings; every method throws so callers see a clear "not
// implemented" failure instead of a silent drop.

import type { PlatformAdapter, ActivationCallback } from './windows';
import type {
  DonePayload,
  NotifierOptions,
  PermissionPayload,
  QuestionPayload,
} from '../types';

const NOT_IMPLEMENTED = 'ccsm/notify: linux adapter is not implemented';

export class LinuxAdapter implements PlatformAdapter {
  constructor(_options: NotifierOptions) {}

  // No-op: lets Notifier construct without throwing. Real activation only
  // matters once an emit method is implemented.
  setActivationCallback(_cb: ActivationCallback): void {
    /* not implemented */
  }

  permission(_payload: PermissionPayload): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  question(_payload: QuestionPayload): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  done(_payload: DonePayload): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  dismiss(_toastId: string): void {
    throw new Error(NOT_IMPLEMENTED);
  }

  dispose(): void {
    throw new Error(NOT_IMPLEMENTED);
  }
}
