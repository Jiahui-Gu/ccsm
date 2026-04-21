import { describe, it, expect } from 'vitest';
import type { PermissionMode } from '../src/stores/store';
import { migratePermission } from '../src/stores/store';
import type { CliPermissionMode } from '../src/agent/permission';

// The renderer's PermissionMode values match the CLI's `--permission-mode`
// flag 1:1 — we no longer translate between them. This test enforces the
// alignment so a future rename can't silently desync UI and CLI again.
describe('PermissionMode is CLI-aligned', () => {
  it('every UI enum value is a valid CLI flag value', () => {
    const uiValues: PermissionMode[] = ['plan', 'default', 'acceptEdits', 'bypassPermissions'];
    const cliValues: CliPermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
    for (const v of uiValues) {
      expect(cliValues).toContain(v);
    }
  });
});

describe('migratePermission (legacy persisted values)', () => {
  const cases: Array<[unknown, PermissionMode]> = [
    // Identity for current enum values.
    ['plan', 'plan'],
    ['default', 'default'],
    ['acceptEdits', 'acceptEdits'],
    ['bypassPermissions', 'bypassPermissions'],
    // Legacy UI literals → official CLI names.
    ['standard', 'default'],
    ['ask', 'default'],
    // Legacy UI `auto` was our alias for `acceptEdits`, NOT the CLI's
    // classifier-driven `auto`. Must migrate to `acceptEdits`.
    ['auto', 'acceptEdits'],
    ['yolo', 'bypassPermissions'],
    // Unknown / malformed → safe fallback.
    ['something-weird', 'default'],
    ['', 'default'],
    [null, 'default'],
    [undefined, 'default'],
    [42, 'default']
  ];

  it.each(cases)('migrates %p → %p', (raw, want) => {
    expect(migratePermission(raw)).toBe(want);
  });
});
