// Small, pure validators for renderer-supplied DB writes. Extracted from
// the `db:save` IPC handler in `main.ts` so the size caps can be unit-tested
// without booting Electron's IPC plumbing or `app.whenReady`.
//
// These caps mirror the comments in main.ts:
//   - keys are short identifiers (e.g. `appPersist`, `drafts`, `crashReportingOptOut`)
//     so 128 chars is well above any legitimate use.
//   - app_state values hold drafts/persist snapshots; a single row over
//     1 MB indicates a bug in the persister, and silently committing it
//     would balloon the WAL.

export const MAX_STATE_KEY_LEN = 128;
export const MAX_STATE_VALUE_BYTES = 1_000_000;

export type SaveStateValidation =
  | { ok: true }
  | { ok: false; error: 'invalid_key' | 'invalid_value' | 'value_too_large' };

export function validateSaveStateInput(key: unknown, value: unknown): SaveStateValidation {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_STATE_KEY_LEN) {
    return { ok: false, error: 'invalid_key' };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: 'invalid_value' };
  }
  if (value.length > MAX_STATE_VALUE_BYTES) {
    return { ok: false, error: 'value_too_large' };
  }
  return { ok: true };
}
