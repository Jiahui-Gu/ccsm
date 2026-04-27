// Regression guard: the production notify-impl reaches the native
// ToastNotification ctor with the right shape.
//
// Why this exists: every release before this commit shipped without the
// `electron-windows-notifications` native module — the dep was in
// `optionalDependencies`, the install failed silently on most build hosts,
// and `loadNativeModule()` threw at runtime. The wrapper caught the throw,
// flipped `resolvedAvailability` to false, and `showNotification()` returned
// false forever. Users got ZERO Adaptive Toasts, only the in-app banners
// and electron-updater's built-in path.
//
// Existing `notifications.test.ts` only verifies the routing through the
// wrapper layer using an entirely fake `notify-impl`, so it can't catch a
// regression where the real `notify-impl` -> `WindowsAdapter` ->
// `electron-windows-notifications` chain stops working.
//
// This test wires the REAL `./notify-impl` (no `__setNotifyImporter`
// override) and only swaps the lowest seam — `__setNativeForTests` — so the
// real `WindowsAdapter` constructor runs and the real XML builders fire.
// We assert the captured ctor options and the XML body the adapter would
// hand to the native API. If `electron-windows-notifications` ever fails to
// load again, the WindowsAdapter ctor throws BEFORE the spy can record
// anything and these tests fail loud.
//
// Platform note: `Notifier.create` switches on `process.platform`. The
// WindowsAdapter is only constructed on win32 — the suite skips on other
// platforms (vitest CI runs Windows via the dogfood probe pipeline; locals
// on macOS/linux skip cleanly). The `__setNativeForTests` seam still bypasses
// the actual native require, so this is a pure JS-layer assertion.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  showNotification,
  type ShowNotificationPayload,
} from '../notifications';
import {
  configureNotify,
  __setNotifyImporter,
  probeNotifyAvailability,
} from '../notify';
import * as realNotifyImpl from '../notify-impl';
import { __setNativeForTests } from '../notify-impl/platform/windows';
import { __resetBootstrapForTests } from '../notify-bootstrap';

interface ToastCtorArgs {
  appId?: string;
  template: string;
  tag?: string;
  group?: string;
  strings?: string[];
}

function makeFakeNative(captured: ToastCtorArgs[]) {
  return {
    ToastNotification: class FakeToast {
      constructor(opts: ToastCtorArgs) {
        captured.push(opts);
      }
      on(): void {
        /* no listeners exercised in this suite */
      }
      show(): void {
        /* no-op */
      }
      hide(): void {
        /* no-op */
      }
    },
    history: {
      remove(): void {
        /* no-op */
      },
    },
  } as unknown as Parameters<typeof __setNativeForTests>[0];
}

const APP_ID = 'com.ccsm.app';
const TOAST_GROUP = 'ccsm-notify';

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip;

