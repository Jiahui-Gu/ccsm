// Tests for the W3 darwin/linux platform-adapter stubs.
//
// Notifications are Windows-only in the current MVP. The stubs exist so the
// dispatcher can construct adapters on macOS/Linux without resolving Windows-
// only native bindings. Contract:
//   - constructor + setActivationCallback + dismiss + dispose are no-ops
//     (must not throw — shutdown paths run on every platform).
//   - permission / question / done throw a clear "not implemented" error so
//     callers see a real failure instead of a silent drop.

import { describe, it, expect } from 'vitest';
import { DarwinAdapter } from '../notify-impl/platform/darwin';
import { LinuxAdapter } from '../notify-impl/platform/linux';

const fakeOptions = {
  appId: 'com.example.test',
  appName: 'Test',
  onAction: () => {},
};

const fakePermissionPayload = {
  toastId: 't1',
  sessionName: 'sess',
  toolName: 'Bash',
  toolBrief: 'ls',
  cwdBasename: 'proj',
};
const fakeQuestionPayload = {
  toastId: 't2',
  sessionName: 'sess',
  question: 'pick one',
  selectionKind: 'single' as const,
  optionCount: 2,
  cwdBasename: 'proj',
};
const fakeDonePayload = {
  toastId: 't3',
  groupName: 'g',
  sessionName: 'sess',
  lastUserMsg: 'go',
  lastAssistantMsg: 'done',
  elapsedMs: 100,
  toolCount: 1,
  cwdBasename: 'proj',
};

for (const [name, Adapter] of [
  ['DarwinAdapter', DarwinAdapter],
  ['LinuxAdapter', LinuxAdapter],
] as const) {
  describe(`${name} (W3 stub)`, () => {
    it('constructs and runs no-op lifecycle methods without throwing', () => {
      const a = new Adapter(fakeOptions);
      expect(() => a.setActivationCallback(() => {})).not.toThrow();
      expect(() => a.dismiss('t-x')).not.toThrow();
      expect(() => a.dispose()).not.toThrow();
    });

    it('emit methods (permission/question/done) throw a "not implemented" error', () => {
      const a = new Adapter(fakeOptions);
      expect(() => a.permission(fakePermissionPayload)).toThrow(/not implemented/i);
      expect(() => a.question(fakeQuestionPayload)).toThrow(/not implemented/i);
      expect(() => a.done(fakeDonePayload)).toThrow(/not implemented/i);
    });
  });
}
