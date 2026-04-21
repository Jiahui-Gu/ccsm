// CLI-accepted permission modes (claude.exe `--permission-mode` flag and the
// `set_permission_mode` control_request). Local copy so the renderer doesn't
// drag in the SDK just for a string union.
//
// The CLI also accepts `auto` (classifier-driven research-preview) and
// `dontAsk` (legacy alias for `default`). We don't surface them in the UI;
// see `PermissionMode` in `src/stores/store.ts` for the rationale.
export type CliPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
