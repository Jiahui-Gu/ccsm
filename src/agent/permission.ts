import type { PermissionMode } from '../stores/store';

// CLI-accepted permission modes (claude.exe `--permission-mode` flag and the
// `set_permission_mode` control_request). Local copy so the renderer doesn't
// drag in the SDK just for a string union.
export type CliPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export function toSdkPermissionMode(mode: PermissionMode): CliPermissionMode {
  switch (mode) {
    case 'plan':
      return 'plan';
    case 'ask':
      return 'default';
    case 'auto':
      return 'acceptEdits';
    case 'yolo':
      return 'bypassPermissions';
  }
}
