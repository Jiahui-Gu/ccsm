import { describe, it, expect } from 'vitest';
import { toSdkPermissionMode } from '../src/agent/permission';
import type { PermissionMode } from '../src/stores/store';

describe('toSdkPermissionMode', () => {
  it('maps every UI mode to a CLI-accepted value', () => {
    const cases: Array<[PermissionMode, string]> = [
      ['plan', 'plan'],
      // `ask` is labelled "standard" in the UI; it maps to CLI `default`,
      // which auto-approves reads and prompts on writes/shell. The CLI has
      // no "ask on every tool" mode.
      ['ask', 'default'],
      ['auto', 'acceptEdits'],
      ['yolo', 'bypassPermissions']
    ];
    for (const [ui, cli] of cases) {
      expect(toSdkPermissionMode(ui)).toBe(cli);
    }
  });
});
