import type { PermissionMode as SDKPermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode } from '../stores/store';

export function toSdkPermissionMode(mode: PermissionMode): SDKPermissionMode {
  switch (mode) {
    case 'auto':
      return 'acceptEdits';
    case 'ask':
      return 'default';
    case 'plan':
      return 'plan';
  }
}
