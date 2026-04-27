// Unit tests for the inlined-notify lazy-load wrapper (`electron/notify.ts`).
// Renamed from notify-fallback.test.ts in W5 — the file never tested the
// removed Electron Notification cross-platform fallback; it tests the
// optional native notify wrapper. Two branches are covered:
//   1. The inlined notify implementation fails to load (e.g. install was
//      skipped because the electron-windows-notifications native deps
//      couldn't build) — every wrapper function must resolve to undefined
//      without throwing, and isNotifyAvailable() must report false.
//   2. Module loads and exposes a Notifier — wrappers must delegate to the
//      created notifier.
//
// We use the `__setNotifyImporter` test seam so we don't have to manipulate
// real ESM resolution.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Re-import the wrapper in each test via vi.resetModules so internal load
// state (sticky load failure, cached notifier) starts clean.
async function freshWrapper(): Promise<typeof import('../electron/notify')> {
  vi.resetModules();
  return await import('../electron/notify');
}

describe('electron/notify wrapper (inlined-notify lazy loader)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('when the notify implementation is unavailable (optional native dep missing)', () => {
    it('does not throw, returns resolved promises, isNotifyAvailable=false', async () => {
      const wrapper = await freshWrapper();
      // Simulate dynamic import failure (e.g. ERR_MODULE_NOT_FOUND).
      const importErr = new Error("Cannot find module 'electron-windows-notifications'");
      wrapper.__setNotifyImporter(() => Promise.reject(importErr));

      // Suppress the "native notification module unavailable" warning the wrapper logs.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Even without a configured notifier, all emits must complete cleanly.
      wrapper.configureNotify({
        appId: 'test.appId',
        appName: 'Test',
        onAction: () => {},
      });

      await expect(
        wrapper.notifyPermission({
          toastId: 't1',
          sessionName: 'sess',
          toolName: 'Bash',
          toolBrief: 'ls',
          cwdBasename: 'proj',
        }),
      ).resolves.toBeUndefined();

      await expect(
        wrapper.notifyQuestion({
          toastId: 't2',
          sessionName: 'sess',
          question: 'why?',
          selectionKind: 'single',
          optionCount: 2,
          cwdBasename: 'proj',
        }),
      ).resolves.toBeUndefined();

      await expect(
        wrapper.notifyDone({
          toastId: 't3',
          groupName: 'g',
          sessionName: 'sess',
          lastUserMsg: 'u',
          lastAssistantMsg: 'a',
          elapsedMs: 100,
          toolCount: 1,
          cwdBasename: 'proj',
        }),
      ).resolves.toBeUndefined();

      await expect(wrapper.notifyDismiss('t1')).resolves.toBeUndefined();
      await expect(wrapper.disposeNotify()).resolves.toBeUndefined();

      expect(wrapper.isNotifyAvailable()).toBe(false);
      expect(await wrapper.probeNotifyAvailability()).toBe(false);
      expect(wrapper.notifyLastError()).toContain("Cannot find module 'electron-windows-notifications'");
      expect(warnSpy).toHaveBeenCalled();
      const warnText = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warnText).toContain('native notification module unavailable, falling back to in-app only');
    });

    it('does not retry the import after the first failure', async () => {
      const wrapper = await freshWrapper();
      let imports = 0;
      wrapper.__setNotifyImporter(() => {
        imports += 1;
        return Promise.reject(new Error('boom'));
      });
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      await wrapper.probeNotifyAvailability();
      await wrapper.probeNotifyAvailability();
      await wrapper.notifyPermission({
        toastId: 't',
        sessionName: 's',
        toolName: 'Bash',
        toolBrief: 'b',
        cwdBasename: 'c',
      });

      expect(imports).toBe(1);
    });
  });

  describe('when the notify implementation loads successfully', () => {
    it('delegates wrapper calls to the created notifier', async () => {
      const wrapper = await freshWrapper();

      const calls: { method: string; payload: unknown }[] = [];
      const fakeNotifier = {
        permission: (p: unknown) => calls.push({ method: 'permission', payload: p }),
        question: (p: unknown) => calls.push({ method: 'question', payload: p }),
        done: (p: unknown) => calls.push({ method: 'done', payload: p }),
        dismiss: (id: string) => calls.push({ method: 'dismiss', payload: id }),
        dispose: () => calls.push({ method: 'dispose', payload: null }),
      };
      let createOpts: unknown = null;
      const fakeModule = {
        Notifier: {
          create: async (opts: unknown) => {
            createOpts = opts;
            return fakeNotifier;
          },
        },
      };
      wrapper.__setNotifyImporter(() => Promise.resolve(fakeModule));

      const onAction = () => {};
      wrapper.configureNotify({ appId: 'x', appName: 'X', onAction });

      const permPayload = {
        toastId: 't1',
        sessionName: 's',
        toolName: 'Bash',
        toolBrief: 'b',
        cwdBasename: 'c',
      };
      await wrapper.notifyPermission(permPayload);

      const qPayload = {
        toastId: 't2',
        sessionName: 's',
        question: 'q',
        selectionKind: 'single' as const,
        optionCount: 2,
        cwdBasename: 'c',
      };
      await wrapper.notifyQuestion(qPayload);

      const dPayload = {
        toastId: 't3',
        groupName: 'g',
        sessionName: 's',
        lastUserMsg: 'u',
        lastAssistantMsg: 'a',
        elapsedMs: 50,
        toolCount: 1,
        cwdBasename: 'c',
      };
      await wrapper.notifyDone(dPayload);

      await wrapper.notifyDismiss('t1');
      await wrapper.disposeNotify();

      expect(createOpts).toEqual({ appId: 'x', appName: 'X', onAction });
      expect(calls).toEqual([
        { method: 'permission', payload: permPayload },
        { method: 'question', payload: qPayload },
        { method: 'done', payload: dPayload },
        { method: 'dismiss', payload: 't1' },
        { method: 'dispose', payload: null },
      ]);
      expect(wrapper.isNotifyAvailable()).toBe(true);
      expect(await wrapper.probeNotifyAvailability()).toBe(true);
      expect(wrapper.notifyLastError()).toBeNull();
    });

    it('falls back to no-op when Notifier.create throws (e.g. unsupported platform)', async () => {
      const wrapper = await freshWrapper();
      const fakeModule = {
        Notifier: {
          create: async () => {
            throw new Error('platform "linux" is not supported');
          },
        },
      };
      wrapper.__setNotifyImporter(() => Promise.resolve(fakeModule));
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      wrapper.configureNotify({ appId: 'x', appName: 'X', onAction: () => {} });

      await expect(
        wrapper.notifyPermission({
          toastId: 't',
          sessionName: 's',
          toolName: 'Bash',
          toolBrief: 'b',
          cwdBasename: 'c',
        }),
      ).resolves.toBeUndefined();

      expect(wrapper.isNotifyAvailable()).toBe(false);
      expect(wrapper.notifyLastError()).toContain('platform');
    });
  });
});