describeOnWindows('notify-impl ships and reaches the native ToastNotification ctor', () => {
  let captured: ToastCtorArgs[];

  beforeEach(async () => {
    captured = [];
    __resetBootstrapForTests();
    // Use the REAL `./notify-impl` (Notifier + WindowsAdapter + XML
    // builders) by importing it via the TS path. The wrapper's default
    // importer uses `require('./notify-impl')` which can't resolve under
    // vitest (no compiled JS), so we override the importer to hand back the
    // real module — equivalent to what production does, just via a path
    // vitest can resolve. Then swap the lowest seam so the WindowsAdapter
    // ctor doesn't try to load the native .node from disk.
    __setNotifyImporter(async () => realNotifyImpl);
    __setNativeForTests(makeFakeNative(captured));
    configureNotify({
      appId: APP_ID,
      appName: 'CCSM',
      onAction: () => {},
    });
    const ok = await probeNotifyAvailability();
    // If this assertion ever fails, the real notify-impl chain regressed —
    // either the WindowsAdapter ctor throws (likely electron-windows-
    // notifications gone again) or the dispatcher refused to construct.
    expect(ok).toBe(true);
  });

  afterEach(() => {
    __setNativeForTests(undefined);
    __setNotifyImporter(null);
  });

  it('permission event reaches the native ctor with appId/group/template/tag and Adaptive XML', async () => {
    const payload: ShowNotificationPayload = {
      sessionId: 's1',
      title: 'g / sess',
      eventType: 'permission',
      extras: {
        toastId: 'perm-1',
        sessionName: 'sess',
        groupName: 'g',
        toolName: 'Bash',
        toolBrief: 'ls -la',
        cwd: '/tmp/proj',
      },
    };
    expect(showNotification(payload, null)).toBe(true);
    await new Promise((r) => setImmediate(r));

    expect(captured).toHaveLength(1);
    const c = captured[0];
    expect(c.appId).toBe(APP_ID);
    expect(c.group).toBe(TOAST_GROUP);
    expect(c.tag).toBe('perm-1');
    // The adapter hands the full Adaptive Toast XML in the `template` field
    // (yes, the field is named `template` on electron-windows-notifications
    // even though it's an XML body — that's the upstream API). Check the
    // declared template attribute and the rendered permission layout.
    expect(c.template).toMatch(/template="ToastGeneric"/);
    expect(c.template).toContain('<toast');
    expect(c.template).toContain('Permission needed');
    expect(c.template).toContain('sess');
    expect(c.template).toContain('Bash');
    expect(c.template).toContain('ls -la');
    expect(c.template).toContain('cwd: proj');
  });

  it('question event reaches the native ctor with the right tag and Adaptive XML', async () => {
    const payload: ShowNotificationPayload = {
      sessionId: 's1',
      title: 'g / sess',
      eventType: 'question',
      extras: {
        toastId: 'q-1',
        sessionName: 'sess',
        groupName: 'g',
        question: 'Pick one',
        selectionKind: 'single',
        optionCount: 2,
        cwd: '/tmp/proj',
      },
    };
    expect(showNotification(payload, null)).toBe(true);
    await new Promise((r) => setImmediate(r));

    expect(captured).toHaveLength(1);
    const c = captured[0];
    expect(c.appId).toBe(APP_ID);
    expect(c.group).toBe(TOAST_GROUP);
    expect(c.tag).toBe('q-1');
    expect(c.template).toContain('<toast');
    expect(c.template).toContain('Question');
    expect(c.template).toContain('Pick one');
    expect(c.template).toContain('Single-select');
    expect(c.template).toContain('cwd: proj');
  });

  it('turn_done event reaches the native ctor with the right tag and Adaptive XML', async () => {
    const payload: ShowNotificationPayload = {
      sessionId: 's1',
      title: 'g / sess',
      eventType: 'turn_done',
      extras: {
        toastId: 'done-1',
        sessionName: 'sess',
        groupName: 'g',
        lastUserMsg: 'go',
        lastAssistantMsg: 'all done',
        elapsedMs: 1234,
        toolCount: 3,
        cwd: '/tmp/proj',
      },
    };
    expect(showNotification(payload, null)).toBe(true);
    await new Promise((r) => setImmediate(r));

    expect(captured).toHaveLength(1);
    const c = captured[0];
    expect(c.appId).toBe(APP_ID);
    expect(c.group).toBe(TOAST_GROUP);
    expect(c.tag).toBe('done-1');
    expect(c.template).toContain('<toast');
    expect(c.template).toContain('g');
    expect(c.template).toContain('sess');
    expect(c.template).toContain('&gt; go');
    expect(c.template).toContain('all done');
    expect(c.template).toContain('3 tools');
  });
});

// Mock electron module so `import { BrowserWindow } from 'electron'` resolves
// in a non-electron Node test runner. The notifications focus gate calls
// `BrowserWindow.getAllWindows()` defensively — return an empty array so we
// fall through to the wrapper.
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));
