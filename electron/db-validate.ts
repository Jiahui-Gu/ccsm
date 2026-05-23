// Small, pure validators for renderer-supplied DB writes. Extracted from
// the `db:save` IPC handler in `main.ts` so the size caps can be unit-tested
// without booting Electron's IPC plumbing or `app.whenReady`.
//
// These caps mirror the comments in main.ts:
//   - keys are short identifiers (e.g. `appPersist`, `drafts`, `crashReportingOptOut`)
//     so 128 chars is well above any legitimate use.
//   - app_state values hold drafts/persist snapshots. The previous 1 MB cap
//     was hit by real power users (50+ sessions + group reorganisation),
//     causing every subsequent write to fail silently — `dbIpc` returns
//     `{ok:false}`, the renderer toasts once, and the in-memory state never
//     reaches disk again until quit, at which point the user is rolled back
//     to potentially weeks-old state. Raised to 10 MB to give real breathing
//     room; the WAL impact is bounded because the row is overwritten (the
//     concern in the original comment was that a runaway persister could
//     balloon the WAL with many oversize commits, but our persister
//     debounces to one write per 250 ms and overwrites a single row).
//     This is defense-in-depth — the actionable toast in
//     `usePersistErrorBridge` still fires when the new ceiling is hit.

export const MAX_STATE_KEY_LEN = 128;
export const MAX_STATE_VALUE_BYTES = 10_000_000;

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
