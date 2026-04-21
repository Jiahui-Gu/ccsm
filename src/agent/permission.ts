import type { PermissionMode as SDKPermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode } from '../stores/store';

export function toSdkPermissionMode(mode: PermissionMode): SDKPermissionMode {
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
