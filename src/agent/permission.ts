// CLI-accepted permission modes (claude.exe `--permission-mode` flag and the
// `set_permission_mode` control_request). Local copy so the renderer doesn't
// drag in the SDK just for a string union.
//
// `auto` is the classifier-driven research-preview mode (gated on Sonnet 4.6+
// / account flag). The renderer now exposes it in the picker; the IPC layer
// passes it through to the SDK and falls back to `default` (with a toast) if
// the SDK rejects.
//
// `dontAsk` (legacy alias for `default`) is intentionally NOT surfaced — it's
// redundant.
export type CliPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'auto';
